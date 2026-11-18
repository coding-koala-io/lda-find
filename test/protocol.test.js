import test from 'node:test';
import assert from 'node:assert/strict';
import {gateway, ndjson, ids, envelope, PREFIX} from './helpers.js';
import {page} from './fixtures.js';
import {createServer, configuration} from '../src/server.js';
import http from 'node:http';

test('E14/E15/E17: settings, truthful feature gates, languages and preserved service prefix', async t => {
  const {request, put} = await gateway(t);
  const settings = await request('/pages/_config');
  assert.equal(settings.status, 200);
  assert.deepEqual(settings.data, {status: 'ok', item: {stats: false, admin: false, languages: ['en'], connectors: false, max_docs: 10000, version: '1.0'}});
  assert.equal(settings.headers.get('has_documents_limit'), 'true');
  assert.equal(settings.headers.get('documents_used'), '0');
  assert.deepEqual((await request('/features')).data, {status: 'ok', features: []});
  assert.deepEqual((await request('/pages/specific-languages/get')).data, []);
  await put('one', page(1), {headers: {'language-routing': 'en'}});
  await request('/pages/Synthetic_ArticlePage/two?language_routing=en', {method: 'PUT', body: page(2)});
  assert.deepEqual((await request('/pages/specific-languages/get')).data, ['en']);
  assert.deepEqual((await request('/pages/specific-languages/clear', {method: 'DELETE'})).data, true);
  assert.deepEqual((await request('/pages/specific-languages/get')).data, []);
  assert.equal((await request('/pages/_config', {prefixed: false})).status, 403);
  assert.equal((await request('/tenant/wrong-key/pages/_config', {prefixed: false})).status, 403);
  assert.equal((await request(`${PREFIX}suffix/pages/_config`, {prefixed: false})).status, 403);
});

test('E01/E02/E03: encoded identities, replacement, source fidelity, projection and missing results', async t => {
  const {put, request} = await gateway(t);
  const id = 'Default_synthetic/å id_en'; const path = `/pages/Synthetic_ArticlePage/${encodeURIComponent(id)}`;
  const source = page(1, {'Attachment$$attachment': 'c3ludGhldGlj', 'Nested': {'Count$$long': 7}, 'Empty': [], 'Null': null});
  assert.equal((await put(id, source)).status, 201);
  let result = await request(path);
  assert.deepEqual(result.data, {_index: 'pages', _type: 'Synthetic_ArticlePage', _id: id, _version: 1, exists: true, _source: source});
  result = await request(`${path}?fields=ContentLink.ID$$long,Language.Name$$string,___types`);
  assert.deepEqual(result.data.fields, {'ContentLink.ID$$long': 1, 'Language.Name$$string': 'en', ___types: source.___types});
  const replacement = {'Title$$string': 'Replacement'};
  const write = await put(id, replacement);
  assert.equal(write.status, 200);
  assert.deepEqual(write.data, {ok: true, _index: 'pages', _type: 'Synthetic_ArticlePage', _id: id, _version: 2});
  assert.deepEqual((await request(path)).data._source, replacement);
  const deleted = await request(path, {method: 'DELETE'});
  assert.deepEqual(deleted.data, {ok: true, _index: 'pages', _type: 'Synthetic_ArticlePage', _id: id, found: true});
  result = await request(path);
  assert.equal(result.status, 404);
  assert.deepEqual(result.data, {_index: 'pages', _type: 'Synthetic_ArticlePage', _id: id, _version: 0, exists: false});
  result = await request(path, {method: 'DELETE'});
  assert.equal(result.status, 404); assert.equal(result.data.found, false);
});

test('E01: generated IDs and independent index/type/language identities', async t => {
  const {request, put, search} = await gateway(t);
  const generated = await request('/pages/Synthetic_Page/', {method: 'POST', body: page(1)});
  assert.equal(generated.status, 201); assert.ok(generated.data._id);
  await put('shared_en', page(2));
  await put('shared_sv', page(2));
  await put('shared_en', page(3), {type: 'Synthetic_LandingPage'});
  await put('shared_en', page(4), {index: 'other'});
  assert.equal((await search({}, '/_search')).hits.total, 5);
  assert.equal((await search({}, '/pages/Synthetic_ArticlePage/_search')).hits.total, 2);
  assert.equal((await search({}, '/pages,other/Synthetic_ArticlePage,Synthetic_LandingPage/_search')).hits.total, 4);
});

