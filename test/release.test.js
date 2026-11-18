import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdirSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import pkg from '../package.json' with {type: 'json'};
import {buildRelease, windowsTar} from '../scripts/build-release.mjs';
import {dataVersion} from '../src/store.js';
import {testStorage} from './helpers.js';

const repo = join(import.meta.dirname, '..');

function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8', windowsHide: true});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

async function pollHealth(child, stdout, stderr) {
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    assert.ok(child.pid && child.exitCode === null && child.signalCode === null, stderr() || 'Packaged process exited before becoming healthy');
    const port = /listening on http:\/\/127\.0\.0\.1:(\d+);/.exec(stdout())?.[1];
    if (port) {
      const url = `http://127.0.0.1:${port}/health`;
      const response = await fetch(url, {signal: AbortSignal.timeout(500)}).catch(() => null);
      if (response) return response;
    }
    await delay(50);
  }
  assert.fail(stderr() || 'Timed out polling packaged /health');
}

test('release ZIP contains only runtime files and starts from an extracted directory', async t => {
  const {dataDir: scratch} = testStorage(t);
  const out = join(scratch, 'dist');
  const unpacked = join(scratch, 'unpacked release');
  const started = Date.now();
  const {archive, manifest} = buildRelease(out);
  const file = `lda-find-${pkg.version}.zip`;
  const bytes = readFileSync(archive);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const commit = process.env.LDA_RELEASE_COMMIT || run('git', ['-C', repo, 'rev-parse', 'HEAD']).trim();
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')), manifest);
  assert.deepEqual(manifest, {
    module: 'find', product: 'LDA Local Find', version: pkg.version, minNode: '24', dataVersion,
    file, sha256, size: bytes.length, commit, builtAt: manifest.builtAt,
  });
  assert.ok(Date.parse(manifest.builtAt) >= started && Date.parse(manifest.builtAt) <= Date.now());
  assert.equal(readFileSync(join(out, 'SHA256SUMS'), 'utf8'), `${sha256}  ${file}\n`);
  assert.deepEqual(readdirSync(out).sort(), ['SHA256SUMS', file, 'manifest.json'].sort());

  mkdirSync(unpacked);
  if (process.platform === 'win32') run(windowsTar, ['-xf', archive, '-C', unpacked]);
  else run('unzip', ['-q', archive, '-d', unpacked]);
  assert.deepEqual(readdirSync(unpacked).sort(), ['LEGAL-NOTICE.md', 'LICENSE.md', 'NOTICE', 'package.json', 'scripts', 'src']);
  assert.deepEqual(readdirSync(join(unpacked, 'scripts')), ['service-xml.js']);
  for (const name of ['LEGAL-NOTICE.md', 'LICENSE.md', 'NOTICE']) {
    assert.deepEqual(readFileSync(join(unpacked, name)), readFileSync(join(repo, name)));
  }

  const runtimeRoot = join(scratch, 'external runtime');
  const initialize = spawnSync(process.execPath, [join(unpacked, 'scripts', 'service-xml.js'), 'init'], {
    input: JSON.stringify({runtimeRoot, port: 8088}), encoding: 'utf8', windowsHide: true,
  });
  assert.equal(initialize.status, 0, initialize.stderr);
  const storage = join(runtimeRoot, 'data');
  const windows = process.platform === 'win32';
  const args = [join(unpacked, 'src', 'server.js')];
  const stdio = ['ignore', 'pipe', 'pipe'];
  if (windows) {
    // Windows child.kill terminates immediately. Deliver SIGTERM to the shutdown handler over IPC.
    const relay = `process.once('message', () => {
      process.disconnect();
      process.emit('SIGTERM');
    });
    process.channel.unref();`;
    args.unshift('--import', `data:text/javascript,${encodeURIComponent(relay)}`);
    stdio.push('ipc');
  }
  const child = spawn(process.execPath, args, {
    cwd: unpacked,
    env: {...process.env, HOST: '127.0.0.1', PORT: '0', DATA_ROOT: storage, DATA_DIR: storage,
      SERVICE_PREFIX: '/release-smoke', DEBUG_SEARCH_REQUESTS: '0', LOG_REQUESTS: '0'},
    stdio, windowsHide: true,
  });
  const closed = once(child, 'close').catch(error => [null, error]);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', chunk => {stdout += chunk;});
  child.stderr.setEncoding('utf8').on('data', chunk => {stderr += chunk;});

  try {
    const response = await pollHealth(child, () => stdout, () => stderr);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {product: manifest.module, version: manifest.version, dataVersion: manifest.dataVersion});

    const saved = await fetch(new URL('/release-smoke/pages/article/example', response.url), {
      method: 'PUT', headers: {'Content-Type': 'application/json'}, body: '{"title":"Synthetic release test"}',
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(saved.status, 201);
    await saved.json();
    const state = JSON.parse(readFileSync(join(storage, 'store.json'), 'utf8'));
    assert.equal(state.docs[0].id, 'example');

    const stopped = once(child, 'close', {signal: AbortSignal.timeout(5_000)});
    if (windows) child.send('shutdown');
    else child.kill('SIGTERM');
    assert.deepEqual(await stopped, [0, null], stderr);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
  }
});

test('CI runs both checks and the matching version tag publishes all three assets', () => {
  const ci = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8');
  const release = readFileSync(join(repo, '.github/workflows/release.yml'), 'utf8');
  for (const workflow of [ci, release]) {
    for (const setting of ["node-version: '24'", 'windows-latest', 'npm ci', 'npm test', 'npm run check:clean-room']) {
      assert.ok(workflow.includes(setting), setting);
    }
  }
  assert.equal(pkg.scripts['release:build'], 'node scripts/build-release.mjs');
  assert.match(ci, /pull_request:/);
  for (const setting of ["tags: ['v*']", 'contents: write', '$env:GITHUB_REF_NAME -cne "v$version"', 'npm run release:build',
    'LDA_RELEASE_COMMIT: ${{ github.sha }}', 'gh release create', '"dist/lda-find-$version.zip" dist/SHA256SUMS dist/manifest.json']) {
    assert.ok(release.includes(setting), setting);
  }
});
