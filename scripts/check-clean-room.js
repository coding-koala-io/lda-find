import {readdirSync, lstatSync, openSync, readSync, closeSync} from 'node:fs';
import {join, resolve, relative} from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';

const binary = /\.(?:dll|exe|pdb|so|dylib|node|wasm|nupkg|zip|7z|tar|gz|cache|bin|class|jar|pyc)$/i;
const capture = /(?:request|response|capture|replay|traffic|recording).*(?:\.jsonl?|\.ndjson|\.har|\.log|\.txt)$|\.(?:ndjson|har|pcap|pcapng)$|^round\d+.*\.json$/i;
const diagnostic = /^(?:\.tmp|\.test-runtime|\.recording-check)$|(?:sdk|query-shape|content-projection)-probe/i;

/** Inspect ignored files too. Only Git's internal object database is outside scope. */
export function checkCleanRoom(root) {
  const findings = [];
  const report = (path, reason) => findings.push({path: relative(root, path).replaceAll('\\', '/'), reason});
  function visit(directory) {
    for (const name of readdirSync(directory)) {
      if (directory === root && name === '.git') continue;
      const path = join(directory, name); const stat = lstatSync(path);
      if (stat.isSymbolicLink()) { report(path, 'link prevents whole-folder inspection'); continue; }
      if (stat.isDirectory()) {
        if (/^\.(?:aws|ssh)$/.test(name)) { report(path, 'private configuration'); continue; }
        if (diagnostic.test(name)) report(path, 'diagnostic folder');
        visit(path); continue;
      }
      if (!stat.isFile()) { report(path, 'non-regular file'); continue; }
      if (binary.test(name)) { report(path, 'binary/build artifact'); continue; }
      if (capture.test(name)) { report(path, 'request/replay capture'); continue; }
      if (/\.(?:cs|csproj|fsproj)$|^NuGet\.Config$/i.test(name)) { report(path, 'SDK probe artifact'); continue; }
      // Credential files are refused by name and never opened.
      if (/^\.env(?:\.|$)|credential|token|secret|\.pem$|\.pfx$|\.key$/i.test(name)) { report(path, 'private configuration'); continue; }
      const fd = openSync(path, 'r'); const buffer = Buffer.alloc(8192);
      try {
        const decoder = new TextDecoder('utf-8', {fatal: true}); let length;
        while ((length = readSync(fd, buffer, 0, buffer.length, null))) {
          const bytes = buffer.subarray(0, length);
          if (bytes.includes(0)) throw new Error();
          decoder.decode(bytes, {stream: true});
        }
        decoder.decode();
      } catch { report(path, 'binary content'); } finally { closeSync(fd); }
    }
  }
  visit(root);
  return findings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const findings = checkCleanRoom(resolve(process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url))));
  for (const item of findings) console.error(`${item.reason}: ${item.path}`);
  console.log(`Whole-folder clean-room check: ${findings.length ? 'FAIL' : 'PASS'} (${findings.length} findings)`);
  if (findings.length) process.exitCode = 1;
}
