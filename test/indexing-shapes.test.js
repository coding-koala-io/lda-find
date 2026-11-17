import test from 'node:test';
import assert from 'node:assert/strict';
import {gateway, ndjson} from './helpers.js';

// Original synthetic content structures, not recorded CMS documents.
const documents = [
  ['Synthetic_CartPage', {
    'Title$$string': 'Sample basket',
    Basket: {Options: {}, Lines: [{Product: {'Code$$string': 'sample-a'}, 'Quantity$$long': 2}, {}]},
    Empty: {}, EmptyArray: [], Optional: null,
    // Document properties must never become acknowledgement metadata.
    ok: false, error: {}, _id: {}, _source: {Nested: {}},
  }],
  ['Synthetic_LayoutSettings', {
    'Title$$string': 'Sample display settings',
    Navigation: {Groups: [{Heading: {'Text$$string': 'Resources'}, Links: [{Target: {}}]}, {}]},
    Configuration: {}, Slots: [{Settings: {}}, {Items: [{}, {'Name$$string': 'Sample'}]}],
    _version: {}, _type: {}, _index: {},
  }],
];

const acknowledgement = (type, id, version = 1) => ({ok: true, _index: 'pages', _type: type, _id: id, _version: version});

test('single explicit/generated indexing replies have the same scalar shape for plain and nested documents', async t => {
  const {request} = await gateway(t);
  for (const [type, source] of documents) {
    const path = `/pages/${type}/sample`;
    const plain = await request(path, {method: 'PUT', body: {'Title$$string': 'Plain'}});
    assert.equal(plain.status, 201);
    assert.deepEqual(plain.data, acknowledgement(type, 'sample'));
    const complex = await request(path, {method: 'PUT', body: source});
    assert.equal(complex.status, 200);
    assert.deepEqual(complex.data, acknowledgement(type, 'sample', 2));
    assert.deepEqual((await request(path)).data._source, source);
    const generated = await request(`/pages/${type}/`, {method: 'POST', body: source});
    assert.equal(generated.status, 201);
    assert.equal(typeof generated.data._id, 'string');
    assert.deepEqual(generated.data, acknowledgement(type, generated.data._id));
    assert.deepEqual((await request(`/pages/${type}/${generated.data._id}`)).data._source, source);
  }
});

test('bulk index/create replies keep action wrappers and scalar metadata for nested objects, empty objects and object arrays', async t => {
  const {request} = await gateway(t);
  const operations = documents.flatMap(([type, source]) => [
    {index: {_index: 'pages', _type: type, _id: 'plain'}}, {},
    {index: {_index: 'pages', _type: type, _id: 'nested'}}, source,
    {create: {_index: 'pages', _type: type, _id: 'created'}}, source,
  ]);
  const result = await request('/_bulk', {method: 'POST', body: ndjson(...operations)});
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.items, documents.flatMap(([type]) => [
    {index: acknowledgement(type, 'plain')},
    {index: acknowledgement(type, 'nested')},
    {create: acknowledgement(type, 'created')},
  ]));
  for (const [type, source] of documents) {
    for (const id of ['nested', 'created']) assert.deepEqual((await request(`/pages/${type}/${id}`)).data._source, source);
  }
});
