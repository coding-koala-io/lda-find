import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pkg from '../package.json' with {type: 'json'};
import {checkCleanRoom} from '../scripts/check-clean-room.js';
import {gateway, ndjson, testStorage} from './helpers.js';

test('whole-folder gate permits only current release files in root dist', t => {
  const {dataDir} = testStorage(t);
  const dist = join(dataDir, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, `lda-find-${pkg.version}.zip`), Buffer.from([0]));
  writeFileSync(join(dist, 'manifest.json'), '{}');
  writeFileSync(join(dist, 'SHA256SUMS'), 'synthetic');
  assert.deepEqual(checkCleanRoom(dataDir), []);

  writeFileSync(join(dist, 'stray.json'), '{}');
  assert.deepEqual(checkCleanRoom(dataDir), [{path: 'dist/stray.json', reason: 'unexpected release output'}]);

  mkdirSync(join(dist, '.stage-ABC123'));
  assert.ok(checkCleanRoom(dataDir).some(item => item.path === 'dist/.stage-ABC123'));
});

test('whole-folder gate detects ignored binaries, disguised binary content, captures and diagnostic folders', t => {
  const {dataDir} = testStorage(t);
  mkdirSync(join(dataDir, 'data/foundation-proof'), {recursive: true});
  writeFileSync(join(dataDir, 'data/foundation-proof/store.json'), '{"version":1,"docs":[],"indices":[]}');
  writeFileSync(join(dataDir, 'original.js'), 'export const synthetic = true;');
  assert.deepEqual(checkCleanRoom(dataDir), []);
  const script = fileURLToPath(new URL('../scripts/check-clean-room.js', import.meta.url));
  assert.equal(spawnSync(process.execPath, [script, dataDir], {windowsHide: true}).status, 0);
  mkdirSync(join(dataDir, '.test-runtime'));
  mkdirSync(join(dataDir, 'nested/dist'), {recursive: true});
  for (const name of ['vendor.dll', 'probe.exe', 'symbols.pdb', 'recorded-request.json', 'sdk-replay.log', 'search-requests.ndjson', 'data/foundation-proof/round6-sdk-report.json']) writeFileSync(join(dataDir, name), 'synthetic');
  writeFileSync(join(dataDir, 'nested/disguised.txt'), Buffer.concat([Buffer.alloc(9000, 32), Buffer.from([77, 90, 0, 1])]));
  writeFileSync(join(dataDir, 'nested/dist/probe.zip'), Buffer.from([0]));
  const findings = checkCleanRoom(dataDir);
  assert.equal(findings.length, 10);
  assert.ok(findings.some(item => item.path === 'nested/dist/probe.zip' && item.reason === 'binary/build artifact'));
  assert.ok(findings.some(item => item.path === 'nested/disguised.txt' && item.reason === 'binary content'));
  assert.ok(findings.some(item => item.path === '.test-runtime'));
  assert.ok(findings.every(item => item.path !== 'data/foundation-proof/store.json'));
  const failed = spawnSync(process.execPath, [script, dataDir], {encoding: 'utf8', windowsHide: true});
  assert.equal(failed.status, 1); assert.match(failed.stdout, /FAIL/);
});

test('large, nested and long-chain text expressions return clean 400s on empty and populated indices', async t => {
  const {request, put} = await gateway(t);
  const expressions = [
    '('.repeat(5000) + 'x' + ')'.repeat(5000),
    Array(15000).fill('x').join(' OR '),
    Array(15000).fill('x').join(' AND '),
    'NOT '.repeat(5000) + 'x',
    'x'.repeat(65537),
    ' '.repeat(65537) + 'x',
    Array(1100).fill('x').join(' OR '),
  ];
  for (const populated of [false, true]) {
    if (populated) await put('one', {'Title$$string': 'x jacket'});
    for (const expression of expressions) {
      for (const query of [{query_string: {query: expression}}, {field: {'Title$$string': {query: expression}}}]) {
        const reply = await request('/pages/_search', {method: 'POST', body: {query}});
        assert.equal(reply.status, 400); assert.equal(reply.data.status, 400);
      }
    }
  }
  for (const query of ['('.repeat(40) + 'x' + ')'.repeat(40), Array(1000).fill('x').join(' OR '), 'x AND (jacket OR shoes)', 'NOT '.repeat(40) + 'absent']) {
    assert.equal((await request('/pages/_search', {method: 'POST', body: {query: {query_string: {query}}}})).status, 200);
  }
  const nested = {query_string: {query: '('.repeat(40) + 'x' + ')'.repeat(40)}};
  assert.equal((await request('/pages/_search', {method: 'POST', body: {query: {bool: {must: [nested]}}}})).status, 400);
  const branches = {or: Array.from({length: 600}, () => ({query_string: {query: 'x OR jacket'}}))};
  assert.equal((await request('/pages/_search', {method: 'POST', body: {query: branches}})).status, 400);
  assert.equal((await request('/_msearch', {method: 'POST', body: ndjson({}, {query: {query_string: {query: expressions[0]}}})})).status, 400);
});

test('URL options reject unknown, duplicate, empty, malformed and unsupported values across protocol routes', async t => {
  const {request, put} = await gateway(t); await put('one', {value: 'one'}); await put('two', {value: 'two'});
  for (const query of ['scroll=1m', 'size=not-a-number', 'size=-1', 'size=1.5', 'size=1001', 'size=', 'size=1&size=2', 'from=NaN', 'from=9007199254740992', 'search_type=', 'search_type=unknown', 'search_type=count&search_type=count', 'q=x', 'unknown=value', 'pretty=true']) {
    const reply = await request(`/pages/_search?${query}`, {method: 'POST', body: {}});
    assert.ok([400, 501].includes(reply.status), query);
  }
  const paged = await request('/pages/_search?size=1&from=1', {method: 'POST', body: {size: 2}});
  assert.equal(paged.status, 200); assert.equal(paged.data.hits.hits.length, 1);
  assert.equal((await request('/pages/_count?size=wrong', {method: 'POST', body: {}})).status, 400);
  for (const [path, method, body] of [
    ['/features?unknown=x', 'GET'], ['/pages/_config?scroll=1m', 'GET'],
    ['/pages/specific-languages/clear?unknown=x', 'DELETE'], ['/pages/_refresh/off?unknown=x', 'POST'],
    ['/pages/specific-languages/get?fields=x', 'GET'],
    ['/pages/Synthetic_ArticlePage/one?unknown=x', 'GET'], ['/pages/_mget?unknown=x', 'POST', {docs: []}],
    ['/_msearch?size=1', 'POST', ndjson({}, {})], ['/pages/_query?delta_indexing=wrong', 'DELETE', {match_all: {}}],
    ['/pages/_autocomplete?prefix=x&size=wrong', 'GET'], ['/pages/_track?q=x&hit.pos=wrong', 'GET'],
    ['/pages/_didyoumean?query=x&unknown=x', 'GET'],
  ]) assert.ok([400, 501].includes((await request(path, {method, body})).status), path);
});
