import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {gateway, ndjson, testStorage, PREFIX} from './helpers.js';
import {configuration} from '../src/server.js';

test('search recording is opt-in and omits credentials, paths, metadata and writes', async t => {
  assert.equal(configuration({}).debugSearchRequests, false);
  assert.equal(configuration({DEBUG_SEARCH_REQUESTS: 'true'}).debugSearchRequests, false);
  assert.equal(configuration({DEBUG_SEARCH_REQUESTS: '1'}).debugSearchRequests, true);
  const storage = testStorage(t); const {dataDir} = storage;
  const file = join(dataDir, 'search-requests.ndjson');
  const off = await gateway(t, {...storage, debugSearchRequests: false});
  await off.search();
  assert.equal(existsSync(file), false);
  const on = await gateway(t, {...storage, debugSearchRequests: true});
  await on.put('one', {'Title$$string': 'Private indexing payload'});
  assert.equal(existsSync(file), false);
  await on.request('/pages/_search', {method: 'POST', headers: {Authorization: 'Bearer synthetic-header-value'}, body: {query: {query_string: {query: 'jacket'}}}});
  await on.request('/_msearch', {method: 'POST', body: ndjson({index: 'private-index-name'}, {query: {query_string: {query: 'shoes'}}})});
  const text = readFileSync(file, 'utf8');
  const records = text.trim().split('\n').map(JSON.parse);
  assert.deepEqual(records, [
    {operation: '_search', body: {query: {query_string: {query: 'jacket'}}}},
    {operation: '_msearch', body: {query: {query_string: {query: 'shoes'}}}},
  ]);
  for (const value of ['synthetic-url-value', 'synthetic-header-value', 'synthetic-secret-value', 'private-index-name', 'Private indexing payload', 'synthetic-development-key']) assert.equal(text.includes(value), false, value);
});

test('recording redacts names, opaque token values and the service prefix anywhere in accepted bodies', async t => {
  const storage = testStorage(t);
  const {request} = await gateway(t, {...storage, debugSearchRequests: true});
  const token = 'Abc123SyntheticOpaqueCredential987654';
  const query = `jacket "${PREFIX}" "${PREFIX.slice(1)}" "${encodeURIComponent(PREFIX)}" ${token} sk-syntheticshortvalue abcdef1234567890`;
  const reply = await request('/pages/_search', {method: 'POST', body: {
    query: {query_string: {query}},
    facets: {key: {filter: {match_all: {}}}, values: {filter: {term: {key: 'synthetic-key-value', servicePrefix: 'synthetic-prefix', service_prefix: 'synthetic-prefix-2', payload: token}}}},
  }});
  assert.equal(reply.status, 200);
  const text = readFileSync(join(storage.dataDir, 'search-requests.ndjson'), 'utf8');
  for (const value of [PREFIX, 'synthetic-development-key', token, 'synthetic-key-value', 'synthetic-prefix', 'synthetic-prefix-2', 'sk-syntheticshortvalue', 'abcdef1234567890', encodeURIComponent(PREFIX)]) assert.equal(text.includes(value), false);
  const record = JSON.parse(text);
  assert.equal(record.body.facets.key, '[redacted]');
  assert.deepEqual(record.body.facets.values.filter.term, {key: '[redacted]', servicePrefix: '[redacted]', service_prefix: '[redacted]', payload: '[redacted]'});
  assert.match(record.body.query.query_string.query, /jacket/);
  assert.match(record.body.query.query_string.query, /\[redacted\]/);
});

test('rejected search bodies and partially valid multi-search batches are never retained', async t => {
  const storage = testStorage(t);
  const {request} = await gateway(t, {...storage, debugSearchRequests: true});
  for (const body of ['{broken', {password: 'synthetic-rejected'}, {query: {unknown: {}}}, {query: {query_string: {query: '('.repeat(5000) + 'x' + ')'.repeat(5000)}}}]) {
    assert.equal((await request('/pages/_search', {method: 'POST', body})).status, 400);
  }
  assert.equal((await request('/pages/_search?scroll=1m', {method: 'POST', body: {}})).status, 501);
  assert.equal((await request('/_msearch', {method: 'POST', body: ndjson({}, {}, {}, {query: {unknown: {}}})})).status, 400);
  assert.equal((await request('/_msearch', {method: 'POST', body: ndjson({}, {}) + '{}\n'})).status, 400);
  assert.equal(existsSync(join(storage.dataDir, 'search-requests.ndjson')), false);
});
