import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {gateway, ndjson, testStorage} from './helpers.js';

const quota = operation => assert.throws(operation, error => error.status === 413 && /quota exceeded/.test(error.message));

test('per-index and aggregate document/index quotas refuse growth and allow replacement, delete and TTL reclamation', () => {
  let now = 0;
  const store = new Store({dataDir: ':memory:', now: () => now, limits: {indexDocuments: 2, storeDocuments: 3, indices: 2}});
  const put = (index, id, options) => store.transaction(() => store.put(index, 'Page', id, {value: id}, options));
  put('a', '1'); put('a', '2', {ttl: 10});
  quota(() => put('a', '3'));
  put('a', '1'); assert.equal(store.get('a', 'Page', '1').version, 2);
  put('b', '1'); quota(() => put('b', '2')); quota(() => put('c', '1'));
  assert.equal(store.docs.size, 3); assert.equal(store.indices.size, 2);
  now = 10; put('b', '2');
  assert.equal(store.docs.size, 3);
  store.transaction(() => store.delete('a', 'Page', '1'));
  put('a', '3'); assert.equal(store.docs.size, 3);
});

test('index and store byte quotas include identity, settings and UTF-8 content; refusal rolls back replacements', () => {
  const store = new Store({dataDir: ':memory:', limits: {indexBytes: 400, storeBytes: 700}});
  const put = (index, id, value) => store.transaction(() => store.put(index, 'Page', id, {value}));
  put('a', '1', 'x'.repeat(120));
  quota(() => put('a', '1', 'é'.repeat(200)));
  assert.equal(store.get('a', 'Page', '1').source.value, 'x'.repeat(120));
  assert.equal(store.get('a', 'Page', '1').version, 1);
  put('b', '1', 'x'.repeat(120));
  quota(() => put('c', '1', 'x'.repeat(120)));
  assert.equal(store.indices.has('c'), false);
  quota(() => store.transaction(() => { store.ensureIndex('a').languages = ['x'.repeat(700)]; }));
  assert.deepEqual(store.settings('a').languages, []);
});

test('HTTP writes return 413 and bulk preserves order with per-item quota refusals, durably in one transaction', async t => {
  const storage = testStorage(t);
  const {request, server} = await gateway(t, {...storage, limits: {indexDocuments: 1, storeDocuments: 2}});
  let transactions = 0; const transaction = server.store.transaction.bind(server.store);
  server.store.transaction = operation => { transactions++; return transaction(operation); };
  const reply = await request('/_bulk', {method: 'POST', body: ndjson(
    {index: {_index: 'a', _type: 'Page', _id: '1'}}, {value: 'first'},
    {index: {_index: 'a', _type: 'Page', _id: '2'}}, {value: 'refused'},
    {index: {_index: 'b', _type: 'Page', _id: '1'}}, {value: 'second'},
    {index: {_index: 'c', _type: 'Page', _id: '1'}}, {value: 'refused'},
  )});
  assert.equal(reply.status, 200); assert.equal(transactions, 1);
  assert.deepEqual(reply.data.items.map(item => item.index.status ?? 200), [200, 413, 200, 413]);
  const restarted = new Store({...storage, limits: {indexDocuments: 1, storeDocuments: 2}});
  assert.deepEqual(restarted.select().map(doc => doc.source.value), ['first', 'second']);
  const refused = await request('/a/Page/2', {method: 'PUT', body: {value: 'third'}});
  assert.equal(refused.status, 413); assert.match(refused.data.error, /quota exceeded/);
});

test('persistence reuses unchanged serialized documents and oversized stores fail startup', t => {
  const storage = testStorage(t); const store = new Store(storage);
  store.transaction(() => store.put('a', 'Page', '1', {value: 'original'}));
  Object.defineProperty(store.get('a', 'Page', '1').source, 'value', {get() { throw new Error('Unchanged document was serialized again'); }, enumerable: true});
  store.transaction(() => store.put('a', 'Page', '2', {value: 'second'}));
  const restarted = new Store(storage);
  assert.equal(restarted.get('a', 'Page', '1').source.value, 'original');
  assert.equal(JSON.parse(readFileSync(join(storage.dataDir, 'store.json'), 'utf8')).docs.length, 2);
  assert.throws(() => new Store({...storage, limits: {storeBytes: 50}}), /Cannot load/);
  quota(() => new Store({...storage, limits: {indexDocuments: 1}}));
});

test('multi-search enforces aggregate response bytes and component count before retention', async t => {
  const storage = testStorage(t);
  const {request, put} = await gateway(t, {...storage, maxMultiSearchBytes: 1000, debugSearchRequests: true});
  await put('one', {value: 'x'.repeat(300)});
  assert.equal((await request('/_msearch', {method: 'POST', body: ndjson({index: 'pages'}, {})})).status, 200);
  const file = join(storage.dataDir, 'search-requests.ndjson'); const before = readFileSync(file, 'utf8');
  const refused = await request('/_msearch', {method: 'POST', body: ndjson({index: 'pages'}, {}, {index: 'pages'}, {})});
  assert.equal(refused.status, 413); assert.match(refused.data.error, /aggregate response/);
  assert.equal((await request('/_msearch', {method: 'POST', body: ndjson(...Array.from({length: 202}, () => ({})))})).status, 413);
  assert.equal(readFileSync(file, 'utf8'), before);
});
