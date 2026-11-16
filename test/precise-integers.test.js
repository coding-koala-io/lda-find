import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {join, resolve, sep} from 'node:path';
import {gateway, ids} from './helpers.js';
import {parse, stringify} from '../src/precise-json.js';
import {defaultDataRoot} from '../src/storage-paths.js';

function temporary(t) {
  const root = join(defaultDataRoot, '.test-runtime'); mkdirSync(root, {recursive: true});
  const directory = mkdtempSync(join(root, 'integers-'));
  t.after(() => {
    const target = resolve(directory);
    if (!target.startsWith(root + sep)) throw new Error('Test cleanup escaped its directory');
    rmSync(target, {recursive: true, force: true});
  });
  return directory;
}

test('raw JSON large integer round trip survives disk restart, adjacent predicates, sort, facets and query deletion', async t => {
  const dataDir = temporary(t); const first = await gateway(t, {dataDir});
  const path = '/pages/Synthetic_ArticlePage/high';
  await first.put('high', '{"Value$$long":9007199254740993}');
  const fetched = await first.request(path);
  assert.equal(fetched.status, 200);
  assert.ok(fetched.text.includes('"Value$$long":9007199254740993'));
  assert.ok(readFileSync(join(dataDir, 'store.json'), 'utf8').includes('"Value$$long":9007199254740993'));

  const {request, search, put} = await gateway(t, {dataDir});
  assert.ok((await request(path)).text.includes('"Value$$long":9007199254740993'));
  for (const query of [
    '{"query":{"term":{"Value$$long":9007199254740992}}}',
    '{"query":{"terms":{"Value$$long":[9007199254740992]}}}',
    '{"query":{"range":{"Value$$long":{"from":9007199254740992,"to":9007199254740992}}}}',
    '{"query":{"range":{"Value$$long":{"to":9007199254740992}}}}',
    '{"query":{"range":{"Value$$long":{"from":9007199254740994}}}}',
  ]) assert.deepEqual(ids(await search(query)), []);
  assert.deepEqual(ids(await search('{"query":{"term":{"Value$$long":9007199254740993}}}')), ['high']);
  assert.deepEqual(ids(await search('{"query":{"range":{"Value$$long":{"from":1,"to":9007199254740993}}}}')), ['high']);
  assert.equal((await request('/pages/_query', {method: 'DELETE', body: '{"term":{"Value$$long":9007199254740992}}'})).status, 200);
  assert.equal((await request(path)).status, 200);

  await put('low', '{"Value$$long":9007199254740992}');
  for (const mode of ['min', 'max', 'sum', 'avg']) {
    assert.deepEqual(ids(await search({sort: [{'Value$$long': {order: 'asc', mode}}]})), ['low', 'high']);
    assert.deepEqual(ids(await search({sort: [{'Value$$long': {order: 'desc', mode}}]})), ['high', 'low']);
  }
  const faceted = await request('/pages/_search', {method: 'POST', body: '{"facets":{"values":{"terms":{"field":"Value$$long"}},"high":{"filter":{"term":{"Value$$long":9007199254740993}}}}}'});
  const facets = parse(faceted.text).facets;
  assert.deepEqual(facets.values.terms, [{term: 9007199254740992n, count: 1}, {term: 9007199254740993n, count: 1}]);
  assert.equal(facets.high.count, 1);
  const removed = await request('/pages/_query', {method: 'DELETE', body: '{"range":{"Value$$long":{"from":9007199254740993,"to":9007199254740993}}}'});
  assert.equal(removed.status, 200);
  assert.deepEqual(ids(await search()), ['low']);
  assert.deepEqual(ids(await (await gateway(t, {dataDir})).search()), ['low']);
});

