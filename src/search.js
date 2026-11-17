import {HttpError, keys, object, unsupported} from './errors.js';
import {fieldValues, project} from './fields.js';
import {compile, highlightTerms} from './query.js';
import {wildcard} from './wildcard.js';
import {ResponseBudget} from './response-budget.js';
import {compare, compareSort, copyNumericToken, decimal, isNumeric, numericSort, numericTokenAt} from './precise-json.js';

export const shards = () => ({total: 1, successful: 1, failed: 0});
const nonnegative = (value, name, maximum = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new HttpError(400, `${name} must be an integer between 0 and ${maximum}`);
  return value;
};
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function partialSource(source, definition) {
  const absent = Symbol('absent');
  const matchesAncestor = (path, patterns) => {
    const parts = path.split('.');
    return parts.some((_, index) => patterns.some(pattern => pattern(parts.slice(0, index + 1).join('.'))));
  };
  function visit(value, path) {
    if (path && matchesAncestor(path, definition.exclude ?? [])) return absent;
    const selected = path && matchesAncestor(path, definition.include ?? ['*']);
    if (!value || typeof value !== 'object') return selected ? structuredClone(value) : absent;
    if (Array.isArray(value)) {
      if (!value.length) return selected ? [] : absent;
      const children = value.map(item => visit(item, path));
      if (children.every(item => item === absent)) return selected ? [] : absent;
      const result = children.map(item => item === absent ? {} : item);
      for (let i = 0; i < result.length; i++) if (children[i] !== absent) copyNumericToken(value, i, result);
      return result;
    }
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      const child = visit(item, path ? `${path}.${key}` : key);
      if (child !== absent) {
        Object.defineProperty(result, key, {value: child, enumerable: true, writable: true, configurable: true});
        copyNumericToken(value, key, result);
      }
    }
    return Object.keys(result).length || selected ? result : absent;
  }
  const selected = visit(source, '');
  return selected === absent ? {} : selected;
}

