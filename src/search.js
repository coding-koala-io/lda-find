import {HttpError, keys, object, unsupported} from './errors.js';
import {fieldValues, project} from './fields.js';
import {compile, highlightTerms} from './query.js';
import {compare, compareSort, isNumeric, numericSort} from './precise-json.js';

export const shards = () => ({total: 1, successful: 1, failed: 0});
const nonnegative = (value, name, maximum = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new HttpError(400, `${name} must be an integer between 0 and ${maximum}`);
  return value;
};
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const glob = (path, pattern) => new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`).test(path);

function partialSource(source, definition) {
  const absent = Symbol('absent');
  const matchesAncestor = (path, patterns) => {
    const parts = path.split('.');
    return parts.some((_, index) => patterns.some(pattern => glob(parts.slice(0, index + 1).join('.'), pattern)));
  };
  function visit(value, path) {
    if (path && matchesAncestor(path, definition.exclude ?? [])) return absent;
    const selected = path && matchesAncestor(path, definition.include ?? ['*']);
    if (!value || typeof value !== 'object') return selected ? structuredClone(value) : absent;
    if (Array.isArray(value)) {
      if (!value.length) return selected ? [] : absent;
      const children = value.map(item => visit(item, path));
      return children.every(item => item === absent) ? selected ? [] : absent : children.map(item => item === absent ? {} : item);
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      const child = visit(item, path ? `${path}.${key}` : key);
      if (child !== absent) Object.defineProperty(result, key, {value: child, enumerable: true, writable: true, configurable: true});
    }
    return Object.keys(result).length || selected ? result : absent;
  }
  const selected = visit(source, '');
  return selected === absent ? {} : selected;
}

function facetsFor(definitions = {}, now) {
  object(definitions, 'Facets');
  return Object.entries(definitions).map(([name, definition]) => {
    keys(definition, ['terms', 'filter', 'facet_filter'], 'facet');
    const filter = compile(definition.facet_filter, {now});
    if (definition.terms && definition.filter) throw new HttpError(400, 'Facet must have one family');
    if (definition.filter) {
      const predicate = compile(definition.filter, {now});
      return [name, docs => ({_type: 'filter', count: docs.filter(doc => filter(doc) !== null && predicate(doc) !== null).length})];
    }
    if (!definition.terms) unsupported('facet family');
    const options = definition.terms;
    keys(options, ['field', 'fields', 'size', 'all_terms'], 'terms facet');
    if (options.all_terms) unsupported('all_terms facet');
    const fields = options.fields ?? [options.field];
    if (!Array.isArray(fields) || !fields.length || fields.some(field => typeof field !== 'string')) throw new HttpError(400, 'Terms facet requires fields');
    const size = nonnegative(options.size ?? 10, 'Facet size', 1000);
    return [name, docs => {
      const counts = new Map(); let missing = 0;
      for (const doc of docs.filter(doc => filter(doc) !== null)) {
        const terms = new Set(fields.flatMap(field => fieldValues(doc, field)));
        if (!terms.size) missing++;
        for (const term of terms) {
          if (!['string', 'number', 'bigint', 'boolean'].includes(typeof term)) throw new HttpError(400, 'Facet terms must be scalar values');
          counts.set(term, (counts.get(term) ?? 0) + 1);
        }
      }
      return {_type: 'terms', missing, terms: [...counts].map(([term, count]) => ({term, count})).sort((a, b) => b.count - a.count || compare(String(a.term), String(b.term))).slice(0, size)};
    }];
  });
}

function sorter(sort = []) {
  if (!Array.isArray(sort)) throw new HttpError(400, 'Sort must be an array');
  const rules = sort.map(rule => {
    object(rule, 'Sort');
    const entries = Object.entries(rule);
    if (entries.length !== 1) throw new HttpError(400, 'Sort entry requires one field');
    const [field, options] = entries[0];
    if (field.startsWith('_') && !['_score', '_doc'].includes(field)) unsupported(`sort: ${field}`);
    keys(options, ['order', 'missing', 'unmapped_type', 'ignore_unmapped', 'mode'], 'sort');
    const order = options.order ?? (field === '_score' ? 'desc' : 'asc');
    if (!['asc', 'desc'].includes(order)) throw new HttpError(400, 'Sort order must be asc or desc');
    if (options.missing && !['_first', '_last'].includes(options.missing)) unsupported('sort missing value');
    const mode = options.mode ?? (order === 'asc' ? 'min' : 'max');
    if (!['min', 'max', 'sum', 'avg'].includes(mode)) unsupported('sort mode');
    return {field, order, missing: options.missing ?? '_last', mode};
  });
  if (!rules.length) rules.push({field: '_score', order: 'desc'});
  function value(hit, rule) {
    if (rule.field === '_score') return hit.score;
    if (rule.field === '_doc') return hit.position;
    const values = fieldValues(hit.doc, rule.field);
    if (!values.length) return null;
    if (rule.mode === 'sum' || rule.mode === 'avg') {
      if (values.some(item => !isNumeric(item))) throw new HttpError(400, 'Numeric sort mode requires numbers');
      return numericSort(values, rule.mode === 'avg');
    }
    return values.reduce((a, b) => (rule.mode === 'min' ? compare(a, b) <= 0 : compare(a, b) >= 0) ? a : b);
  }
  return (a, b) => {
    for (const rule of rules) {
      const av = value(a, rule); const bv = value(b, rule);
      if (av === null && bv === null) continue;
      if (av === null) return rule.missing === '_first' ? -1 : 1;
      if (bv === null) return rule.missing === '_first' ? 1 : -1;
      const result = compareSort(av, bv) * (rule.order === 'desc' ? -1 : 1);
      if (result) return result;
    }
    return a.position - b.position;
  };
}

function projection(body) {
  if (body.fields !== undefined && (!Array.isArray(body.fields) || body.fields.some(field => typeof field !== 'string'))) throw new HttpError(400, 'Fields must be a string array');
  if (body.partial_fields !== undefined) {
    object(body.partial_fields, 'Partial fields');
    for (const definition of Object.values(body.partial_fields)) {
      keys(definition, ['include', 'exclude'], 'partial fields');
      for (const value of [definition.include, definition.exclude]) if (value !== undefined && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) throw new HttpError(400, 'Partial field patterns must be string arrays');
    }
  }
  return doc => {
    if (body.fields !== undefined || body.partial_fields !== undefined) {
      const fields = project(doc, body.fields ?? []);
      for (const definition of Object.values(body.partial_fields ?? {})) {
        const merge = (target, selected) => {
          for (const [key, value] of Object.entries(selected)) {
            if (value && typeof value === 'object') {
              if (!Object.hasOwn(target, key) || !target[key] || typeof target[key] !== 'object' || Array.isArray(target[key]) !== Array.isArray(value)) Object.defineProperty(target, key, {value: Array.isArray(value) ? [] : {}, enumerable: true, writable: true, configurable: true});
              merge(target[key], value);
            } else Object.defineProperty(target, key, {value: structuredClone(value), enumerable: true, writable: true, configurable: true});
          }
        };
        merge(fields, partialSource(doc.source, definition));
      }
      return {fields};
    }
    return {_source: doc.source};
  };
}

function highlighter(options, query) {
  if (options === undefined) return () => ({});
  const allowed = ['fragment_size', 'number_of_fragments', 'pre_tags', 'post_tags', 'order'];
  keys(options, ['fields', ...allowed], 'highlight'); object(options.fields, 'Highlight fields');
  const terms = [...new Set(highlightTerms(query))].sort((a, b) => b.length - a.length);
  const pattern = terms.length ? new RegExp(terms.map(escapeRegex).join('|'), 'giu') : null;
  const fields = Object.entries(options.fields).map(([field, local]) => {
    keys(local, allowed, 'highlight field');
    const settings = {...options, ...local};
    for (const key of ['pre_tags', 'post_tags']) if (settings[key] !== undefined && (!Array.isArray(settings[key]) || settings[key].some(value => typeof value !== 'string') || !settings[key].length)) throw new HttpError(400, 'Highlight tags must be nonempty string arrays');
    nonnegative(settings.fragment_size ?? 100, 'Fragment size');
    nonnegative(settings.number_of_fragments ?? 0, 'Fragment count');
    if (settings.order !== undefined && settings.order !== 'score') unsupported('highlight order');
    return {field, settings};
  });
  return doc => {
    const highlight = {};
    for (const {field, settings} of fields) {
      const fragments = [];
      // Read original text for analyzer views; keep the requested field key in the reply.
      const base = field.replace(/(\$\$(?:string|strings))\.[^.]+$/, '$1');
      for (const raw of fieldValues(doc, base)) {
        if (typeof raw !== 'string' || !pattern) continue;
        pattern.lastIndex = 0; const match = pattern.exec(raw);
        if (!match) continue;
        const size = settings.fragment_size ?? 100;
        const text = (settings.number_of_fragments ?? 0) === 0 ? raw : raw.slice(Math.max(0, match.index - Math.floor(size / 2)), Math.max(0, match.index - Math.floor(size / 2)) + size);
        pattern.lastIndex = 0;
        fragments.push(text.replace(pattern, value => `${settings.pre_tags?.[0] ?? '|pre|'}${value}${settings.post_tags?.[0] ?? '|post|'}`));
      }
      if (fragments.length) Object.defineProperty(highlight, field, {value: fragments.slice(0, settings.number_of_fragments || fragments.length), enumerable: true});
    }
    return {highlight};
  };
}

export function search(store, body, {indices, types, searchType, now = Date.now()} = {}) {
  const started = performance.now();
  keys(body, ['query', 'filter', 'from', 'size', 'min_score', 'sort', 'facets', 'fields', 'partial_fields', 'highlight'], 'search');
  if (searchType && !['query_and_fetch', 'query_then_fetch', 'dfs_query_and_fetch', 'dfs_query_then_fetch', 'count'].includes(searchType)) unsupported('search type');
  const query = compile(body.query, {now}); const filter = compile(body.filter, {now});
  const from = nonnegative(body.from ?? 0, 'From'); const size = nonnegative(body.size ?? 10, 'Size', 1000);
  if (body.min_score !== undefined && (typeof body.min_score !== 'number' || !Number.isFinite(body.min_score))) throw new HttpError(400, 'Minimum score must be finite');
  const compareHits = sorter(body.sort); const facets = facetsFor(body.facets, now);
  const select = projection(body); const highlight = highlighter(body.highlight, body.query);
  const candidates = store.select(indices, types).map((doc, position) => ({doc, position, score: query(doc)})).filter(hit => hit.score !== null && (body.min_score === undefined || hit.score >= body.min_score));
  const hits = candidates.filter(hit => filter(hit.doc) !== null);
  const results = searchType === 'count' ? [] : hits.sort(compareHits).slice(from, from + size).map(({doc, score}) => ({_index: doc.index, _type: doc.type, _id: doc.id, _score: score, ...select(doc), ...highlight(doc)}));
  return {took: Math.max(0, Math.round(performance.now() - started)), timed_out: false, _shards: shards(), hits: {total: hits.length, hits: results}, ...(body.facets !== undefined ? {facets: Object.fromEntries(facets.map(([name, calculate]) => [name, calculate(candidates.map(hit => hit.doc))]))} : {})};
}
