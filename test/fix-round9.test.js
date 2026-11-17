import test from 'node:test';
import assert from 'node:assert/strict';
import {gateway} from './helpers.js';

test('every Overview terms facet includes total and other for empty and populated indices', async t => {
  const {put, search} = await gateway(t);
  const body = {size: 0, facets: {
    types: {terms: {field: '$type'}},
    languages: {terms: {field: 'Language.Name$$string'}},
    sites: {terms: {field: 'SiteId$$string'}},
  }};
  for (const facet of Object.values((await search(body)).facets)) {
    assert.deepEqual(facet, {_type: 'terms', missing: 0, total: 0, other: 0, terms: []});
  }
  for (const [id, type, language, site] of [['one', 'Synthetic.Page', 'en', 'a'], ['two', 'Synthetic.Page', 'sv', 'a'], ['three', 'Synthetic.Media', 'en', 'b']]) {
    await put(id, {$type: type, Language: {'Name$$string': language}, 'SiteId$$string': site});
  }
  for (const facet of Object.values((await search(body)).facets)) {
    assert.equal(facet.total, 3);
    assert.equal(facet.total, facet.terms.reduce((sum, {count}) => sum + count, 0));
    assert.equal(facet.other, 0);
    assert.equal(facet.missing, 0);
  }
});

test('truncated facets count all terms and omitted terms within query and facet scope', async t => {
  const {put, search} = await gateway(t);
  for (const [id, tags, included] of [['one', ['a', 'a', 'b'], true], ['two', ['a'], true], ['three', ['b', 'c'], true], ['missing', [], true], ['excluded', ['z'], false], ['outside-query', ['z'], true]]) {
    await put(id, {tags, included});
  }
  const facets = Object.fromEntries([['all', 10], ['top', 1], ['none', 0]].map(([name, size]) => [name, {terms: {fields: ['tags', 'tags'], size}, facet_filter: {term: {included: true}}}]));
  const result = await search({query: {ids: {values: ['one', 'two', 'three', 'missing', 'excluded']}}, filter: {ids: {values: ['two']}}, from: 20, size: 0, facets});
  assert.equal(result.hits.total, 1);
  assert.deepEqual(result.facets.all, {_type: 'terms', missing: 1, total: 5, other: 0, terms: [{term: 'a', count: 2}, {term: 'b', count: 2}, {term: 'c', count: 1}]});
  assert.deepEqual(result.facets.top, {_type: 'terms', missing: 1, total: 5, other: 3, terms: [{term: 'a', count: 2}]});
  assert.deepEqual(result.facets.none, {_type: 'terms', missing: 1, total: 5, other: 5, terms: []});
});

test('size-5 type facet reports total 813 and other 187 when returned counts sum to 626', async t => {
  const {server, search} = await gateway(t);
  // Original synthetic distribution reproducing the supplied Foundation counters.
  // The private proof store is never read or changed by this regression.
  const counts = [200, 150, 110, 90, 76, 70, 60, 57];
  const expected = counts.map((count, i) => ({term: `Synthetic.Type${i}`, count}));
  for (const {term, count} of expected) {
    for (let i = 0; i < count; i++) server.store.put('pages', 'Synthetic_Page', `${term}-${i}`, {$type: term});
  }
  server.store.put('pages', 'Synthetic_Page', 'missing', {});
  const result = await search({size: 0, facets: {
    top: {terms: {field: '$type', size: 5}},
    all: {terms: {field: '$type', size: counts.length}},
  }});
  assert.equal(result.hits.total, 814);
  assert.deepEqual(result.facets.top, {_type: 'terms', missing: 1, total: 813, other: 187, terms: expected.slice(0, 5)});
  const returned = result.facets.top.terms.reduce((sum, {count}) => sum + count, 0);
  assert.equal(returned, 626);
  assert.equal(result.facets.top.other, result.facets.top.total - returned);
  assert.deepEqual(result.facets.all, {_type: 'terms', missing: 1, total: 813, other: 0, terms: expected});
  assert.equal(result.facets.all.total, result.facets.all.terms.reduce((sum, {count}) => sum + count, 0));
});

test('review round 4: document GET rejects 17 overlapping projections of one 1 MiB value', async t => {
  const {request, put, server} = await gateway(t);
  let source = 'x'.repeat(1024 * 1024);
  const fields = Array.from({length: 17}, (_, i) => Array(i + 1).fill('a').join('.'));
  for (let i = 0; i < fields.length; i++) source = {a: source};
  await put('one', source, {type: 'Synthetic_Page'});
  // Original synthetic reconstruction: the review supplies the shape and path
  // length, but no literal request. Length excludes the service prefix.
  const path = `/pages/Synthetic_Page/one?fields=${fields.join(',')}`;
  assert.equal(Buffer.byteLength(path), 338);
  const rejected = await request(path);
  assert.equal(rejected.status, 413);
  assert.ok(Buffer.byteLength(rejected.text) < 250);
  assert.deepEqual(server.store.get('pages', 'Synthetic_Page', 'one').source, source);

  const accepted = await request(`/pages/Synthetic_Page/one?fields=${fields.slice(0, 2).join(',')}`);
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.data.fields, {a: source.a, 'a.a': source.a.a});
  assert.deepEqual((await request('/pages/Synthetic_Page/one')).data._source, source);
});

test('document GET charges repeated selections and stops before constructing later projections', async t => {
  const {request, put, server} = await gateway(t);
  await put('one', {value: 'é'.repeat(1024 * 1024)});
  const doc = server.store.get('pages', 'Synthetic_ArticlePage', 'one');
  Object.defineProperty(doc.source, 'later', {enumerable: true, get() { throw new Error('Projection continued after overflow'); }});
  const fields = [...Array(17).fill('value'), 'later'];
  const rejected = await request(`/pages/Synthetic_ArticlePage/one?fields=${fields.join(',')}`);
  assert.equal(rejected.status, 413);
  assert.ok(Buffer.byteLength(rejected.text) < 250);
  const accepted = await request('/pages/Synthetic_ArticlePage/one?fields=value,value');
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.data.fields, {value: 'é'.repeat(1024 * 1024)});
});

test('document GET bounds source output and preserves small projections and missing responses', async t => {
  const {request, server} = await gateway(t);
  // Seed directly: the source plus PUT envelope would exceed the request limit.
  server.store.put('pages', 'Synthetic_ArticlePage', 'large', {value: 'x'.repeat(16 * 1024 * 1024), label: 'synthetic'});
  const rejected = await request('/pages/Synthetic_ArticlePage/large');
  assert.equal(rejected.status, 413);
  assert.ok(Buffer.byteLength(rejected.text) < 250);
  const projected = await request('/pages/Synthetic_ArticlePage/large?fields=label,_id');
  assert.equal(projected.status, 200);
  assert.deepEqual(projected.data.fields, {label: 'synthetic', _id: 'large'});
  const missing = await request('/pages/Synthetic_ArticlePage/missing?fields=label');
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.data, {_index: 'pages', _type: 'Synthetic_ArticlePage', _id: 'missing', _version: 0, exists: false});
});
