import {HttpError, keys, object, unsupported} from './errors.js';
import {search, shards} from './search.js';
import {compile} from './query.js';
import {project} from './fields.js';
import {parse} from './precise-json.js';
import {queryWriteOptions, bulkWriteOptions} from './write-options.js';

export function selection(value) {
  if (value === undefined || value === '' || value === '_all') return undefined;
  const values = value.split(',');
  if (values.some(item => !item || item.includes('*'))) throw new HttpError(400, 'Selection requires concrete names or _all');
  return values;
}

export function json(text, fallback) {
  if (!text.trim()) {
    if (fallback !== undefined) return fallback;
    throw new HttpError(400, 'A JSON body is required');
  }
  try { return parse(text); } catch { throw new HttpError(400, 'Malformed JSON body'); }
}

function linePairs(text, label) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length || lines.some(line => !line.trim())) throw new HttpError(400, `${label} requires nonempty JSON records`);
  if (lines.length > 20000) throw new HttpError(413, 'Too many framed records');
  return lines.map(line => json(line));
}

function bulk(store, text) {
  const started = performance.now(); const lines = linePairs(text, 'Bulk'); const operations = [];
  for (let i = 0; i < lines.length; i++) {
    const entries = Object.entries(object(lines[i], 'Bulk action'));
    if (entries.length !== 1 || !['index', 'create', 'delete'].includes(entries[0][0])) throw new HttpError(400, 'Bulk action must be index, create or delete');
    const [action, metadata] = entries[0]; object(metadata, 'Bulk metadata');
    const source = action === 'delete' ? undefined : lines[++i];
    if (action !== 'delete' && source === undefined) throw new HttpError(400, 'Bulk document record is missing');
    operations.push({action, metadata, source});
  }
  const items = store.transaction(() => operations.map(({action, metadata, source}) => {
    try {
      const options = bulkWriteOptions(metadata, action);
      const result = action === 'delete' ? store.delete(metadata._index, metadata._type, metadata._id, options) : store.put(metadata._index, metadata._type, metadata._id, source, {...options, create: action === 'create'});
      return {[action]: result};
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return {[action]: {_index: metadata._index ?? null, _type: metadata._type ?? null, _id: metadata._id ?? null, ok: false, error: error.message, status: error.status}};
    }
  }));
  return {items, took: Math.max(0, Math.round(performance.now() - started))};
}

function getDocument(store, index, type, id, fields) {
  const doc = store.get(index, type, id);
  return {_index: index, _type: type, _id: id, _version: doc?.version ?? 0, exists: Boolean(doc), ...(doc ? fields ? {fields: project(doc, fields)} : {_source: doc.source} : {})};
}

