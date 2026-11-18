import {copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import pkg from '../package.json' with {type: 'json'};
import {dataVersion} from '../src/store.js';

const repo = resolve(import.meta.dirname, '..');
const windows = process.platform === 'win32';
export const windowsTar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');

// Copy only runtime sources and required notices. Local additions stay out of the ZIP.
const releaseFiles = [
  'package.json', 'LICENSE.md', 'NOTICE', 'LEGAL-NOTICE.md',
  'scripts/service-xml.js',
  'src/errors.js', 'src/fields.js', 'src/precise-json.js', 'src/protocol-routes.js',
  'src/query.js', 'src/response-budget.js', 'src/search-recording.js', 'src/search.js',
  'src/server.js', 'src/statistics.js', 'src/storage-paths.js', 'src/store.js',
  'src/url-options.js', 'src/wildcard.js', 'src/write-options.js',
];

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {cwd, stdio: 'inherit', windowsHide: true, ...options});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

function gitCommit() {
  if (process.env.LDA_RELEASE_COMMIT) return process.env.LDA_RELEASE_COMMIT;
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {cwd: repo, encoding: 'utf8', windowsHide: true});
  return result.status === 0 ? result.stdout.trim() : null;
}

function stageRuntime(content) {
  for (const directory of ['src', 'scripts']) {
    if (!lstatSync(join(repo, directory)).isDirectory()) throw new Error(`Expected a release source directory: ${directory}`);
    mkdirSync(join(content, directory));
  }
  for (const file of releaseFiles) {
    const source = join(repo, file);
    if (!lstatSync(source).isFile()) throw new Error(`Expected a regular release file: ${file}`);
    copyFileSync(source, join(content, file));
  }
  if (Object.keys({...pkg.dependencies, ...pkg.optionalDependencies}).length) {
    const lock = join(content, 'package-lock.json');
    copyFileSync(join(repo, 'package-lock.json'), lock);
    const args = ['ci', '--omit=dev', '--ignore-scripts', '--no-bin-links', '--no-audit', '--no-fund'];
    if (process.env.npm_execpath) run(process.execPath, [process.env.npm_execpath, ...args], content);
    else run(windows ? 'npm.cmd' : 'npm', args, content, {shell: windows});
    rmSync(lock);
  }
}

export function buildRelease(outputDir = join(repo, 'dist')) {
  const {version} = pkg;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Package version is invalid for a CLI release');
  const file = `lda-find-${version}.zip`;
  mkdirSync(outputDir, {recursive: true});
  const dist = realpathSync(outputDir);
  const stage = mkdtempSync(join(dist, '.stage-'));
  try {
    const content = join(stage, 'content');
    mkdirSync(content);
    stageRuntime(content);
    const archive = join(stage, file);
    if (windows) run(windowsTar, ['-a', '-c', '-f', archive, '-C', content, '.'], repo);
    else run('zip', ['-q', '-r', archive, '.'], content);

    const bytes = readFileSync(archive);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const manifest = {module: 'find', product: 'LDA Local Find', version, minNode: '24', dataVersion, file,
      sha256, size: bytes.length, commit: gitCommit(), builtAt: new Date().toISOString()};
    writeFileSync(join(stage, 'SHA256SUMS'), `${sha256}  ${file}\n`);
    writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    for (const name of [file, 'SHA256SUMS', 'manifest.json']) renameSync(join(stage, name), join(dist, name));
    return {archive: join(dist, file), manifest};
  } finally {
    if (dirname(realpathSync(stage)) !== dist) throw new Error('Unsafe release staging path');
    rmSync(stage, {recursive: true, force: true});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const {archive} = buildRelease(process.argv[2]);
    console.log(`Built ${archive}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
