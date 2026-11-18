import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import http from 'node:http';
import {configuration} from '../src/server.js';
import {gateway, ndjson, ids, PREFIX, testStorage} from './helpers.js';
import {Store} from '../src/store.js';

test('CMS forwarded Origin accepts only HTTP(S) localhost, IPv4 and IPv6 loopback origins at any port', async t => {
  const {request, server, base} = await gateway(t);
  for (const scheme of ['http', 'https']) for (const host of ['localhost', '127.0.0.1', '[::1]']) for (const port of ['', ':51942', ':0', ':65535']) {
    assert.equal((await request('/pages/_config', {headers: {Origin: `${scheme}://${host}${port}`}})).status, 200);
  }
  for (const origin of ['https://external.invalid', 'null', 'file://localhost', 'http://localhost.evil.invalid:51942', 'http://127.0.0.2', 'http://[::2]', 'http://127.1', 'http://2130706433', 'http://localhost@external.invalid', 'http://external.invalid@localhost', 'http://localhost/', 'http://localhost?value=x', 'http://localhost:65536', 'http://localhost:51942 http://external.invalid', '']) {
    assert.equal((await request('/pages/_config', {headers: {Origin: origin}})).status, 403, origin);
  }
  assert.equal(server.address().address, '127.0.0.1');
  const status = await new Promise((resolve, reject) => {
    http.get(`${base}${PREFIX}/pages/_config`, {headers: {Host: 'external.invalid'}}, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(status, 403);
});

const overview = {
  query: {match_all: {}}, filter: {}, size: 0,
  facets: {
    type: {terms: {field: '$type', size: 100}},
    language: {terms: {field: 'Language.Name$$string', size: 100}},
    site: {terms: {field: 'SiteId$$string', size: 100}},
    all: {filter: {}},
  },
};

test('Overview empty filters count types, languages and sites before paging on empty and populated indices', async t => {
  const {request, search, put} = await gateway(t);
  const empty = await search(overview);
  assert.equal(empty.hits.total, 0); assert.equal(empty.facets.all.count, 0);
  for (const name of ['type', 'language', 'site']) assert.deepEqual(empty.facets[name], {_type: 'terms', missing: 0, total: 0, other: 0, terms: []});
  for (const [id, type, language, site] of [['1', 'Synthetic.Page, Synthetic', 'en', 'a'], ['2', 'Synthetic.Page, Synthetic', 'sv', 'a'], ['3', 'Synthetic.Media, Synthetic', 'en', 'b']]) {
    await put(id, {$type: type, Language: {'Name$$string': language}, 'SiteId$$string': site});
  }
  const result = await search(overview);
  assert.equal(result.hits.total, 3); assert.deepEqual(result.hits.hits, []); assert.equal(result.facets.all.count, 3);
  assert.deepEqual(result.facets.type.terms.map(({count}) => count), [2, 1]);
  assert.deepEqual(result.facets.language.terms, [{term: 'en', count: 2}, {term: 'sv', count: 1}]);
  assert.deepEqual(result.facets.site.terms, [{term: 'a', count: 2}, {term: 'b', count: 1}]);
  for (const path of ['/pages/_count', '/pages/_search?search_type=count']) {
    const reply = await request(path, {method: 'POST', body: {query: {filtered: {query: {match_all: {}}, filter: {}}}, filter: {}}});
    assert.equal(reply.status, 200); assert.equal(reply.data.count ?? reply.data.hits.total, 3);
  }
  assert.equal((await search({...overview, filter: {term: {'Language.Name$$string': 'sv'}}})).hits.total, 1);
  assert.equal((await request('/pages/_search', {method: 'POST', body: {filter: {term: {}, unknown: {}}}})).status, 400);
});

test('Explore exact observed query accepts match-all, scalar partial patterns, type filters and paging', async t => {
  const {search, put} = await gateway(t);
  const body = {query: {query_string: {query: '*:*'}}, partial_fields: {partial_source: {include: '*', exclude: '*$$attachment'}}, facets: {type: {terms: {field: '$type', size: 100}}}, size: 25};
  assert.equal((await search(body)).hits.total, 0);
  for (let i = 0; i < 30; i++) await put(String(i), {$type: i < 28 ? 'Synthetic.Page, Synthetic' : 'Synthetic.Media, Synthetic', 'Title$$string': `Record ${i}`, 'File$$attachment': 'omit', Nested: {'Binary$$attachment': 'omit', 'Text$$string': 'kept'}});
  const first = await search(body);
  assert.equal(first.hits.total, 30); assert.equal(first.hits.hits.length, 25);
  assert.deepEqual(first.hits.hits[0].fields.partial_source, {$type: 'Synthetic.Page, Synthetic', 'Title$$string': 'Record 0', Nested: {'Text$$string': 'kept'}});
  assert.deepEqual(ids(await search({...body, from: 25})), ['25', '26', '27', '28', '29']);
  const filtered = {...body, filter: {term: {$type: 'Synthetic.Page, Synthetic'}}, from: 25};
  const last = await search(filtered);
  assert.equal(last.hits.total, 28); assert.deepEqual(ids(last), ['25', '26', '27']);
  assert.deepEqual(last.facets.type.terms.map(({count}) => count), [28, 2]);
  assert.equal((await search({...filtered, from: 28})).hits.hits.length, 0);
  assert.equal((await search({...body, query: {filtered: {query: body.query, filter: filtered.filter}}})).hits.total, 28);
});

test('specific languages exclude standard and non-language analyzers, including legacy stored metadata', async t => {
  const storage = testStorage(t);
  const {request, server} = await gateway(t, storage);
  for (const [id, language] of ['en', 'standard', 'sv', 'fr', 'en', 'custom', 'xyz'].entries()) {
    assert.equal((await request(`/pages/Page/${id}?language_routing=${language}`, {method: 'PUT', body: {value: id}})).status, 201);
  }
  assert.deepEqual(server.store.settings('pages').languages, ['en', 'standard', 'sv', 'fr', 'custom', 'xyz']);
  assert.deepEqual((await request('/pages/specific-languages/get')).data, ['en', 'sv', 'fr']);
  const restarted = new Store(storage);
  server.store.indices = restarted.indices;
  assert.deepEqual((await request('/pages/specific-languages/get')).data, ['en', 'sv', 'fr']);
  assert.equal((await request('/pages/specific-languages/clear', {method: 'DELETE'})).data, true);
  assert.deepEqual((await request('/pages/specific-languages/get')).data, []);
  assert.equal(server.store.docs.size, 7);
});

test('Clear index is named-index scoped and durable; clear statistics is a mutation-free no-op', async t => {
  const storage = testStorage(t);
  const {request, put, server} = await gateway(t, storage);
  await put('one', {value: 'first'}); await put('two', {value: 'second'}, {index: 'other'});
  const before = readFileSync(server.store.file, 'utf8');
  for (const method of ['POST', 'DELETE']) {
    const stats = await request('/pages/_clear?clear_index=false&clear_stats=true', {method, headers: {Origin: 'http://localhost:51942'}});
    assert.equal(stats.status, 200); assert.equal(readFileSync(server.store.file, 'utf8'), before);
  }
  for (const flags of ['', '?clear_index=true', '?clear_index=1&clear_stats=false', '?clear_index=true&clear_stats=false&unknown=x', '?clear_index=&clear_stats=false', '?clear_index=true&clear_index=false&clear_stats=false']) {
    assert.equal((await request(`/pages/_clear${flags}`, {method: 'POST'})).status, 400);
    assert.equal(readFileSync(server.store.file, 'utf8'), before);
  }
  assert.equal((await request('/_all/_clear?clear_index=true&clear_stats=false', {method: 'POST'})).status, 400);
  assert.equal((await request('/pages,_all/_clear?clear_index=true&clear_stats=false', {method: 'DELETE'})).status, 400);
  assert.equal((await request('/pages/_clear?clear_index=true&clear_stats=false', {method: 'DELETE'})).status, 200);
  assert.deepEqual(new Store(storage).select().map(doc => doc.index), ['other']);
  assert.equal((await request('/empty/_clear?clear_index=true&clear_stats=true', {method: 'POST'})).status, 200);
  assert.equal((await request('/pages/_clear?clear_index=true&clear_stats=false', {method: 'POST'})).status, 200);
  assert.equal((await request('/other/Synthetic_ArticlePage/two')).status, 200);
});

test('unsupported endpoints and methods return JSON 501 before URL-option validation', async t => {
  const {request} = await gateway(t);
  for (const [path, method] of [['/pages/_stats/query/top', 'GET'], ['/pages/_admin/synonym/', 'GET'], ['/pages/_admin/unifiedweights/', 'GET'], ['/pages/_admin/connector_job/status/', 'GET'], ['/pages/_autocomplete/list', 'GET'], ['/pages/_didyoumean/list', 'POST'], ['/pages/Page/one/_mlt', 'GET'], ['/pages/Page/_mapping', 'DELETE'], ['/_stream', 'POST'], ['/unknown', 'GET'], ['/pages/_search', 'GET'], ['/pages/_config', 'POST'], ['/pages/Page/one/_update', 'POST']]) {
    for (const options of ['', '?tags=private&size=1000&from=2026-01-01&to=2026-11-17&interval=hour&dojo.preventCache=123', '?routing=&unknown=&unknown=x']) {
      const reply = await request(path + options, {method});
      assert.equal(reply.status, 501, `${method} ${path}`); assert.equal(typeof reply.data.error, 'string'); assert.ok(reply.data.error.length < 250);
    }
  }
  assert.equal((await request('/pages/_search?unknown=x', {method: 'POST', body: {}})).status, 400);
});

test('request log defaults on in development, LOG_REQUESTS=0 disables it, and only method/route/status/time are written', async t => {
  assert.equal(configuration({}).logRequests, true);
  assert.equal(configuration({NODE_ENV: 'development'}).logRequests, true);
  assert.equal(configuration({NODE_ENV: 'production'}).logRequests, false);
  assert.equal(configuration({LOG_REQUESTS: '0'}).logRequests, false);
  assert.equal(configuration({NODE_ENV: 'production', LOG_REQUESTS: '1'}).logRequests, true);
  const lines = [];
  const logger = {log: line => lines.push(line), error: () => {}};
  const {request} = await gateway(t, {logRequests: true, logger});
  await request('/private-index/PrivateType/private-id', {method: 'PUT', headers: {'X-Private': 'header-value'}, body: {value: 'body-value'}});
  await request('/private-index/_search?unknown=query-value', {method: 'POST', body: {}});
  await request('/private-index/_config', {headers: {Origin: 'https://outside.invalid'}});
  await request('/outside?secret=query-value', {prefixed: false});
  await request('/private-index/PrivateType/_private', {method: 'PUT', body: {}});
  assert.equal(lines.length, 5);
  assert.match(lines[0], /^PUT \/:value\/:value\/:value 201 \d+ms$/);
  assert.match(lines[1], /^POST \/:value\/_search 400 bad_request \d+ms$/);
  assert.match(lines[2], /^GET \/:value\/_config 403 origin_not_allowed \d+ms$/);
  assert.match(lines[3], /^GET \/\[outside-service\] 403 forbidden \d+ms$/);
  assert.match(lines[4], /^PUT \/:value\/:value\/:value 201 \d+ms$/);
  for (const value of [PREFIX, 'private-index', 'PrivateType', 'private-id', '_private', 'header-value', 'body-value', 'query-value', 'outside.invalid']) assert.equal(lines.join('\n').includes(value), false, value);
  const off = await gateway(t, {logRequests: false, logger});
  await off.request('/pages/_config'); assert.equal(lines.length, 5);
});

test('wildcard length and count excesses return clean HTTP 400s for both DSL and text on empty and populated stores', async t => {
  const {request, put} = await gateway(t);
  for (const populated of [false, true]) {
    if (populated) await put('one', {'Title$$string': 'a'.repeat(45)});
    for (const pattern of ['a*'.repeat(32768), 'a*'.repeat(65), 'a'.repeat(1025) + '*']) {
      for (const query of [{wildcard: {'Title$$string': pattern}}, {query_string: {query: pattern}}, {field: {'Title$$string': {query: pattern}}}]) {
        const reply = await request('/pages/_search', {method: 'POST', body: {query}});
        assert.equal(reply.status, 400); assert.equal(reply.data.status, 400);
      }
    }
  }
});

test('review wildcard adversary a* x25 + b against 45 a characters finishes within two seconds through HTTP', () => {
  const module = new URL('../src/server.js', import.meta.url).href;
  const script = `
    import assert from 'node:assert/strict';
    import {createServer} from ${JSON.stringify(module)};
    const server = createServer({dataDir: ':memory:', servicePrefix: '/synthetic', logRequests: false});
    server.store.put('pages', 'Page', 'one', {'Title$$string': 'a'.repeat(45)});
    await new Promise(resolve => server.listen(0, resolve));
    try {
      for (const pattern of ['a*'.repeat(25) + 'b', 'a*'.repeat(25), 'a?' + '*']) {
        for (const query of [{wildcard: {'Title$$string': pattern}}, {query_string: {query: pattern}}]) {
          const response = await fetch('http://127.0.0.1:' + server.address().port + '/synthetic/pages/_search', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({query})});
          assert.equal(response.status, 200); assert.equal((await response.json()).hits.total, pattern.endsWith('b') ? 0 : 1);
        }
      }
    } finally { await new Promise(resolve => server.close(resolve)); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {timeout: 2000, encoding: 'utf8', windowsHide: true});
  assert.equal(result.error, undefined, result.error?.message); assert.equal(result.status, 0, result.stderr);
});

test('multi-get caps document count before lookup and bounds repetition of one 1 MiB document', async t => {
  const {request, put, server} = await gateway(t);
  await put('large', {value: 'a'.repeat(1024 * 1024)});
  const doc = {_type: 'Synthetic_ArticlePage', _id: 'large'};
  assert.equal((await request('/pages/_mget', {method: 'POST', body: {docs: Array(17).fill(doc)}})).status, 413);
  assert.equal((await request('/pages/_mget', {method: 'POST', body: {docs: [doc, doc]}})).status, 200);
  let lookups = 0; const get = server.store.get.bind(server.store);
  server.store.get = (...args) => { lookups++; return get(...args); };
  assert.equal((await request('/pages/_mget', {method: 'POST', body: {docs: Array(101).fill(doc)}})).status, 413);
  assert.equal(lookups, 0);
  const missing = await request('/pages/_mget', {method: 'POST', body: {docs: Array(100).fill({...doc, _id: 'missing'})}});
  assert.equal(missing.status, 200); assert.equal(missing.data.docs.length, 100);
});

test('bulk language metadata overflow refuses only that item and retains valid neighbours durably', async t => {
  for (const limits of [{indexBytes: 400}, {storeBytes: 500}]) {
    const storage = testStorage(t);
    const {request} = await gateway(t, {...storage, limits});
    const meta = {_index: 'a', _type: 'P'};
    const reply = await request('/_bulk', {method: 'POST', body: ndjson(
      {index: {...meta, _id: '1', language_routing: 'en'}}, {value: 'first'},
      {index: {...meta, _id: '2', language_routing: 'x'.repeat(600)}}, {value: 'overflow'},
      {index: {...meta, _id: '3', language_routing: 'sv'}}, {value: 'last'},
    )});
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.data.items.map(item => item.index.status ?? 200), [200, 413, 200]);
    const restarted = new Store({...storage, limits});
    assert.deepEqual(restarted.select().map(doc => doc.id), ['1', '3']);
    assert.deepEqual(restarted.settings('a').languages, ['en', 'sv']);
  }
});

test('empty routing= and language_routing= are HTTP 400 and leave writes/deletes unchanged', async t => {
  const {request, put, server} = await gateway(t);
  await put('one', {value: 'original'});
  for (const option of ['routing=', 'language_routing=']) for (const method of ['PUT', 'POST', 'DELETE']) {
    const path = method === 'POST' ? '/pages/Synthetic_ArticlePage/' : '/pages/Synthetic_ArticlePage/one';
    assert.equal((await request(`${path}?${option}`, {method, ...(method !== 'DELETE' ? {body: {value: 'changed'}} : {})})).status, 400);
    assert.equal(server.store.docs.size, 1); assert.equal(server.store.get('pages', 'Synthetic_ArticlePage', 'one').version, 1);
  }
});
