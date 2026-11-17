import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {gateway, testStorage} from './helpers.js';

const trackReply = '{"status":"ok","track_id":"local-noop","track_uuid":"00000000-0000-0000-0000-000000000000","track_sid":"00000000-0000-0000-0000-000000000000"}';
const event = {q: 'synthetic coat', query: {hits: 1, took: 2, results: ['Synthetic_Page/one']}, tags: ['language:en', 'site:synthetic']};
const suggestionPaths = ['_didyoumean?query=zzqxnothing', '_spellcheck?query=zzqxnothing', '_autocomplete?prefix=synthetic'];

for (const path of suggestionPaths) {
  test(`Statistics ${path.split('?')[0]} returns the SDK empty-hits envelope`, async t => {
    const {request, put} = await gateway(t);
    await put('one', {'Title$$string': 'synthetic coat'});
    for (const index of ['pages', 'other', 'missing']) {
      const reply = await request(`/${index}/${path}&size=5&hits_cutoff=0&cutoff=0.8&tags=language%3Aen%2Csite%3Asynthetic`);
      assert.equal(reply.status, 200);
      assert.equal(reply.text, '{"status":"ok","hits":[]}');
      assert.match(reply.headers.get('content-type'), /^application\/json/);
      assert.equal(reply.headers.get('cache-control'), 'no-store');
    }
  });
}

test('Statistics query tracking accepts SDK POST paths and discards optional metadata', async t => {
  const {request} = await gateway(t);
  for (const path of ['_track/', '_track', '_track/synthetic-id', '_track/encoded%2Fid']) {
    const reply = await request(`/pages/${path}?sid=synthetic-session&uuid=synthetic-user`, {
      method: 'POST',
      body: {...event, ip: '192.0.2.1', timestamp: '2026-11-17T01:02:03Z', additionaltrackinformation: {source: 'synthetic'}},
    });
    assert.equal(reply.status, 200);
    assert.equal(reply.text, trackReply);
    assert.equal(reply.text.includes('synthetic'), false);
  }
  const empty = await request('/missing/_track/', {method: 'POST', body: {q: 'zzqxnothing', query: {hits: 0, took: 0, results: null}, tags: null}});
  assert.equal(empty.status, 200);
  assert.equal(empty.text, trackReply);
});

test('Statistics hit tracking accepts SDK GET options with the TrackHit reply', async t => {
  const {request} = await gateway(t);
  const reply = await request('/pages/_track?id=synthetic-id&q=synthetic%20coat&hit.id=Synthetic_Page%2Fone&hit.pos=1&tags=language%3Aen&timestamp=2026-11-17T01%3A02%3A03Z');
  assert.equal(reply.status, 200);
  assert.equal(reply.text, '{"status":"ok","track_id":"local-noop"}');
});

test('Statistics retain the full prefix, concrete index and exact route/method boundaries', async t => {
  const {request} = await gateway(t);
  for (const path of [...suggestionPaths, '_track']) {
    assert.equal((await request(`/pages/${path}`, {prefixed: false})).status, 403);
    assert.equal((await request(`/wrong-key/pages/${path}`, {prefixed: false})).status, 403);
    for (const index of ['_all', '_reserved', 'pages,other', '*', 'page*']) {
      assert.equal((await request(`/${index}/${path}`)).status, 400);
    }
  }
  assert.equal((await request('/pages,other/_track/', {method: 'POST', body: event})).status, 400);
  for (const path of ['/_didyoumean?query=x', '/pages/_didyoumean/extra?query=x', '/pages/_stats/totals', '/pages/_gdpr', '/pages/_gdpr/sanitizer']) {
    assert.equal((await request(path)).status, 501);
  }
  for (const path of ['_didyoumean', '_spellcheck', '_autocomplete', '_track']) {
    assert.equal((await request(`/pages/${path}`, {method: 'PUT', body: event})).status, 501);
  }
  assert.equal((await request('/pages/_track/id/extra', {method: 'POST', body: event})).status, 501);
});

test('Statistics reject malformed input without creating indices or documents', async t => {
  const {request, server} = await gateway(t);
  for (const path of ['_didyoumean', '_spellcheck', '_autocomplete?prefix=']) {
    assert.equal((await request(`/pages/${path}`)).status, 400);
  }
  for (const body of ['{bad', '[]', '{}', {...event, query: null}, {...event, q: ''}, {...event, query: {hits: -1, took: 0}}, {...event, query: {hits: 0, took: 1.5}}, {...event, query: {hits: 0, took: 0, results: [1]}}]) {
    assert.equal((await request('/pages/_track/', {method: 'POST', body})).status, 400);
  }
  assert.equal(server.store.docs.size, 0);
  assert.equal(server.store.indices.size, 0);
});

test('Statistics never persist or record requests, even with search diagnostics enabled', async t => {
  const storage = testStorage(t); const {dataDir} = storage;
  const {request, put, server} = await gateway(t, {...storage, debugSearchRequests: true, logger: {error() { assert.fail('Statistics must not log'); }}});
  await put('one', {'Title$$string': 'unchanged'});
  const file = join(dataDir, 'store.json');
  const before = readFileSync(file);
  const docs = structuredClone([...server.store.docs]);
  const indices = structuredClone([...server.store.indices]);
  server.store.transaction = () => assert.fail('Statistics must not write');
  for (const path of suggestionPaths) assert.equal((await request(`/missing/${path}`)).status, 200);
  assert.equal((await request('/missing/_track?q=private-synthetic-value')).status, 200);
  for (const id of ['', 'synthetic-id', '_search', '_msearch']) {
    assert.equal((await request(`/missing/_track/${id}`, {method: 'POST', body: event})).status, 200);
  }
  assert.deepEqual(readFileSync(file), before);
  assert.deepEqual(readdirSync(dataDir), ['store.json']);
  assert.deepEqual([...server.store.docs], docs);
  assert.deepEqual([...server.store.indices], indices);
});