test('signed integral limits, array sort aggregates, facets and projections preserve raw values', async t => {
  const {put, request, search} = await gateway(t);
  await put('high', '{"Value$$long":[9007199254740993,9007199254740994,9007199254740993],"Nested":{"Min$$long":-9223372036854775808,"Max$$long":9223372036854775807}}');
  await put('low', '{"Value$$long":[9007199254740992,9007199254740993,9007199254740992]}');
  for (const mode of ['min', 'max', 'sum', 'avg']) assert.deepEqual(ids(await search({sort: [{'Value$$long': {mode}}]})), ['low', 'high']);
  const facets = parse((await request('/pages/_search', {method: 'POST', body: {facets: {values: {terms: {field: 'Value$$long'}}}}})).text).facets.values;
  assert.deepEqual(facets.terms, [{term: 9007199254740993n, count: 2}, {term: 9007199254740992n, count: 1}, {term: 9007199254740994n, count: 1}]);
  for (const body of [{fields: ['Nested.Min$$long', 'Nested.Max$$long']}, {partial_fields: {p: {include: ['Nested.*']}}}]) {
    const result = await request('/pages/_search', {method: 'POST', body});
    assert.ok(result.text.includes('"Min$$long":-9223372036854775808'));
    assert.ok(result.text.includes('"Max$$long":9223372036854775807'));
  }
  const projected = await request('/pages/Synthetic_ArticlePage/high?fields=Nested.Min$$long');
  assert.ok(projected.text.includes('"Min$$long":-9223372036854775808'));
  assert.deepEqual(ids(await search('{"query":{"term":{"Nested.Max$$long":9223372036854775806}}}')), []);
});

test('framed bulk/multi-search and multi-get preserve large integral numeric tokens', async t => {
  const {request} = await gateway(t);
  const bulk = '{"index":{"_index":"pages","_type":"Synthetic_ArticlePage","_id":"one"}}\n{"Value$$long":9007199254740993}\n';
  assert.equal((await request('/_bulk', {method: 'POST', body: bulk})).status, 200);
  const result = await request('/_msearch', {method: 'POST', body: '{"index":"pages"}\n{"query":{"term":{"Value$$long":9007199254740992}}}\n{"index":"pages"}\n{"query":{"term":{"Value$$long":9007199254740993}}}\n'});
  assert.deepEqual(result.data.responses.map(response => response.hits.total), [0, 1]);
  assert.ok(result.text.includes('"Value$$long":9007199254740993'));
  const get = await request('/pages/_mget', {method: 'POST', body: {docs: [{_type: 'Synthetic_ArticlePage', _id: 'one'}]}});
  assert.ok(get.text.includes('"Value$$long":9007199254740993'));
});

test('array sum/average sorts distinguish fractional results above the safe integer limit', async t => {
  const {put, search} = await gateway(t);
  await put('high', '{"Value$$long":[9007199254740993,9007199254740994],"Mixed$$number":[9007199254740993,0.5]}');
  await put('low', '{"Value$$long":[9007199254740993],"Mixed$$number":[9007199254740993,0.25]}');
  for (const field of ['Value$$long', 'Mixed$$number']) {
    for (const mode of ['sum', 'avg']) assert.deepEqual(ids(await search({sort: [{[field]: {mode}}]})), ['low', 'high']);
  }
});

test('precise numeric token parsing handles integral decimal/exponent forms and ordinary JSON data', () => {
  for (const token of ['9007199254740993', '9007199254740993.0', '90071992547409930e-1', '9.007199254740993e15', '-9007199254740993']) {
    const value = parse(token);
    assert.equal(typeof value, 'bigint');
    assert.equal(value, token.startsWith('-') ? -9007199254740993n : 9007199254740993n);
    assert.equal(stringify(value), String(value));
  }
  const source = '{"safe":9007199254740991,"decimal":1.25,"exponent":1e2,"tiny":1e-999,"zero":0,"text":"9007199254740993","null":null,"bool":false,"array":[],"__proto__":{"x":1}}';
  assert.deepEqual(parse(source), JSON.parse(source));
  assert.equal({}.x, undefined);
  for (const malformed of ['01', '1.', '[1,]', '{"a":1} trailing']) assert.throws(() => parse(malformed), SyntaxError);
});
