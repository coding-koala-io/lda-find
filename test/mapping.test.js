import test from 'node:test';
import assert from 'node:assert/strict';
import {gateway} from './helpers.js';

test('GET index mapping groups stored properties by type', async t => {
  const {put, request} = await gateway(t);
  await put('one', {title: 'Jacket', available: true, quantity: 3}, {type: 'Product'});
  await put('two', {price: 2.5}, {type: 'Product'});
  await put('three', {summary: 'A review'}, {type: 'Review'});
  await put('four', {other: true}, {index: 'other', type: 'Product'});
  const result = await request('/pages/_mapping');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, {pages: {mappings: {
    Product: {properties: {title: {type: 'string'}, available: {type: 'boolean'}, quantity: {type: 'long'}, price: {type: 'double'}}},
    Review: {properties: {summary: {type: 'string'}}},
  }}});
});

test('GET index mapping skips oversized documents and reports nested values as objects', async t => {
  const {put, request} = await gateway(t);
  await put('large', {content: 'x'.repeat(1024 * 1024 + 1)}, {type: 'Oversized'});
  await put('small', {details: {name: 'Jacket'}}, {type: 'Product'});

  const result = await request('/pages/_mapping');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, {pages: {mappings: {
    Oversized: {properties: {}},
    Product: {properties: {details: {type: 'object'}}},
  }}});
});

for (const path of ['/pages/Product/_mapping', '/pages/_mapping/Product']) {
  test(`GET ${path} returns only the requested type`, async t => {
    const {put, request} = await gateway(t);
    await put('one', {title: 'Jacket'}, {type: 'Product'});
    await put('two', {summary: 'A review'}, {type: 'Review'});
    const result = await request(path);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, {pages: {mappings: {Product: {properties: {title: {type: 'string'}}}}}});
  });

  test(`PUT ${path} acknowledges without changing mappings or search hits`, async t => {
    const {put, request, search} = await gateway(t);
    await put('one', {title: 'Jacket'}, {type: 'Product'});
    const query = {query: {term: {title: 'Jacket'}}};
    const before = (await search(query)).hits;
    assert.equal(before.total, 1);
    const result = await request(path, {method: 'PUT', body: {properties: {title: {type: 'long'}}}});
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, {acknowledged: true});
    assert.deepEqual((await search(query)).hits, before);
    assert.deepEqual((await request(path)).data, {pages: {mappings: {Product: {properties: {title: {type: 'string'}}}}}});
  });
}

test('GET mapping returns empty mappings for an implicit index on a fresh store', async t => {
  const {request, server} = await gateway(t);
  const index = await request('/local_pages/_mapping');
  assert.equal(index.status, 200);
  assert.deepEqual(index.data, {local_pages: {mappings: {}}});
  for (const path of ['/local_pages/Shop_Product/_mapping', '/local_pages/_mapping/Shop_Product']) {
    const type = await request(path);
    assert.equal(type.status, 200, path);
    assert.deepEqual(type.data, {local_pages: {mappings: {Shop_Product: {properties: {}}}}});
  }
  assert.equal(server.store.indices.size, 0);
});

test('GET mapping rejects invalid index paths with the same response as GET config', async t => {
  const {request} = await gateway(t);
  for (const [index, status] of [['', 404], ['_all', 400], ['local_pages,other', 400], ['local_*', 400]]) {
    const prefix = `/${index}`;
    const config = await request(`${prefix}/_config`);
    assert.equal(config.status, status, index);
    for (const path of ['/_mapping', '/Shop_Product/_mapping', '/_mapping/Shop_Product']) {
      const mapping = await request(prefix + path);
      assert.equal(mapping.status, config.status, prefix + path);
      assert.deepEqual(mapping.data, config.data);
    }
  }
});

for (const index of ['local_pages', '_local_pages']) {
  for (const path of [`/${index}/Shop_Product/_mapping`, `/${index}/_mapping/Shop_Product`]) {
    test(`PUT ${path} acknowledges on a fresh store without changing search`, async t => {
      const {request, search, server} = await gateway(t);
      const query = {query: {match_all: {}}};
      const searchPath = `/${index}/_search`;
      const before = (await search(query, searchPath)).hits;
      assert.equal(before.total, 0);
      assert.equal(server.store.indices.size, 0);

      const result = await request(path, {method: 'PUT', body: {Shop_Product: {properties: {V: {type: 'nested'}}}}});
      assert.equal(result.status, 200);
      assert.deepEqual(result.data, {acknowledged: true});
      assert.deepEqual((await search(query, searchPath)).hits, before);
      assert.deepEqual((await request(path)).data, {[index]: {mappings: {Shop_Product: {properties: {}}}}});
      assert.equal(server.store.indices.size, 0);
    });
  }
}

test('Mapping reads return empty properties when the requested type has no stored documents', async t => {
  const {put, request} = await gateway(t);
  await put('one', {summary: 'A review'}, {type: 'Review'});
  const type = await request('/pages/Product/_mapping');
  assert.equal(type.status, 200);
  assert.deepEqual(type.data, {pages: {mappings: {Product: {properties: {}}}}});

  assert.equal((await request('/pages/_clear?clear_index=true&clear_stats=false', {method: 'POST'})).status, 200);
  const index = await request('/pages/_mapping');
  assert.equal(index.status, 200);
  assert.deepEqual(index.data, {pages: {mappings: {}}});
});
