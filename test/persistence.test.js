import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync} from 'node:fs';
import {join, resolve, sep} from 'node:path';
import {gateway, ids} from './helpers.js';
import {page} from './fixtures.js';
import {Store} from '../src/store.js';
import {createServer} from '../src/server.js';
import {configuration} from '../src/server.js';
import {defaultDataRoot} from '../src/storage-paths.js';

function temporary(t, root = join(defaultDataRoot, '.test-runtime')) {
  mkdirSync(root, {recursive: true});
  const directory = mkdtempSync(join(root, 'store-'));
  t.after(() => {
    const target = resolve(directory);
    if (!target.startsWith(root + sep)) throw new Error('Test cleanup escaped its directory');
    rmSync(target, {recursive: true, force: true});
    try { rmdirSync(root); } catch (error) { if (!['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(error.code)) throw error; }
  });
  return directory;
}

test('acknowledged writes, languages, refresh settings, replacements and deletes survive restart', async t => {
  const dataDir = temporary(t); const first = await gateway(t, {dataDir});
  await first.put('one', page(1));
  await first.put('two', page(2));
  await first.request('/pages/Synthetic_ArticlePage/one?language_routing=en', {method: 'PUT', body: page(3)});
  await first.request('/pages/_refresh/off', {method: 'POST'});
  await first.request('/pages/Synthetic_ArticlePage/two', {method: 'DELETE'});
  const stored = JSON.parse(readFileSync(join(dataDir, 'store.json'), 'utf8'));
  assert.equal(stored.version, 1); assert.equal(stored.docs.length, 1);
  const second = await gateway(t, {dataDir});
  const result = await second.search(); assert.deepEqual(ids(result), ['one']);
  assert.deepEqual(result.hits.hits[0]._source, page(3));
  assert.equal((await second.request('/pages/Synthetic_ArticlePage/one')).data._version, 2);
  assert.deepEqual((await second.request('/pages/specific-languages/get')).data, ['en']);
  assert.equal(second.server.store.settings('pages').refresh, false);
  await second.request('/pages/specific-languages/clear', {method: 'DELETE'});
  const third = new Store({dataDir}); assert.deepEqual(third.settings('pages').languages, []);
});

test('unreadable/corrupt store prevents startup instead of silently discarding content', t => {
  const dataDir = temporary(t);
  writeFileSync(join(dataDir, 'store.json'), '{broken');
  assert.throws(() => createServer({host: '127.0.0.1', dataDir}), /Cannot load/);
  writeFileSync(join(dataDir, 'store.json'), JSON.stringify({version: 2, docs: [], indices: []}));
  assert.throws(() => new Store({dataDir}), /Invalid/);
});

test('TTL deadlines and parent metadata survive restart; failed saves roll back conditional mutations', async t => {
  let now = Date.parse('2026-11-17T12:00:00Z');
  const dataDir = temporary(t);
  const first = await gateway(t, {dataDir, now: () => now});
  const path = '/pages/Synthetic_Page/expiring';
  assert.equal((await first.request(`${path}?ttl=1000&parent=parent-a`, {method: 'PUT', body: {value: 1}})).status, 201);
  now += 500;
  const second = await gateway(t, {dataDir, now: () => now});
  assert.deepEqual((await second.request(`${path}?fields=_parent`)).data.fields, {_parent: 'parent-a'});
  assert.equal((await second.request(path)).data._version, 1);
  mkdirSync(join(dataDir, 'store.json.tmp'));
  assert.equal((await second.request(`${path}?version=1&ttl=10000&parent=parent-b`, {method: 'PUT', body: {value: 2}})).status, 500);
  assert.equal((await second.request(`${path}?version=1`, {method: 'DELETE'})).status, 500);
  const retained = second.server.store.get('pages', 'Synthetic_Page', 'expiring');
  assert.equal(retained.version, 1);
  assert.equal(retained.parent, 'parent-a');
  assert.deepEqual(retained.source, {value: 1});
  assert.equal(retained.expiresAt, now + 500);
  rmdirSync(join(dataDir, 'store.json.tmp'));
  now += 500;
  assert.equal((await second.request(path)).status, 404);
  const third = await gateway(t, {dataDir, now: () => now});
  assert.equal((await third.request(path)).status, 404);
  assert.equal((await third.search()).hits.total, 0);
  assert.equal((await third.request(`${path}?ttl=1000&parent=parent-c`, {method: 'PUT', body: {value: 3}})).status, 201);
  assert.equal((await third.request(path)).data._version, 1);
});

test('failed disk persistence returns HTTP 500 and rolls back documents, versions and settings', async t => {
  const dataDir = temporary(t); const {request, put, search, server} = await gateway(t, {dataDir});
  await put('one', page(1));
  // A directory in place of the staging file causes a portable write failure.
  mkdirSync(join(dataDir, 'store.json.tmp'));
  const result = await request('/pages/Synthetic_ArticlePage/one?language_routing=sv', {method: 'PUT', body: page(2)});
  assert.equal(result.status, 500);
  assert.deepEqual(result.data, {error: 'Local storage or request processing failed', status: 500});
  assert.deepEqual((await search()).hits.hits[0]._source, page(1));
  assert.equal(server.store.get('pages', 'Synthetic_ArticlePage', 'one').version, 1);
  assert.deepEqual(server.store.settings('pages').languages, []);
  rmdirSync(join(dataDir, 'store.json.tmp'));
  assert.deepEqual(new Store({dataDir}).get('pages', 'Synthetic_ArticlePage', 'one').source, page(1));
});

test('storage defaults to the install data root; traversal and outside absolute paths require explicit root approval', t => {
  assert.equal(new Store().dataDir, defaultDataRoot);
  const outside = temporary(t, resolve('.test-runtime'));
  for (const dataDir of ['../outside', './data/../outside', outside, defaultDataRoot + '-sibling']) {
    assert.throws(() => new Store({dataDir}), /approved storage root|without \.\./);
  }
  assert.throws(() => new Store({dataRoot: `${outside}/../other`}), /DATA_ROOT/);
  assert.throws(() => new Store({dataRoot: outside + '..'}), /DATA_ROOT/);
  assert.throws(() => new Store({dataRoot: 'relative-root'}), /DATA_ROOT/);
  const approved = new Store({dataRoot: outside});
  approved.transaction(() => approved.put('pages', 'Synthetic_Page', 'one', {value: 1}));
  assert.equal(new Store({dataDir: outside, dataRoot: outside}).select().length, 1);
  assert.equal(configuration({DATA_ROOT: outside}).dataRoot, outside);
  assert.equal(configuration({DATA_DIR: outside}).dataDir, outside);
  if (process.platform === 'win32') {
    for (const part of ['.. ', 'nested.', 'NUL', 'file:stream']) assert.throws(() => new Store({dataDir: join(defaultDataRoot, part)}), /Windows path/);
  }
});

function linkOrSkip(t, target, path, type) {
  try { symlinkSync(target, path, type); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
    t.skip(`OS refused to create the ${type} link (${error.code})`); return false;
  }
  t.after(() => { try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; } });
  return true;
}

test('a pre-existing symlinked temp file is refused without touching its target or memory', async t => {
  const dataDir = temporary(t); const outside = temporary(t);
  const target = join(outside, 'untouched.json'); writeFileSync(target, 'untouched');
  const {server, put, request} = await gateway(t, {dataDir});
  await put('one', {'Value$$long': 1});
  if (!linkOrSkip(t, target, join(dataDir, 'store.json.tmp'), 'file')) return;
  const response = await request('/pages/Synthetic_ArticlePage/one', {method: 'PUT', body: {'Value$$long': 2}});
  assert.equal(response.status, 500);
  assert.equal(readFileSync(target, 'utf8'), 'untouched');
  assert.equal(server.store.select()[0].source['Value$$long'], 1);
  assert.throws(() => new Store({dataDir}), /symlinks|reparse/);
});

test('exclusive temp creation refuses an existing ordinary staging file', async t => {
  const dataDir = temporary(t); const {request, server} = await gateway(t, {dataDir});
  writeFileSync(join(dataDir, 'store.json.tmp'), 'stale');
  assert.equal((await request('/pages/Synthetic_ArticlePage/one', {method: 'PUT', body: {value: 1}})).status, 500);
  assert.equal(readFileSync(join(dataDir, 'store.json.tmp'), 'utf8'), 'stale');
  assert.equal(server.store.select().length, 0);
});

test('storage refuses directory links/junctions including an ancestor of the selected folder', t => {
  const root = temporary(t); const target = temporary(t); const linked = join(root, 'linked');
  if (!linkOrSkip(t, target, linked, process.platform === 'win32' ? 'junction' : 'dir')) return;
  for (const dataDir of [linked, join(linked, 'nested')]) assert.throws(() => new Store({dataDir}), /symlinks|reparse/);
  assert.throws(() => new Store({dataRoot: linked}), /symlinks|reparse/);
});

test('storage refuses a linked store file', t => {
  const dataDir = temporary(t); const target = temporary(t);
  const file = join(target, 'store.json'); writeFileSync(file, '{"version":1,"docs":[],"indices":[]}');
  if (!linkOrSkip(t, file, join(dataDir, 'store.json'), 'file')) return;
  assert.throws(() => new Store({dataDir}), /symlinks|reparse/);
});

test('storage rechecks a directory linked after startup before writing', async t => {
  const root = temporary(t); const target = temporary(t); const dataDir = join(root, 'storage');
  const {request, server} = await gateway(t, {dataDir});
  if (!linkOrSkip(t, target, dataDir, process.platform === 'win32' ? 'junction' : 'dir')) return;
  assert.equal((await request('/pages/Synthetic_ArticlePage/one', {method: 'PUT', body: {value: 1}})).status, 500);
  assert.equal(server.store.select().length, 0);
  assert.throws(() => readFileSync(join(target, 'store.json')), {code: 'ENOENT'});
});

test('prototype-shaped document fields and identities are stored and projected as data', async t => {
  const dataDir = temporary(t); const {request, put, search} = await gateway(t, {dataDir});
  const source = JSON.parse('{"__proto__":{"polluted":"no"},"Constructor$$string":"safe","Tags$$strings":[]}');
  await put('_doc', source, {index: 'constructor', type: 'prototype'});
  const path = '/constructor/prototype/_doc';
  assert.equal((await request(path)).status, 200);
  assert.deepEqual((await search({fields: ['__proto__', 'Tags$$strings']}, '/constructor/_search')).hits.hits[0].fields, {['__proto__']: {polluted: 'no'}, 'Tags$$strings': []});
  assert.equal({}.polluted, undefined);
  assert.equal((await request(path, {method: 'DELETE'})).status, 200);
});