test('E04: mixed bulk actions preserve order, generated IDs and truthful per-item errors', async t => {
  const {request, search} = await gateway(t);
  const metadata = {_index: 'pages', _type: 'Synthetic_Page', _id: 'one'};
  const result = await request('/_bulk', {method: 'POST', body: ndjson(
    {index: metadata}, page(1),
    {index: metadata}, page(2),
    {create: metadata}, page(3),
    {delete: {...metadata, _id: 'absent'}},
    {index: {...metadata, _id: 'invalid'}}, ['invalid source'],
    {create: {_index: 'pages', _type: 'Synthetic_Page', language_routing: 'en'}}, page(4),
    {delete: metadata},
  )});
  assert.equal(result.status, 200); assert.equal(typeof result.data.took, 'number');
  assert.deepEqual(result.data.items.map(item => Object.keys(item)[0]), ['index', 'index', 'create', 'delete', 'index', 'create', 'delete']);
  assert.deepEqual(result.data.items[0].index, {ok: true, ...metadata, _version: 1});
  assert.equal(result.data.items[1].index._version, 2);
  assert.equal(result.data.items[2].create.ok, false); assert.equal(result.data.items[2].create.status, 409);
  assert.equal(typeof result.data.items[2].create.error, 'string');
  assert.equal(result.data.items[3].delete.found, false);
  assert.equal(result.data.items[4].index.ok, false);
  assert.equal(result.data.items[5].create.ok, true);
  assert.equal(result.data.items[6].delete.found, true);
  assert.equal((await search()).hits.total, 1);
});

test('E04: malformed framing fails before writes and a delete consumes no source line', async t => {
  const {request, search} = await gateway(t);
  for (const body of [ndjson({index: {_index: 'pages', _type: 'Synthetic_Page', _id: 'x'}}), '{bad}\n', '\n', ndjson({index: {_index: 'pages', _type: 'Synthetic_Page', _id: 'x'}}, page(1), {unknown: {}})]) {
    const result = await request('/_bulk', {method: 'POST', body});
    assert.equal(result.status, 400); assert.equal(typeof result.data.error, 'string');
    assert.equal((await search()).hits.total, 0);
  }
  const result = await request('/_bulk?refresh=wait_for', {method: 'POST', body: ndjson({delete: {_index: 'pages', _type: 'Synthetic_Page', _id: 'missing'}}, {index: {_index: 'pages', _type: 'Synthetic_Page', _id: 'kept'}}, page(1))});
  assert.equal(result.status, 200); assert.deepEqual(ids(await search()), ['kept']);
});

test('E07/E16: refresh accepts empty bodies; delta cleanup evaluates timestamp/site predicates', async t => {
  const {request, put, search} = await gateway(t);
  assert.equal((await request('/pages/_refresh/off', {method: 'POST'})).status, 200);
  await put('old', page(1, {'GetTimestamp$$date': '2026-01-01T00:00:00Z'}));
  await put('new', page(2));
  await put('foreign', page(3, {'SiteId$$string': 'other-site', 'GetTimestamp$$date': '2026-01-01T00:00:00Z'}));
  await put('other-index', page(4), {index: 'other'});
  assert.equal((await search()).hits.total, 3);
  assert.equal((await request('/pages/_refresh/on', {method: 'POST'})).status, 200);
  const result = await request('/pages/Synthetic_ArticlePage/_query?delta_indexing=true', {method: 'DELETE', body: {and: [{term: {'SiteId$$string': 'synthetic-site'}}, {range: {'GetTimestamp$$date': {to: '2026-11-01T00:00:00Z', include_upper: false}}}]}});
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, {Ok: true, _indices: {pages: {_shards: {total: 1, successful: 1, failed: 0}}}});
  assert.deepEqual(ids(await search()), ['new', 'foreign']);
  assert.equal((await search({}, '/other/_search')).hits.total, 1);
  await request('/_all/Synthetic_ArticlePage/_query', {method: 'DELETE', body: {ids: {values: ['foreign']}}});
  assert.deepEqual(ids(await search()), ['new']);
});

test('E08/E09: search and count envelopes, selections, no-hit and count search type', async t => {
  const {request, put, search} = await gateway(t);
  envelope(await search());
  await put('one', page(1)); await put('two', page(2));
  const body = {query: {term: {'Rank$$long': 2}}};
  const result = await search(body); envelope(result); assert.deepEqual(ids(result), ['two']);
  assert.deepEqual((await request('/pages/_count', {method: 'POST', body})).data, {count: 1, _shards: {total: 1, successful: 1, failed: 0}});
  assert.equal((await request('/pages/_count?q=*', {method: 'POST'})).data.count, 2);
  assert.deepEqual((await search({}, '/pages/_search?search_type=count')).hits, {total: 2, max_score: null, hits: []});
  assert.equal((await request('/_count', {method: 'POST', body})).data.count, 1);
  assert.equal((await request('/_all/Synthetic_ArticlePage/_count', {method: 'POST', body})).data.count, 1);
});