/** Routes implement only the profile described in docs/compatibility.md. */
export function handleProtocol({store, method, segments, params, text, send}) {
  const route = segments.join('/');
  if (route === 'features' && method === 'GET') return send(200, {status: 'ok', features: []});
  if (route === '_bulk' && method === 'POST') {
    queryWriteOptions(params, 'bulk');
    return send(200, bulk(store, text));
  }
  if (route === '_msearch' && method === 'POST') {
    const lines = linePairs(text, 'Multi-search');
    if (lines.length % 2) throw new HttpError(400, 'Multi-search needs metadata/body pairs');
    const responses = [];
    for (let i = 0; i < lines.length; i += 2) {
      const metadata = lines[i]; keys(metadata, ['index', 'type', 'routing', 'search_type', 'preference'], 'multi-search metadata');
      for (const name of ['index', 'type', 'search_type']) if (metadata[name] !== undefined && typeof metadata[name] !== 'string') throw new HttpError(400, 'Multi-search selections must be text');
      responses.push(search(store, lines[i + 1], {indices: selection(metadata.index), types: selection(metadata.type), searchType: metadata.search_type}));
    }
    return send(200, {responses});
  }
  const [index, type, id, extra] = segments;
  if (segments.length === 4 && extra === '_update' && method === 'POST') {
    return send(501, {
      error: 'E06 field updates are not enabled in this Local Find profile. Reindex the complete document, or enable explicit field-update support.',
      status: '501',
    });
  }
  if (segments.length === 2 && type === '_config' && method === 'GET') {
    if (!selection(index) || index.includes(',')) throw new HttpError(400, 'Settings require one index');
    return send(200, {status: 'ok', item: {stats: false, admin: false, languages: ['en'], connectors: false, max_docs: null, version: '1.0'}}, {has_documents_limit: 'false', documents_used: String(store.select([index]).length)});
  }
  if (segments.length === 3 && type === 'specific-languages') {
    if (id === 'get' && method === 'GET') return send(200, store.settings(index).languages);
    if (id === 'clear' && method === 'DELETE') {
      store.transaction(() => { store.ensureIndex(index).languages = []; });
      return send(200, true);
    }
  }
  if (segments.length === 3 && type === '_refresh' && ['on', 'off'].includes(id) && method === 'POST') {
    store.transaction(() => { store.ensureIndex(index).refresh = id === 'on'; });
    return send(200, {ok: true});
  }
  if (segments.length === 2 && type === '_mget' && method === 'POST') {
    const body = json(text); keys(body, ['docs'], 'multi-get');
    if (!Array.isArray(body.docs)) throw new HttpError(400, 'Multi-get requires docs');
    return send(200, {docs: body.docs.map(doc => {
      keys(doc, ['_index', '_type', '_id', 'language_routing'], 'multi-get document');
      store.validateIdentity(doc._index ?? index, doc._type, doc._id);
      return getDocument(store, doc._index ?? index, doc._type, doc._id);
    })});
  }
  if (segments.length <= 3 && ['_search', '_count', '_query'].includes(segments.at(-1))) {
    const operation = segments.at(-1);
    const indices = selection(segments.length >= 2 ? index : undefined);
    const types = selection(segments.length === 3 ? type : undefined);
    if (method === 'POST' && ['_search', '_count'].includes(operation)) {
      if (operation === '_count' && params.has('q') && params.get('q') !== '*') unsupported('count q expression');
      const body = json(text, {query: {match_all: {}}});
      const result = search(store, operation === '_count' ? {...object(body, 'Count body'), size: 0} : body, {indices, types, searchType: params.get('search_type') || undefined});
      return send(200, operation === '_count' ? {count: result.hits.total, _shards: result._shards} : result);
    }
    if (method === 'DELETE' && operation === '_query') {
      const predicate = compile(json(text));
      const targets = store.select(indices, types).filter(doc => predicate(doc) !== null);
      const names = store.indexNames(indices);
      store.transaction(() => { for (const doc of targets) store.delete(doc.index, doc.type, doc.id); });
      return send(200, {Ok: true, _indices: Object.fromEntries(names.map(name => [name, {_shards: shards()}]))});
    }
  }
  if (index?.startsWith('_') || type?.startsWith('_') || extra?.startsWith('_')) throw new HttpError(501, 'This operation is outside the local profile');
  if (segments.length === 2 && method === 'POST') {
    const options = queryWriteOptions(params, 'index');
    return send(201, store.transaction(() => store.put(index, type, undefined, json(text), options)));
  }
  if (segments.length === 3) {
    store.validateIdentity(index, type, id);
    if (method === 'PUT') {
      const options = queryWriteOptions(params, 'index'); const exists = store.get(index, type, id);
      const result = store.transaction(() => store.put(index, type, id, json(text), options));
      return send(exists ? 200 : 201, result);
    }
    if (method === 'GET') {
      const fields = params.has('fields') ? params.get('fields').split(',').filter(Boolean) : undefined;
      const result = getDocument(store, index, type, id, fields);
      return send(result.exists ? 200 : 404, result);
    }
    if (method === 'DELETE') {
      const options = queryWriteOptions(params, 'delete');
      const result = store.transaction(() => store.delete(index, type, id, options));
      return send(result.found ? 200 : 404, result);
    }
  }
  throw new HttpError(404, 'Route is not available');
}
