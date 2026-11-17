import test from 'node:test';
import assert from 'node:assert/strict';
import {gateway, ndjson} from './helpers.js';
import {parse} from '../src/precise-json.js';

test('search and multi-search emit decimal score tokens for zero, whole, fractional and exponent values', async t => {
  const {put, request} = await gateway(t);
  await put('one', {'Title$$string': 'Synthetic result'});
  for (const [boost, token] of [[0, '0.0'], [1, '1.0'], [7, '7.0'], [1.25, '1.25'], [1e21, '1.0e+21'], [1e-7, '1.0e-7']]) {
    const body = {query: {query_string: {query: 'Synthetic', fields: [`Title$$string^${boost}`]}}};
    for (const [path, payload] of [['/pages/_search', body], ['/_msearch', ndjson({index: 'pages'}, body)]]) {
      const result = await request(path, {method: 'POST', body: payload});
      assert.equal(result.status, 200, result.text);
      assert.ok(result.text.includes(`"_score":${token}`), result.text);
      assert.ok(result.text.includes(`"max_score":${token}`), result.text);
      const data = path === '/_msearch' ? result.data.responses[0] : result.data;
      assert.equal(data.hits.hits[0]._score, boost);
      assert.equal(data.hits.max_score, boost);
      assert.ok(result.text.includes('"total":1'));
    }
  }
});

test('max_score covers matching hits before paging, respects hit filters and is null without matches', async t => {
  const {put, request} = await gateway(t);
  await put('high', {'Title$$string': 'Synthetic match'});
  await put('low', {'Body$$string': 'Synthetic match'});
  const query = {query_string: {query: 'Synthetic', fields: ['Title$$string^4', 'Body$$string']}};
  for (const page of [{from: 1, size: 1}, {size: 0}, {from: 20}]) {
    const result = await request('/pages/_search', {method: 'POST', body: {query, ...page}});
    assert.equal(result.status, 200);
    assert.ok(result.text.includes('"max_score":4.0'), result.text);
  }
  const filtered = await request('/pages/_search', {method: 'POST', body: {query, filter: {ids: {values: ['low']}}}});
  assert.ok(filtered.text.includes('"max_score":1.0'), filtered.text);
  const empty = await request('/pages/_search', {method: 'POST', body: {query: {ids: {values: ['missing']}}}});
  assert.equal(empty.data.hits.max_score, null);
});

test('document numbers and facet terms keep indexed token types regardless of suffix', async t => {
  const {put, request} = await gateway(t);
  const source = '{"Price$$number":1.0,"Values$$number":[0,2.0,2.5,null],"Nested":{"Weight$$number":3.0},"Rows":[{"Weight$$number":4.0},{}],"Large$$number":9007199254740993,"Count$$long":9007199254740993,"_score":8,"max_score":9,"Text$$string":"\\\"_score\\\":1"}';
  await put('one', source);
  for (const [path, body] of [
    ['/pages/Synthetic_ArticlePage/one', undefined],
    ['/pages/_mget', {docs: [{_type: 'Synthetic_ArticlePage', _id: 'one'}]}],
    ['/pages/_search', {}],
    ['/pages/_search', {fields: ['Price$$number', 'Values$$number', 'Nested.Weight$$number', 'Rows.Weight$$number', 'Large$$number', 'Count$$long', '_score', 'max_score', 'Text$$string']}],
    ['/pages/_search', {partial_fields: {selected: {include: ['*']}}}],
  ]) {
    const result = await request(path, {method: body === undefined ? 'GET' : 'POST', body});
    assert.equal(result.status, 200);
    const projected = body?.fields !== undefined;
    for (const token of ['"Price$$number":1.0', '"Values$$number":[0,2.0,2.5,null]', projected ? '"Nested.Weight$$number":3.0' : '"Weight$$number":3.0', projected ? '"Rows.Weight$$number":[4.0]' : '"Weight$$number":4.0', '"Large$$number":9007199254740993,', '"Count$$long":9007199254740993', '"_score":8,', '"max_score":9,']) {
      assert.ok(result.text.includes(token), `${token}: ${result.text}`);
    }
    assert.equal(parse(result.text).hits?.total ?? 1, 1);
  }
  const facets = await request('/pages/_search', {method: 'POST', body: {facets: {
    prices: {terms: {field: 'Price$$number'}},
    counts: {terms: {field: 'Count$$long'}},
    mixed: {terms: {fields: ['Price$$number', 'Count$$long']}},
    all: {filter: {match_all: {}}},
  }}});
  assert.ok(facets.text.includes('"term":1.0,"count":1'), facets.text);
  assert.ok(facets.text.includes('"term":9007199254740993,"count":1'), facets.text);
  assert.deepEqual(facets.data.facets.all, {_type: 'filter', count: 1});
});
