import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {gateway, ndjson, PREFIX} from './helpers.js';
import {search} from '../src/search.js';
import {ResponseBudget} from '../src/response-budget.js';

test('body requests accept repeated identical allowed Origins and reject every mixed or invalid list', async t => {
  const {request, base} = await gateway(t);
  for (const origin of ['http://localhost:51942', 'https://127.0.0.1:443', 'http://[::1]:8080']) {
    for (const value of [`${origin}, ${origin}`, `${origin},${origin}, ${origin}`]) {
      assert.equal((await request('/pages/_search', {method: 'POST', body: {}, headers: {Origin: value}})).status, 200);
    }
  }
  for (const value of ['http://localhost:51942, http://localhost:51943', 'http://localhost:51942, https://localhost:51942', 'http://localhost:51942, http://127.0.0.1:51942', 'http://localhost:51942, https://external.invalid', 'https://external.invalid, https://external.invalid', 'http://localhost:51942,', ',http://localhost:51942', 'null, null', 'http://localhost/, http://localhost/']) {
    assert.equal((await request('/pages/_search', {method: 'POST', body: {}, headers: {Origin: value}})).status, 403, value);
  }
  // Real repeated HTTP header lines arrive comma-joined by Node as well.
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${base}${PREFIX}/pages/_search`, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: ['http://localhost:51942', 'http://localhost:51942']}}, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(status, 200);
});

const overview = {query: {match_all: {}}, filter: {}, size: 0, facets: {types: {terms: {field: '$type'}}, languages: {terms: {field: 'Language.Name$$string'}}, sites: {terms: {field: 'SiteId$$string'}}}};
const explore = {query: {query_string: {query: '*:*'}}, partial_fields: {partial_source: {include: '*', exclude: '*$$attachment'}}, facets: {type: {terms: {field: '$type', size: 100}}}, size: 25};

test('proxy form/plain labels accept JSON on search, Overview, Explore and document routes', async t => {
  const {request} = await gateway(t);
  for (const contentType of ['application/x-www-form-urlencoded', 'text/plain; charset=UTF-8']) {
    const headers = {'Content-Type': contentType, Origin: 'http://localhost:51942, http://localhost:51942'};
    const doc = {$type: 'Synthetic.Page', Language: {'Name$$string': 'en'}, 'SiteId$$string': 'synthetic'};
    assert.ok([200, 201].includes((await request('/pages/Page/one', {method: 'PUT', headers, body: doc})).status));
    for (const path of ['/pages/_search', '/pages/Page/_search', '/_search', '/pages/_count']) {
      assert.equal((await request(path, {method: 'POST', headers, body: {query: {match_all: {}}}})).status, 200);
    }
    const counts = await request('/pages/_search', {method: 'POST', headers, body: overview});
    assert.equal(counts.status, 200); assert.equal(counts.data.facets.types.terms[0].count, 1);
    const result = await request('/pages/_search', {method: 'POST', headers, body: explore});
    assert.equal(result.status, 200); assert.deepEqual(result.data.hits.hits[0].fields.partial_source, doc);
    assert.equal((await request('/pages/_mget', {method: 'POST', headers, body: {docs: [{_type: 'Page', _id: 'one'}]}})).status, 200);
    assert.equal((await request('/pages/Page/one', {method: 'DELETE', headers, body: {}})).status, 200);
    assert.equal((await request('/pages/Page', {method: 'POST', headers, body: doc})).status, 201);
    // Keep the next loop's Overview population deterministic.
    assert.equal((await request('/pages/_clear?clear_index=true&clear_stats=false', {method: 'POST'})).status, 200);
  }
});

test('proxy labels still require exactly one JSON value and do not enable form parsing or framed endpoints', async t => {
  const {request, server} = await gateway(t);
  for (const contentType of ['application/x-www-form-urlencoded; charset=utf-8', 'text/plain']) {
    const headers = {'Content-Type': contentType};
    for (const body of ['', 'value=one', '{broken', '{} {}', '{}\n{}', ' ', '{"value":1}trailing']) {
      for (const [path, method] of [['/pages/_search', 'POST'], ['/pages/_count', 'POST'], ['/pages/Page/one', 'PUT'], ['/pages/_mget', 'POST']]) {
        assert.equal((await request(path, {method, headers, body})).status, 400);
      }
    }
    for (const body of ['null', '1', '[]', '"text"']) assert.equal((await request('/pages/_search', {method: 'POST', headers, body})).status, 400);
    for (const path of ['/_msearch', '/_bulk', '/pages/_track']) assert.equal((await request(path, {method: 'POST', headers, body: '{}'})).status, 415);
  }
  assert.equal(server.store.docs.size, 0);
});

test('review regression: a 444-byte request for 17 copies of a 1 MiB document gets a small 413', async t => {
  const {request, put, server} = await gateway(t);
  await put('large', {value: 'a'.repeat(1024 * 1024)});
  // Review supplied byte count and alias/corpus shape, but no literal request.
  const body = JSON.stringify({partial_fields: Object.fromEntries(Array.from({length: 17}, (_, i) => [String(i), {include: '*'}])), size: 1});
  const wire = body.padEnd(444, ' ');
  assert.equal(Buffer.byteLength(wire), 444);
  const response = await request('/pages/_search', {method: 'POST', body: wire});
  assert.equal(response.status, 413); assert.ok(response.text.length < 250);
  assert.equal(server.store.get('pages', 'Synthetic_ArticlePage', 'large').source.value.length, 1024 * 1024);
  const accepted = await request('/pages/_search', {method: 'POST', body: {partial_fields: {a: {include: '*'}, b: {include: '*'}}}});
  assert.equal(accepted.status, 200); assert.deepEqual(accepted.data.hits.hits[0].fields.a, accepted.data.hits.hits[0].fields.b);
  const multi = await request('/_msearch', {method: 'POST', body: ndjson({index: 'pages'}, JSON.parse(body))});
  assert.equal(multi.status, 413); assert.ok(multi.text.length < 250);
});

test('one output budget covers fields, aliases, source hits, highlights, facets and multi-search components', async t => {
  const {put, server, request} = await gateway(t);
  await put('one', {value: 'é'.repeat(2000), text: 'word '.repeat(1000)});
  const run = (body, limit = 1000) => search(server.store, body, {outputBudget: new ResponseBudget(limit)});
  for (const body of [{}, {fields: ['value']}, {partial_fields: {a: {include: '*'}}}, {fields: [], query: {query_string: {query: 'word'}}, highlight: {fields: {text: {}}}}, {size: 0, facets: {values: {terms: {field: 'value'}}}}]) {
    assert.throws(() => run(body), error => error.status === 413);
  }
  // First alias fits. A second copy must fail before constructing a third one.
  let visits = 0;
  const doc = server.store.get('pages', 'Synthetic_ArticlePage', 'one');
  Object.defineProperty(doc.source, 'value', {enumerable: true, get() { visits++; return 'é'.repeat(2000); }});
  assert.throws(() => run({partial_fields: {a: {include: 'value'}, b: {include: 'value'}, c: {include: 'value'}}}, 7000), error => error.status === 413);
  assert.equal(visits, 2);
  assert.equal((await request('/_msearch', {method: 'POST', body: ndjson({index: 'pages'}, {size: 0}, {index: 'pages'}, {size: 0})})).status, 200);
});

test('review regression: 1,025 fields in a term clause fail before scanning empty and populated indices', async t => {
  const {request, put, server} = await gateway(t);
  const fields = Object.fromEntries(Array.from({length: 1025}, (_, i) => [`field${i}`, 'x']));
  for (const populated of [false, true]) {
    if (populated) await put('one', fields);
    let scans = 0; const select = server.store.select.bind(server.store);
    server.store.select = (...args) => { scans++; return select(...args); };
    const response = await request('/pages/_search', {method: 'POST', body: {query: {term: fields}}});
    assert.equal(response.status, 400); assert.equal(scans, 0);
    server.store.select = select;
  }
  assert.equal((await request('/pages/_search', {method: 'POST', body: {query: {term: {field0: 'x', field1: 'x'}}}})).data.hits.total, 1);
});

test('all compound field families and sibling query/filter/facet branches share the compile budget', async t => {
  const {request} = await gateway(t);
  const fields = value => Object.fromEntries(Array.from({length: 1025}, (_, i) => [`f${i}`, value]));
  for (const [kind, value] of [['term', 'x'], ['terms', ['x']], ['prefix', 'x'], ['wildcard', 'x*'], ['range', {from: 0}]]) {
    assert.equal((await request('/pages/_search', {method: 'POST', body: {query: {[kind]: fields(value)}}})).status, 400);
  }
  const terms = {term: Object.fromEntries(Array.from({length: 510}, (_, i) => [`f${i}`, 'x']))};
  assert.equal((await request('/pages/_search', {method: 'POST', body: {query: terms, filter: terms}})).status, 200);
  assert.equal((await request('/pages/_search', {method: 'POST', body: {query: terms, filter: terms, facets: {extra: {filter: {term: {f: 'x', g: 'x'}}}}}})).status, 400);
});

test('4xx and 5xx request logs add fixed short codes, including direct route responses, without values', async t => {
  const lines = [];
  const {request, server} = await gateway(t, {logRequests: true, logger: {log: line => lines.push(line), error() {}}});
  for (const [path, method, body] of [['/pages/_search', 'POST', '{private-body'], ['/pages/Page/missing?fields=private-query', 'GET'], ['/pages/Page/one/_update', 'POST', {}]]) {
    await request(path, {method, body, headers: {'X-Private': 'private-header'}});
  }
  server.store.select = () => { throw new Error('private-exception'); };
  assert.equal((await request('/pages/_search', {method: 'POST', body: {}})).status, 500);
  assert.match(lines[0], / 400 invalid_json \d+ms$/);
  assert.match(lines[1], / 404 not_found \d+ms$/);
  assert.match(lines[2], / 501 not_implemented \d+ms$/);
  assert.match(lines[3], / 500 internal_error \d+ms$/);
  for (const value of ['private-body', 'private-query', 'private-header', 'private-exception', PREFIX]) assert.equal(lines.join('\n').includes(value), false);
});
