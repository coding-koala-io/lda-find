import test from 'node:test';
import assert from 'node:assert/strict';
import {gateway, ndjson, ids} from './helpers.js';

const path = '/pages/Synthetic_Page/one';
const metadata = {_index: 'pages', _type: 'Synthetic_Page', _id: 'one'};

test('E02/E08: metadata projections override source collisions without changing submitted source', async t => {
  const {request, search} = await gateway(t);
  const source = {_parent: 'source-value', _id: 'source-id', _index: 'source-index', _type: 'source-type', _version: 'source-version', value: 'kept'};
  const fields = ['_parent', '_id', '_index', '_type', '_version', 'value'];
  const expected = {...metadata, _parent: 'actual', _version: 1, value: 'kept'};
  assert.equal((await request(`${path}?parent=actual`, {method: 'PUT', body: source})).status, 201);
  assert.deepEqual((await request(`${path}?fields=_parent`)).data.fields, {_parent: 'actual'});
  assert.deepEqual((await request(`${path}?fields=${fields.join(',')}`)).data.fields, expected);
  assert.deepEqual((await search({fields})).hits.hits[0].fields, expected);
  assert.deepEqual((await request(path)).data._source, source);
  assert.deepEqual((await search()).hits.hits[0]._source, source);

  const withoutParent = '/pages/Synthetic_Page/without-parent';
  await request(withoutParent, {method: 'PUT', body: {_parent: 'source-only'}});
  assert.deepEqual((await request(`${withoutParent}?fields=_parent`)).data.fields, {});
  assert.deepEqual((await request(withoutParent)).data._source, {_parent: 'source-only'});
});

test('E06: the core profile always rejects field updates with the specified 501 and no mutation', async t => {
  const {request, search} = await gateway(t);
  const source = {'DisplayLabel$$string': 'Original', 'Count$$number': 5, 'Tags$$strings': ['kept']};
  await request(`${path}?parent=actual&ttl=10000`, {method: 'PUT', body: source});
  const before = (await request(path)).data;
  const operations = ['setnamedfieldvalue', 'increasenamedfieldbyvalue', 'addvaluetonamedfield', 'removevaluefromnamedfieldbyvalue'];
  for (const target of [path, '/pages/Synthetic_Page/missing']) {
    for (const script of operations) {
      const result = await request(`${target}/_update?refresh=true&parent=other&language_routing=fr`, {
        method: 'POST', body: {script, lang: 'native', params: {field_name: 'DisplayLabel$$string', value: 'Changed'}},
      });
      assert.equal(result.status, 501);
      assert.match(result.headers.get('content-type'), /^application\/json\b/);
      assert.deepEqual(result.data, {
        error: 'E06 field updates are not enabled in this Local Find profile. Reindex the complete document, or enable explicit field-update support.',
        status: '501',
      });
      assert.deepEqual((await request(path)).data, before);
      assert.deepEqual((await request(`${path}?fields=_parent`)).data.fields, {_parent: 'actual'});
      assert.equal((await request('/pages/Synthetic_Page/missing')).status, 404);
    }
  }
  assert.deepEqual(ids(await search()), ['one']);
  assert.deepEqual((await request('/pages/specific-languages/get')).data, []);
});

test('E01/E03: version preconditions protect replacements and deletes, including missing targets', async t => {
  const {request} = await gateway(t);
  assert.equal((await request(`${path}?version=1`, {method: 'PUT', body: {value: 'absent'}})).status, 409);
  assert.equal((await request(path, {method: 'PUT', body: {value: 'first'}})).data._version, 1);
  assert.equal((await request(`${path}?version=2`, {method: 'PUT', body: {value: 'stale'}})).status, 409);
  assert.equal((await request(`${path}?version=1`, {method: 'PUT', body: {value: 'second'}})).data._version, 2);
  assert.equal((await request(`${path}?version=1`, {method: 'DELETE'})).status, 409);
  assert.deepEqual((await request(path)).data._source, {value: 'second'});
  assert.equal((await request(`${path}?version=2`, {method: 'DELETE'})).data.found, true);
  assert.equal((await request(`${path}?version=2`, {method: 'DELETE'})).status, 409);
  assert.equal((await request(path, {method: 'DELETE'})).status, 404);
});

test('E01/E04: single-node controls, parent metadata and generated writes are accepted', async t => {
  const {request, search} = await gateway(t);
  await request('/pages/_refresh/off', {method: 'POST'});
  for (const consistency of ['one', 'quorum', 'all']) {
    const options = new URLSearchParams({routing: 'a', refresh: 'false', consistency, replication: consistency === 'one' ? 'async' : 'sync', parent: 'parent-a', timeout: '1.5s', language_routing: 'en'});
    const result = await request(`${path}?${options}`, {method: 'PUT', body: {value: consistency}});
    assert.ok([200, 201].includes(result.status), result.text);
    assert.deepEqual(ids(await search({query: {term: {_parent: 'parent-a'}}})), ['one']);
  }
  assert.deepEqual((await request(`${path}?fields=_parent`)).data.fields, {_parent: 'parent-a'});
  assert.deepEqual((await request('/pages/specific-languages/get')).data, ['en']);
  const generated = await request('/pages/Synthetic_Page/?refresh=true&consistency=all&ttl=10000', {method: 'POST', body: {value: 'generated'}});
  assert.equal(generated.status, 201);
  assert.equal((await request(`/pages/Synthetic_Page/${generated.data._id}`)).status, 200);
  assert.equal((await request(`${path}?version=3&routing=a&refresh=wait_for&consistency=all&parent=parent-a&replication=sync&language_routing=en`, {method: 'DELETE'})).status, 200);
  assert.equal((await search()).hits.total, 1);
});