function facetsFor(definitions = {}, now, budget) {
  object(definitions, 'Facets');
  return Object.entries(definitions).map(([name, definition]) => {
    keys(definition, ['terms', 'filter', 'facet_filter'], 'facet');
    const filter = compile(definition.facet_filter, {now, budget});
    if (definition.terms && definition.filter) throw new HttpError(400, 'Facet must have one family');
    if (definition.filter) {
      const predicate = compile(definition.filter, {now, budget});
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
      const counts = new Map(); const doubleTerms = new Set(); let missing = 0;
      const scope = docs.filter(doc => filter(doc) !== null);
      for (const doc of scope) {
        const terms = new Set(fields.flatMap(field => {
          const values = fieldValues(doc, field);
          for (let i = 0; i < values.length; i++) if (numericTokenAt(values, i) !== undefined) doubleTerms.add(values[i]);
          return values;
        }));
        if (!terms.size) missing++;
        for (const term of terms) {
          if (!['string', 'number', 'bigint', 'boolean'].includes(typeof term)) throw new HttpError(400, 'Facet terms must be scalar values');
          counts.set(term, (counts.get(term) ?? 0) + 1);
        }
      }
      const terms = [...counts].map(([term, count]) => ({term, count})).sort((a, b) => b.count - a.count || compare(String(a.term), String(b.term))).slice(0, size);
      const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
      const other = total - terms.reduce((sum, {count}) => sum + count, 0);
      return {_type: 'terms', missing, total, other, terms: terms.map(({term, count}) => ({term: doubleTerms.has(term) ? decimal(term) : term, count}))};
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

function projection(body, budget) {
  if (body.fields !== undefined && (!Array.isArray(body.fields) || body.fields.some(field => typeof field !== 'string'))) throw new HttpError(400, 'Fields must be a string array');
  if (body.partial_fields !== undefined) {
    object(body.partial_fields, 'Partial fields');
    for (const definition of Object.values(body.partial_fields)) {
      keys(definition, ['include', 'exclude'], 'partial fields');
      for (const value of [definition.include, definition.exclude]) if (value !== undefined && typeof value !== 'string' && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) throw new HttpError(400, 'Partial field patterns must be text or string arrays');
    }
  }
  const cropped = [];
  if (body.script_fields !== undefined) {
    object(body.script_fields, 'Script fields');
    for (const [name, definition] of Object.entries(body.script_fields)) {
      keys(definition, ['script', 'lang', 'params'], 'script field');
      if (definition.script !== 'ascropped' || definition.lang !== 'native') unsupported('script field');
      keys(definition.params, ['field', 'length'], 'crop parameters');
      if (typeof definition.params.field !== 'string' || !definition.params.field) throw new HttpError(400, 'Crop requires a field');
      nonnegative(definition.params.length, 'Crop length');
      cropped.push({name, field: definition.params.field, length: definition.params.length});
    }
  }
  const partials = Object.entries(body.partial_fields ?? {}).map(([name, definition]) => {
    const patterns = (value, fallback) => (value === undefined ? fallback : typeof value === 'string' ? [value] : value).map(pattern => wildcard(pattern));
    return [name, {include: patterns(definition.include, ['*']), exclude: patterns(definition.exclude, [])}];
  });
  return doc => {
    if (body.fields !== undefined || body.partial_fields !== undefined || body.script_fields !== undefined) {
      budget.member('fields', {});
      const fields = project(doc, body.fields ?? [], (name, value, holder) => budget.member(name, value, holder));
      for (const [name, definition] of partials) {
        const value = partialSource(doc.source, definition);
        budget.member(name, value);
        Object.defineProperty(fields, name, {value, enumerable: true, writable: true, configurable: true});
      }
      for (const {name, field, length} of cropped) {
        // Local approximation of the hosted native crop: clip original text.
        const text = fieldValues(doc, field).filter(value => typeof value === 'string').join(' ');
        const value = text.slice(0, length);
        budget.member(name, value);
        Object.defineProperty(fields, name, {value, enumerable: true, writable: true, configurable: true});
      }
      return {fields};
    }
    budget.member('_source', doc.source);
    return {_source: doc.source};
  };
}

function highlighter(options, query, budget) {
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
    budget.member('highlight', {});
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
        if (settings.number_of_fragments && fragments.length >= settings.number_of_fragments) break;
        // Charge escaped string pieces before replacement can amplify long tags.
        let previous = 0;
        budget.bytes(3); // string quotes plus array separator
        const fragment = text.replace(pattern, (value, offset) => {
          for (const piece of [text.slice(previous, offset), settings.pre_tags?.[0] ?? '|pre|', value, settings.post_tags?.[0] ?? '|post|']) budget.bytes(Buffer.byteLength(JSON.stringify(piece)) - 2);
          previous = offset + value.length;
          return `${settings.pre_tags?.[0] ?? '|pre|'}${value}${settings.post_tags?.[0] ?? '|post|'}`;
        });
        budget.bytes(Buffer.byteLength(JSON.stringify(text.slice(previous))) - 2);
        fragments.push(fragment);
      }
      if (fragments.length) {
        budget.member(field, []);
        Object.defineProperty(highlight, field, {value: fragments, enumerable: true});
      }
    }
    return {highlight};
  };
}

export function search(store, body, {indices, types, searchType, now = Date.now(), outputBudget = new ResponseBudget()} = {}) {
  const started = performance.now();
  keys(body, ['query', 'filter', 'from', 'size', 'min_score', 'sort', 'facets', 'fields', 'partial_fields', 'script_fields', 'highlight'], 'search');
  if (searchType && !['query_and_fetch', 'query_then_fetch', 'dfs_query_and_fetch', 'dfs_query_then_fetch', 'count'].includes(searchType)) unsupported('search type');
  const budget = {terms: 0};
  const query = compile(body.query, {now, budget}); const filter = compile(body.filter, {now, budget});
  const from = nonnegative(body.from ?? 0, 'From'); const size = nonnegative(body.size ?? 10, 'Size', 1000);
  if (body.min_score !== undefined && (typeof body.min_score !== 'number' || !Number.isFinite(body.min_score))) throw new HttpError(400, 'Minimum score must be finite');
  const compareHits = sorter(body.sort); const facets = facetsFor(body.facets, now, budget);
  const select = projection(body, outputBudget); const highlight = highlighter(body.highlight, body.query, outputBudget);
  const candidates = store.select(indices, types).map((doc, position) => ({doc, position, score: query(doc)})).filter(hit => hit.score !== null && (body.min_score === undefined || hit.score >= body.min_score));
  const hits = candidates.filter(hit => filter(hit.doc) !== null);
  const maxScore = searchType === 'count' ? null : hits.reduce((maximum, hit) => maximum === null || hit.score > maximum ? hit.score : maximum, null);
  const response = {took: 0, timed_out: false, _shards: shards(), hits: {total: hits.length, max_score: decimal(maxScore), hits: []}, ...(body.facets !== undefined ? {facets: {}} : {})};
  // Reserve the envelope and enough digits for any safe millisecond duration.
  outputBudget.add({...response, took: Number.MAX_SAFE_INTEGER});
  if (searchType !== 'count') for (const {doc, score} of hits.sort(compareHits).slice(from, from + size)) {
    const hit = {_index: doc.index, _type: doc.type, _id: doc.id, _score: decimal(score)};
    outputBudget.add(hit); outputBudget.bytes(1);
    Object.assign(hit, select(doc), highlight(doc));
    response.hits.hits.push(hit);
  }
  for (const [name, calculate] of facets) {
    const value = calculate(candidates.map(hit => hit.doc));
    outputBudget.member(name, value);
    Object.defineProperty(response.facets, name, {value, enumerable: true});
  }
  response.took = Math.max(0, Math.round(performance.now() - started));
  return response;
}
