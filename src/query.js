import {HttpError, object, keys, unsupported} from './errors.js';
import {fieldValues, words} from './fields.js';
import {comparable, equal} from './precise-json.js';
import {wildcard} from './wildcard.js';

const list = value => value == null ? [] : Array.isArray(value) ? value : [value];
const matched = score => score !== null;
export const queryLimits = Object.freeze({depth: 40, terms: 1024, textBytes: 64 * 1024});
function consume(budget, count = 1) {
  budget.terms += count;
  if (budget.terms > queryLimits.terms) throw new HttpError(400, 'Query has too many terms');
}
const numeric = (value, label) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, `${label} must be a finite number`);
  return value;
};
const boostOf = options => options.boost === undefined ? 1 : numeric(options.boost, 'Boost');

export function dateValue(value, now) {
  if (typeof value !== 'string') return value;
  const relative = value.match(/^now(?:(\+|-)(\d+)([smhdw]))?(\/m)?$/);
  if (relative) {
    const units = {s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000};
    let time = now + (relative[1] === '-' ? -1 : 1) * Number(relative[2] ?? 0) * (units[relative[3]] ?? 1);
    if (relative[4]) time = Math.floor(time / 60000) * 60000;
    return time;
  }
  if (/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  return value;
}

function fieldEntries(options, allowed = []) {
  object(options, 'Field predicate');
  const entries = Object.entries(options).filter(([key]) => !allowed.includes(key));
  if (!entries.length) return [];
  return entries;
}

function tokenize(text) {
  if (Buffer.byteLength(text) > queryLimits.textBytes) throw new HttpError(400, 'Text expression is too large');
  const tokens = []; let token = ''; let quoted = false;
  function flush() { if (token) { tokens.push(token); token = ''; } }
  for (let i = 0; i < text.length; i++) {
    if (tokens.length > queryLimits.terms * 3 + queryLimits.depth * 2) throw new HttpError(400, 'Text expression has too many tokens');
    const char = text[i];
    if (char === '\\' && i + 1 < text.length) { token += char + text[++i]; continue; }
    if (char === '"') { quoted = !quoted; token += char; continue; }
    if (!quoted && /\s/.test(char)) { flush(); continue; }
    if (!quoted && (char === '(' || char === ')')) { flush(); tokens.push(char); continue; }
    token += char;
  }
  if (quoted) throw new HttpError(400, 'Unclosed text phrase');
  flush(); return tokens;
}

function textQuery(options, depth, budget) {
  keys(options, ['query', 'fields', 'default_field', 'analyzer', 'default_operator', 'boost', 'allow_leading_wildcard', 'lowercase_expanded_terms', 'enable_position_increments', 'analyze_wildcard', 'use_dis_max', 'tie_breaker', 'auto_generate_phrase_queries'], 'query_string');
  if (typeof options.query !== 'string') throw new HttpError(400, 'Text query must be a string');
  if (Buffer.byteLength(options.query) > queryLimits.textBytes) throw new HttpError(400, 'Text expression is too large');
  if (options.analyzer != null && (typeof options.analyzer !== 'string' || /synonym/i.test(options.analyzer))) unsupported('text analyzer');
  const operator = options.default_operator ?? 'OR';
  if (!['AND', 'OR'].includes(operator)) throw new HttpError(400, 'Text operator must be AND or OR');
  const fields = options.fields ?? [options.default_field ?? '_all'];
  if (!Array.isArray(fields) || !fields.length || fields.some(field => typeof field !== 'string')) throw new HttpError(400, 'Text fields must be a nonempty string array');
  const parseField = selection => {
    const parts = selection.split('^');
    const weight = parts.length === 1 ? 1 : Number(parts[1]);
    if (!parts[0] || parts.length > 2 || !Number.isFinite(weight) || parts.length === 2 && !parts[1]) throw new HttpError(400, 'Invalid field boost');
    return {field: parts[0], weight};
  };
  const parsedFields = fields.map(parseField);
  const tokens = tokenize(options.query.trim() || '*'); let position = 0;
  function atom(token) {
    consume(budget);
    if (!token || ['AND', 'OR', ')'].includes(token)) throw new HttpError(400, 'Invalid text expression');
    if (token === '*' || token === '*:*') return () => 1;
    if (/(?<!\\)[~^\[\]{}]/.test(token)) unsupported('text expression');
    const colon = token.search(/(?<!\\):/);
    const selected = colon < 0 ? parsedFields : [parseField(token.slice(0, colon))];
    let term = colon < 0 ? token : token.slice(colon + 1);
    const phrase = term.startsWith('"') && term.endsWith('"');
    if (phrase) term = term.slice(1, -1);
    const hasWildcard = /(?<!\\)[*?]/.test(term);
    if (hasWildcard && /^[*?]/.test(term) && !options.allow_leading_wildcard) unsupported('leading wildcard');
    const plain = term.replace(/\\(.)/g, '$1').toLowerCase();
    const needle = words(plain).join(' ');
    const pattern = hasWildcard ? wildcard(term, {escaped: true, lowercase: true}) : null;
    return doc => {
      let score = 0; let anyMatch = false;
      for (const {field, weight} of selected) {
        const textField = field.replace(/(\$\$(?:string|strings))\.(?!lowercase$|sort$)[^.]+$/, '$1');
        const values = fieldValues(doc, textField);
        const found = values.some(value => {
          const text = words(value);
          return pattern ? text.some(pattern) : phrase ? (` ${text.join(' ')} `).includes(` ${needle} `) : needle.length > 0 && text.includes(needle);
        });
        if (found) { score += weight; anyMatch = true; }
      }
      return anyMatch ? score : null;
    };
  }
  function primary(nesting = depth) {
    if (nesting > queryLimits.depth) throw new HttpError(400, 'Query nesting is too deep');
    const token = tokens[position++];
    if (token === 'NOT') { const child = primary(nesting + 1); return doc => matched(child(doc)) ? null : 1; }
    if (token === '(') {
      const expression = parseOr(nesting + 1);
      if (tokens[position++] !== ')') throw new HttpError(400, 'Unclosed text group');
      return expression;
    }
    return atom(token);
  }
  const combine = (left, right, and) => doc => {
    const a = left(doc); const b = right(doc);
    return and ? matched(a) && matched(b) ? a + b : null : matched(a) || matched(b) ? (a ?? 0) + (b ?? 0) : null;
  };
  function parseAnd(nesting) {
    let left = primary(nesting);
    while (position < tokens.length && tokens[position] !== ')' && tokens[position] !== 'OR') {
      if (tokens[position] === 'AND') { position++; left = combine(left, primary(nesting), true); }
      else if (tokens[position] === 'NOT') left = combine(left, primary(nesting), true);
      else if (operator === 'AND') left = combine(left, primary(nesting), true);
      else break;
    }
    return left;
  }
  function parseOr(nesting = depth) {
    let left = parseAnd(nesting);
    while (position < tokens.length && tokens[position] !== ')') {
      if (tokens[position] === 'OR') position++;
      left = combine(left, parseAnd(nesting), false);
    }
    return left;
  }
  const expression = parseOr();
  if (position !== tokens.length) throw new HttpError(400, 'Invalid text group');
  const boost = boostOf(options);
  return doc => { const score = expression(doc); return score === null ? null : score * boost; };
}

/** Compile before scanning so invalid/unsupported queries fail even on an empty index. */
export function compile(node = {match_all: {}}, {now = Date.now(), depth = 0, budget = {terms: 0}} = {}) {
  if (depth > queryLimits.depth) throw new HttpError(400, 'Query nesting is too deep');
  consume(budget);
  object(node, 'Query');
  const entries = Object.entries(node);
  if (!entries.length) return () => 1;
  if (entries.length !== 1) throw new HttpError(400, 'A query node must have one operator');
  const [kind, options] = entries[0];
  const child = value => compile(value, {now, depth: depth + 1, budget});
  if (kind === 'match_all') { keys(options, ['boost'], kind); const boost = boostOf(options); return () => boost; }
  if (kind === 'query_string') return textQuery(options, depth, budget);
  if (kind === 'field') {
    const fields = fieldEntries(options);
    if (fields.length !== 1) throw new HttpError(400, 'Field query requires one field');
    return textQuery({...fields[0][1], fields: [fields[0][0]]}, depth, budget);
  }
  if (kind === 'and' || kind === 'or') {
    if (!Array.isArray(options)) throw new HttpError(400, `${kind} requires an array`);
    const clauses = options.map(child);
    return doc => (kind === 'and' ? clauses.every(fn => matched(fn(doc))) : clauses.some(fn => matched(fn(doc)))) ? 1 : null;
  }
  if (kind === 'not') { keys(options, ['filter'], kind); const fn = child(options.filter); return doc => matched(fn(doc)) ? null : 1; }
  if (kind === 'bool') {
    keys(options, ['must', 'should', 'must_not', 'minimum_number_should_match', 'disable_coord', 'boost'], kind);
    const must = list(options.must).map(child); const should = list(options.should).map(child); const mustNot = list(options.must_not).map(child);
    const minimum = options.minimum_number_should_match ?? (should.length && !must.length ? 1 : 0);
    if (!Number.isInteger(minimum) || minimum < 0) throw new HttpError(400, 'Boolean minimum must be a nonnegative integer');
    const boost = boostOf(options);
    return doc => {
      if (mustNot.some(fn => matched(fn(doc)))) return null;
      const required = must.map(fn => fn(doc));
      if (required.some(score => score === null)) return null;
      const optional = should.map(fn => fn(doc)).filter(matched);
      return optional.length < minimum ? null : (required.reduce((a, b) => a + b, 0) + optional.reduce((a, b) => a + b, 0) || 1) * boost;
    };
  }
  if (kind === 'filtered' || kind === 'constant_score') {
    keys(options, ['query', 'filter', 'boost'], kind);
    const query = child(options.query); const filter = child(options.filter); const boost = boostOf(options);
    return doc => { const score = query(doc); return score === null || !matched(filter(doc)) ? null : kind === 'constant_score' ? boost : score * boost; };
  }
  if (kind === 'query') return child(options);
  if (kind === 'fquery') { keys(options, ['query', '_cache'], kind); return child(options.query); }
  if (kind === 'exists' || kind === 'missing') {
    keys(options, ['field'], kind);
    if (typeof options.field !== 'string') throw new HttpError(400, 'Existence requires a field');
    return doc => Boolean(fieldValues(doc, options.field).length) === (kind === 'exists') ? 1 : null;
  }
  if (kind === 'ids') {
    keys(options, ['values', 'type'], kind);
    if (!Array.isArray(options.values)) throw new HttpError(400, 'IDs require a values array');
    return doc => options.values.includes(doc.id) && (!options.type || list(options.type).includes(doc.type)) ? 1 : null;
  }
  if (['term', 'terms', 'prefix', 'wildcard', 'range'].includes(kind)) {
    const fields = fieldEntries(options, kind === 'terms' ? ['minimum_match'] : []);
    const tests = fields.map(([field, input]) => {
      consume(budget);
      if (kind === 'range') {
        keys(input, ['from', 'to', 'include_lower', 'include_upper', 'boost'], 'range');
        const from = input.from == null ? null : dateValue(input.from, now); const to = input.to == null ? null : dateValue(input.to, now);
        const boost = boostOf(input);
        return doc => fieldValues(doc, field).some(raw => {
          const value = dateValue(raw, now);
          return (from === null || comparable(value, from) && (input.include_lower === false ? value > from : value >= from)) && (to === null || comparable(value, to) && (input.include_upper === false ? value < to : value <= to));
        }) ? boost : null;
      }
      if (kind === 'terms') {
        if (!Array.isArray(input)) throw new HttpError(400, 'Terms require an array');
        consume(budget, input.length);
        const minimum = options.minimum_match ?? 1;
        if (!Number.isInteger(minimum) || minimum < 0) throw new HttpError(400, 'Terms minimum must be a nonnegative integer');
        return doc => new Set(fieldValues(doc, field).filter(value => input.some(term => equal(value, term)))).size >= minimum ? 1 : null;
      }
      let value = input; let boost = 1;
      if (input && typeof input === 'object') { keys(input, ['value', 'boost'], kind); value = input.value; boost = boostOf(input); }
      if (!['string', 'number', 'bigint', 'boolean'].includes(typeof value)) throw new HttpError(400, 'Term value must be a scalar');
      if (kind !== 'term' && typeof value !== 'string') throw new HttpError(400, 'Prefix/wildcard value must be text');
      const pattern = kind === 'wildcard' ? wildcard(value) : null;
      return doc => fieldValues(doc, field).some(actual => kind === 'term' ? equal(actual, value) : typeof actual === 'string' && (pattern ? pattern(actual) : actual.startsWith(value))) ? boost : null;
    });
    return doc => {
      const scores = tests.map(fn => fn(doc));
      return !scores.length || scores.some(score => score === null) ? null : scores.reduce((a, b) => a + b, 0);
    };
  }
  if (kind === 'nested') {
    keys(options, ['path', 'query', 'filter', 'score_mode', 'join'], kind);
    if (typeof options.path !== 'string' || !options.path) throw new HttpError(400, 'Nested query requires a path');
    const fn = child(options.query ?? options.filter);
    return doc => fieldValues(doc, options.path).some(value => {
      const wrap = options.path.split('.').reduceRight((inner, key) => ({[key]: inner}), value);
      return matched(fn({...doc, source: wrap}));
    }) ? 1 : null;
  }
  if (kind === 'dis_max') {
    keys(options, ['queries', 'tie_breaker', 'boost'], kind);
    if (!Array.isArray(options.queries)) throw new HttpError(400, 'Disjunction requires queries');
    const queries = options.queries.map(child); const boost = boostOf(options); const tie = options.tie_breaker ?? 0;
    numeric(tie, 'Tie breaker');
    return doc => { const scores = queries.map(fn => fn(doc)).filter(matched); const maximum = Math.max(...scores); return scores.length ? (maximum + tie * (scores.reduce((a, b) => a + b, 0) - maximum)) * boost : null; };
  }
  if (kind === 'custom_filters_score' || kind === 'function_score') {
    keys(options, kind === 'function_score' ? ['query', 'filter', 'functions', 'score_mode', 'boost_mode', 'max_boost', 'boost'] : ['query', 'filters', 'score_mode', 'boost'], kind);
    const query = child(options.query); const filter = child(options.filter);
    const functions = options.functions ?? options.filters;
    if (!Array.isArray(functions)) throw new HttpError(400, 'Scoring requires a function array');
    const fns = functions.map(item => {
      keys(item, ['filter', kind === 'function_score' ? 'boost_factor' : 'boost'], 'score function');
      return {filter: child(item.filter), boost: numeric(item.boost_factor ?? item.boost ?? 1, 'Score factor')};
    });
    const mode = options.score_mode ?? (kind === 'function_score' ? 'multiply' : 'first');
    const boostMode = options.boost_mode ?? 'multiply'; const boost = boostOf(options);
    if (!['multiply', 'sum', 'total', 'avg', 'first', 'max', 'min'].includes(mode) || !['multiply', 'replace', 'sum', 'avg', 'max', 'min'].includes(boostMode)) unsupported('score mode');
    const maxBoost = options.max_boost === undefined ? Infinity : numeric(options.max_boost, 'Maximum boost');
    const combine = values => mode === 'first' ? values[0] : mode === 'max' ? Math.max(...values) : mode === 'min' ? Math.min(...values) : mode === 'multiply' ? values.reduce((a, b) => a * b, 1) : values.reduce((a, b) => a + b, 0) / (mode === 'avg' ? values.length : 1);
    return doc => {
      const score = query(doc);
      if (score === null || !matched(filter(doc))) return null;
      const factors = fns.filter(fn => matched(fn.filter(doc))).map(fn => fn.boost);
      const factor = Math.min(maxBoost, factors.length ? combine(factors) : 1);
      return boost * (boostMode === 'replace' ? factor : boostMode === 'sum' ? score + factor : boostMode === 'avg' ? (score + factor) / 2 : boostMode === 'max' ? Math.max(score, factor) : boostMode === 'min' ? Math.min(score, factor) : score * factor);
    };
  }
  unsupported(`query operator: ${kind}`);
}

export function highlightTerms(query) {
  if (!query || typeof query !== 'object') return [];
  if (query.query_string) return words(query.query_string.query).filter(word => !['and', 'or', 'not'].includes(word));
  return Object.values(query).flatMap(value => Array.isArray(value) ? value.flatMap(highlightTerms) : highlightTerms(value));
}
