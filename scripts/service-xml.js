import {mkdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {checkStoragePaths, storageDirectory} from '../src/storage-paths.js';

export const SERVICE_ID = 'LdaFind';
const defaultRuntimeRoot = 'C:\\ProgramData\\Coding Koala\\Local Developer Accelerator\\Find';

const pathsFor = value => path.win32.isAbsolute(value) && !value.startsWith('/') ? path.win32 : path;
const xml = value => String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'}[char]));

function absolutePath(label, value) {
  if (typeof value !== 'string' || !pathsFor(value).isAbsolute(value) || /[\x00-\x1f"%]/.test(value)) {
    throw new Error(`${label} must be an absolute path without quotes, control characters or % expansion`);
  }
}

function runtimePaths(runtimeRoot) {
  absolutePath('RuntimeRoot', runtimeRoot);
  const paths = pathsFor(runtimeRoot);
  const root = paths.normalize(runtimeRoot);
  const dataDir = paths.join(root, 'data');
  if (dataDir.includes('..')) throw new Error('RuntimeRoot must be usable as an approved storage root without ..');
  return {dataDir, wrapperLogs: paths.join(root, 'service', 'logs')};
}

export function generateServiceXml({nodePath, repoRoot, runtimeRoot = defaultRuntimeRoot, port = 8088}) {
  absolutePath('nodePath', nodePath);
  absolutePath('repoRoot', repoRoot);
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('Port must be an integer from 1 to 65535');
  const {dataDir, wrapperLogs} = runtimePaths(runtimeRoot);
  const server = pathsFor(repoRoot).join(repoRoot, 'src', 'server.js');
  const env = {
    PORT: Number(port),
    HOST: '127.0.0.1',
    DATA_ROOT: dataDir,
    DATA_DIR: dataDir,
    SERVICE_PREFIX: '/local-development-key',
    DEBUG_SEARCH_REQUESTS: '0',
    LOG_REQUESTS: '0',
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<service>
  <id>${SERVICE_ID}</id>
  <name>Local Developer Accelerator — Find (development only)</name>
  <description>LDA Local Find. Development use only. Built by Coding Koala.</description>
  <executable>${xml(nodePath)}</executable>
  <arguments>${xml(`"${server}"`)}</arguments>
  <workingdirectory>${xml(repoRoot)}</workingdirectory>
${Object.entries(env).map(([name, value]) => `  <env name="${name}" value="${xml(value)}" />`).join('\n')}
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="10 sec" />
  <onfailure action="restart" delay="10 sec" />
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <logpath>${xml(wrapperLogs)}</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>5</keepFiles>
  </log>
  <serviceaccount>
    <domain>NT AUTHORITY</domain>
    <user>LocalService</user>
  </serviceaccount>
</service>
`;
}

export function initializeRuntime({runtimeRoot}) {
  const {dataDir} = runtimePaths(runtimeRoot);
  const directory = storageDirectory(dataDir, dataDir);
  checkStoragePaths(directory);
  // The elevated CLI creates the log directories and grants LocalService access.
  mkdirSync(directory, {recursive: true});
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = JSON.parse(readFileSync(0, 'utf8').replace(/^\uFEFF/, ''));
    if (process.argv[2] === 'init') initializeRuntime(options);
    else if (process.argv[2] === 'xml') process.stdout.write(generateServiceXml(options));
    else throw new Error('Expected xml or init command');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
