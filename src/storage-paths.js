import {lstatSync} from 'node:fs';
import {dirname, isAbsolute, join, parse, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';

export const installDirectory = fileURLToPath(new URL('../', import.meta.url));
export const defaultDataRoot = resolve(installDirectory, 'data');

function checkWindowsSpelling(path) {
  if (process.platform !== 'win32') return;
  const ambiguous = path.split(/[\\/]/).some((part, index) => {
    if (!part || part === '.' || index === 0 && /^[a-z]:$/i.test(part)) return false;
    return /[.\s]$|[<>:"|?*]/.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part);
  });
  if (ambiguous) throw new Error('Storage paths must not use ambiguous Windows path components');
}

export function storageDirectory(dataDir, dataRoot) {
  if (dataRoot !== undefined && (typeof dataRoot !== 'string' || !isAbsolute(dataRoot) || dataRoot.includes('..'))) throw new Error('DATA_ROOT must be an absolute approved root without ..');
  if (dataRoot !== undefined) checkWindowsSpelling(dataRoot);
  const root = dataRoot === undefined ? defaultDataRoot : resolve(dataRoot);
  if (dataDir === undefined) return root;
  if (typeof dataDir !== 'string' || !dataDir || dataDir.split(/[\\/]/).includes('..')) throw new Error('DATA_DIR must stay inside the approved storage root without ..');
  checkWindowsSpelling(dataDir);
  const directory = resolve(installDirectory, dataDir);
  const within = relative(root, directory);
  if (isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)) throw new Error('DATA_DIR must stay inside the approved storage root');
  return directory;
}

/** Check every ancestor too: a link above the chosen directory redirects it. */
export function checkStoragePaths(directory) {
  const paths = [];
  for (let path = directory; ; path = dirname(path)) {
    paths.push([path, true]);
    if (path === parse(path).root) break;
  }
  paths.reverse();
  paths.push([join(directory, 'store.json'), false], [join(directory, 'store.json.tmp'), false]);
  const existing = [];
  for (const [path, folder] of paths) {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) throw new Error('Storage symlinks, junctions and reparse points are refused');
    if (folder ? !stat.isDirectory() : !stat.isFile()) throw new Error('Storage paths must be ordinary directories and files');
    existing.push(path);
  }
  // Node exposes junctions/symlinks via lstat, but not every Windows reparse tag.
  // Query the native attribute for all existing components; fail closed if the
  // attribute check cannot run. Paths travel as JSON on stdin, never shell code.
  if (process.platform === 'win32' && existing.length) {
    const script = "$ErrorActionPreference = 'Stop'; $paths = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd()); foreach ($path in $paths) { if (([IO.File]::GetAttributes($path) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 2 } }";
    try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {input: JSON.stringify(existing), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']}); }
    catch { throw new Error('Storage reparse-point check failed; storage is refused'); }
  }
}