test('E04: bulk metadata enforces versions, expiry, parent and independent failures in order', async t => {
  let now = Date.parse('2026-11-17T12:00:00Z');
  const {request, search} = await gateway(t, {now: () => now});
  const result = await request('/_bulk?refresh=wait_for', {method: 'POST', body: ndjson(
    {index: {...metadata, _routing: 'route', _parent: 'parent', _ttl: 500, consistency: 'quorum', refresh: false, language_routing: 'en'}}, {value: 1},
    {index: {...metadata, _version: 2}}, {value: 'conflict'},
    {index: {...metadata, _version: 1, _ttl: 1000}}, {value: 2},
    {delete: {...metadata, _version: 1}},
    {create: {...metadata}}, {value: 'duplicate'},
    {index: {...metadata, _id: 'invalid', _ttl: -1}}, {value: 'invalid'},
    {index: {...metadata, _id: 'kept'}}, {value: 'last'},
  )});
  assert.equal(result.status, 200);
  const items = result.data.items.map(item => Object.values(item)[0]);
  assert.deepEqual(items.map(item => item.status ?? 200), [200, 409, 200, 409, 409, 400, 200]);
  assert.equal(items[2]._version, 2);
  assert.deepEqual((await request(path)).data._source, {value: 2});
  assert.deepEqual(ids(await search({query: {term: {_parent: 'parent'}}})), ['one']);
  now += 1000;
  assert.deepEqual(ids(await search()), ['kept']);
  const deletion = await request('/_bulk', {method: 'POST', body: ndjson(
    {delete: {...metadata, _id: 'kept', _version: 1, _parent: 'parent', _routing: 'route', consistency: 'all', refresh: true}},
    {delete: metadata},
  )});
  assert.deepEqual(deletion.data.items.map(item => item.delete.found), [true, false]);
});

test('E01/E02/E07/E08/E09/E10: expired content disappears from every read and cannot be query-deleted twice', async t => {
  let now = Date.parse('2026-11-17T12:00:00Z');
  const {request, search} = await gateway(t, {now: () => now});
  assert.equal((await request(`${path}?ttl=1000`, {method: 'PUT', body: {value: 'temporary'}})).status, 201);
  now += 999;
  assert.equal((await request(path)).status, 200);
  now++;
  assert.equal((await request(path)).status, 404);
  assert.equal((await search()).hits.total, 0);
  assert.deepEqual((await search({facets: {values: {terms: {field: 'value'}}}})).facets.values.terms, []);
  assert.equal((await request('/pages/_count', {method: 'POST', body: {query: {match_all: {}}}})).data.count, 0);
  assert.equal((await request('/pages/_config')).headers.get('documents_used'), '0');
  const multi = await request('/pages/_mget', {method: 'POST', body: {docs: [metadata]}});
  assert.equal(multi.data.docs[0].exists, false);
  assert.equal((await request(`${path}?version=1`, {method: 'PUT', body: {}})).status, 409);
  assert.equal((await request('/pages/_query', {method: 'DELETE', body: {match_all: {}}})).status, 200);
  assert.equal((await request(path, {method: 'DELETE'})).data.found, false);
  assert.equal((await request(path, {method: 'PUT', body: {value: 'new life'}})).data._version, 1);
  now += 100000;
  assert.equal((await request(path)).status, 200);
});

test('E01: replacement resets TTL; rejected options leave source, version and deadline intact', async t => {
  let now = Date.parse('2026-11-17T12:00:00Z');
  const {request} = await gateway(t, {now: () => now});
  await request(`${path}?ttl=1000`, {method: 'PUT', body: {value: 1}});
  for (const options of ['ttl=0', 'ttl=-1', 'ttl=1.5', 'version=0', 'version=9007199254740993', 'refresh=eventually', 'consistency=none', 'replication=other', 'timeout=100ms', 'parent=', 'unknown=true', 'version=1&version=2', 'percolate=*']) {
    const result = await request(`${path}?${options}`, {method: 'PUT', body: {value: 'invalid'}});
    assert.equal(result.status, 400, options);
    assert.equal(typeof result.data.error, 'string');
    assert.equal((await request(path)).data._version, 1);
  }
  now += 1000;
  assert.equal((await request(path)).status, 404);
  await request(`${path}?ttl=1000`, {method: 'PUT', body: {value: 2}});
  now += 500;
  assert.equal((await request(`${path}?version=1`, {method: 'PUT', body: {value: 3}})).data._version, 2);
  now += 10000;
  assert.deepEqual((await request(path)).data._source, {value: 3});
});

test('E04: unsupported result-changing metadata produces one item error without losing adjacent writes', async t => {
  const {request, search} = await gateway(t);
  const result = await request('/_bulk', {method: 'POST', body: ndjson(
    {index: {...metadata, _percolate: '*'}}, {value: 'percolation required'},
    {index: {...metadata, _id: 'kept'}}, {value: 'valid'},
  )});
  assert.equal(result.status, 200);
  assert.equal(result.data.items[0].index.status, 400);
  assert.match(result.data.items[0].index.error, /percolation/);
  assert.deepEqual(ids(await search()), ['kept']);
  const invalidOverall = await request('/_bulk?refresh=eventually', {method: 'POST', body: ndjson({delete: {...metadata, _id: 'kept'}})});
  assert.equal(invalidOverall.status, 400);
  assert.deepEqual(ids(await search()), ['kept']);
});