test('E10: multi-get retains document order, per-document index and missing shape', async t => {
  const {request, put} = await gateway(t); await put('one', page(1)); await put('two', page(2), {index: 'other'});
  const result = await request('/pages/_mget', {method: 'POST', body: {docs: [{_id: 'two', _type: 'Synthetic_ArticlePage', _index: 'other'}, {_id: 'missing', _type: 'Synthetic_ArticlePage'}, {_id: 'one', _type: 'Synthetic_ArticlePage'}]}});
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.docs.map(doc => [doc._id, doc._index, doc.exists]), [['two', 'other', true], ['missing', 'pages', false], ['one', 'pages', true]]);
  assert.deepEqual(result.data.docs[0]._source, page(2));
});

test('E11: multi-search JSON content type, LF/CRLF pairs, scope and component order', async t => {
  const {request, put} = await gateway(t); await put('one', page(1)); await put('two', page(2), {index: 'other'});
  const body = ndjson({index: 'other', type: 'Synthetic_ArticlePage'}, {query: {match_all: {}}}, {index: 'pages,other', search_type: 'count'}, {query: {match_all: {}}}, {}, {query: {term: {'Rank$$long': 99}}}).replaceAll('\n', '\r\n');
  const result = await request('/_msearch', {method: 'POST', body});
  assert.equal(result.status, 200); result.data.responses.forEach(envelope);
  assert.deepEqual(ids(result.data.responses[0]), ['two']);
  assert.deepEqual(result.data.responses.map(item => item.hits.total), [1, 2, 0]);
  assert.deepEqual(result.data.responses[1].hits.hits, []);
  assert.equal((await request('/_msearch', {method: 'POST', body: '{}\n'})).status, 400);
});

test('error contracts: invalid JSON, media type, unsupported operations/options and body limit', async t => {
  const {request} = await gateway(t, {maxBodyBytes: 512});
  for (const [path, method, body, expected, bodyStatus = expected] of [
    ['/pages/_search', 'POST', '{broken', 400],
    ['/pages/_search', 'POST', {query: {unknown: {}}}, 400],
    ['/pages/_search', 'POST', {script_fields: {unsafe: {script: 'anything'}}}, 400],
    ['/pages/_mapping', 'PUT', {}, 501],
    ['/_stream', 'POST', {}, 501],
    ['/pages/Synthetic_Page/x/_update', 'POST', {script: 'anything'}, 501, '501'],
    ['/pages/Synthetic_Page/x?ttl=invalid', 'PUT', {}, 400],
    ['/pages/Synthetic_Page/x', 'PUT', 'x'.repeat(513), 413],
  ]) {
    const result = await request(path, {method, body});
    assert.equal(result.status, expected, path); assert.equal(typeof result.data.error, 'string'); assert.equal(result.data.status, bodyStatus);
  }
  assert.equal((await request('/pages/Synthetic_Page/x', {method: 'PUT', body: '{}', headers: {'Content-Type': 'application/octet-stream'}})).status, 415);
  assert.equal((await request('/pages/_config', {headers: {Origin: 'https://external.invalid'}})).status, 403);
});

test('binding cannot be changed to a public interface, even by an embedder', () => {
  assert.equal(configuration({}).host, '127.0.0.1');
  assert.throws(() => createServer({host: '0.0.0.0', dataDir: ':memory:'}), /127.0.0.1/);
  const server = createServer({host: '127.0.0.1', dataDir: ':memory:'});
  assert.throws(() => server.listen(0, '0.0.0.0'), /127.0.0.1/);
  assert.throws(() => server.listen({port: 0, host: '::'}), /127.0.0.1/);
  assert.throws(() => createServer({servicePrefix: '/', dataDir: ':memory:'}), /synthetic/);
});

test('chunked oversized requests receive a JSON 413 without losing the response connection', async t => {
  const {base} = await gateway(t, {maxBodyBytes: 64});
  const result = await new Promise((resolve, reject) => {
    const request = http.request(`${base}${PREFIX}/pages/Synthetic_Page/chunked`, {method: 'PUT', headers: {'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked'}}, response => {
      let body = ''; response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({status: response.statusCode, data: JSON.parse(body)}));
    });
    request.on('error', reject);
    request.write('{"value":"'); request.write('x'.repeat(100)); request.end('"}');
  });
  assert.equal(result.status, 413); assert.equal(result.data.status, 413);
  assert.equal(typeof result.data.error, 'string');
});

test('query deletion supports all-index and index-list selections without deleting unrelated types', async t => {
  const {put, request, search} = await gateway(t);
  await put('a', page(1)); await put('b', page(2), {index: 'second'});
  await put('kept', page(3), {type: 'Synthetic_LandingPage'});
  const scoped = await request('/pages,second/Synthetic_ArticlePage/_query', {method: 'DELETE', body: {match_all: {}}});
  assert.equal(scoped.status, 200); assert.deepEqual(Object.keys(scoped.data._indices), ['pages', 'second']);
  assert.deepEqual(ids(await search({}, '/_search')), ['kept']);
  const all = await request('/_query', {method: 'DELETE', body: {match_all: {}}});
  assert.equal(all.status, 200); assert.equal((await search({}, '/_search')).hits.total, 0);
});
