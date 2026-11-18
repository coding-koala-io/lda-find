import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs';
import {get} from 'node:http';
import {join} from 'node:path';
import pkg from '../package.json' with {type: 'json'};
import {configuration} from '../src/server.js';
import {dataVersion} from '../src/store.js';
import {gateway, testStorage} from './helpers.js';

const script = join(import.meta.dirname, '..', 'scripts', 'service-xml.js');
const options = {
  nodePath: 'C:\\Node & tools\\node.exe',
  repoRoot: "D:\\CMS & team's <code>",
  runtimeRoot: "C:\\Local & team's <runtime>",
  port: 19088,
};
const decode = value => value.replaceAll('&quot;', '"').replaceAll('&apos;', "'")
  .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const element = (source, name) => decode(new RegExp(`<${name}>(.*?)</${name}>`).exec(source)[1]);

function invoke(command, options, bom = '') {
  const result = spawnSync(process.execPath, [script, command], {
    input: bom + JSON.stringify(options), encoding: 'utf8', windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

test('service XML quotes and escapes paths and configures the loopback service', () => {
  const {status, stdout, stderr} = invoke('xml', options, '\uFEFF');
  assert.equal(status, 0, stderr);
  const expected = {
    id: 'LdaFind',
    executable: options.nodePath,
    arguments: `"${options.repoRoot}\\src\\server.js"`,
    workingdirectory: options.repoRoot,
    logpath: `${options.runtimeRoot}\\service\\logs`,
    startmode: 'Automatic',
    delayedAutoStart: 'true',
    resetfailure: '1 hour',
    stoptimeout: '15 sec',
    sizeThreshold: '10240',
    keepFiles: '5',
    domain: 'NT AUTHORITY',
    user: 'LocalService',
  };
  for (const [name, value] of Object.entries(expected)) assert.equal(element(stdout, name), value);
  assert.match(element(stdout, 'description'), /Built by Coding Koala\./);
  assert.match(stdout, /<log mode="roll-by-size">/);
  assert.equal([...stdout.matchAll(/<onfailure action="restart" delay="10 sec" \/>/g)].length, 3);
  for (const entity of ['&amp;', '&apos;', '&lt;', '&gt;', '&quot;']) assert.ok(stdout.includes(entity));
  const env = Object.fromEntries([...stdout.matchAll(/<env name="([^"]+)" value="([^"]*)"/g)].map(([, name, value]) => [name, decode(value)]));
  assert.deepEqual(env, {
    PORT: '19088', HOST: '127.0.0.1', DATA_ROOT: `${options.runtimeRoot}\\data`, DATA_DIR: `${options.runtimeRoot}\\data`,
    SERVICE_PREFIX: configuration({}).servicePrefix, DEBUG_SEARCH_REQUESTS: '0', LOG_REQUESTS: '0',
  });
});

test('service commands reject unsafe paths and XML rejects invalid ports', () => {
  for (const key of ['nodePath', 'repoRoot', 'runtimeRoot']) {
    for (const bad of ['relative', 'C:\\bad%path', 'C:\\bad"path', 'C:\\bad\npath']) {
      const result = invoke('xml', {...options, [key]: bad});
      assert.equal(result.status, 1);
      assert.match(result.stderr, /absolute path without quotes, control characters or % expansion/);
    }
  }
  for (const port of [0, -1, 65536, 1.5, 'bad']) {
    const result = invoke('xml', {...options, port});
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Port must be an integer/);
  }
  const result = invoke('init', {runtimeRoot: 'relative', port: options.port});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /RuntimeRoot must be an absolute path/);
});

test('init accepts both CLI payloads, creates data only, and preserves existing content', t => {
  const {dataDir} = testStorage(t);
  const runtimeRoot = join(dataDir, "runtime & team's files");
  const first = invoke('init', {...options, runtimeRoot});
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, '');
  assert.deepEqual(readdirSync(runtimeRoot), ['data']);

  const store = join(runtimeRoot, 'data', 'store.json');
  const wrapperLogs = join(runtimeRoot, 'service', 'logs');
  const log = join(wrapperLogs, 'LdaFind.out.log');
  mkdirSync(wrapperLogs, {recursive: true});
  writeFileSync(store, JSON.stringify({version: dataVersion, docs: [], indices: []}));
  writeFileSync(log, 'existing log');
  const before = readFileSync(store);
  const second = invoke('init', {runtimeRoot, port: options.port});
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, '');
  assert.deepEqual(readFileSync(store), before);
  assert.equal(readFileSync(log, 'utf8'), 'existing log');
  assert.deepEqual(readdirSync(runtimeRoot).sort(), ['data', 'service']);
});

test('GET /health exposes only release identity and store version after local request checks', async t => {
  const storage = testStorage(t);
  const {base, request, put} = await gateway(t, {...storage, logRequests: false});
  await put('health-test', {title: 'Synthetic content'});
  const persisted = JSON.parse(readFileSync(join(storage.dataDir, 'store.json'), 'utf8'));

  const result = await request('/health', {prefixed: false, headers: {Origin: 'http://localhost:19088'}});
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, {product: 'find', version: pkg.version, dataVersion: persisted.version});
  assert.match(result.headers.get('content-type'), /^application\/json/);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/health', {prefixed: false, headers: {Origin: 'https://external.invalid'}})).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    get(`${base}/health`, {headers: {Host: 'external.invalid'}}, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await request('/health', {prefixed: false, method: 'POST'})).status, 403);
  assert.equal((await request('/health')).status, 501);
  assert.equal((await request('/pages/_config', {prefixed: false})).status, 403);
});
