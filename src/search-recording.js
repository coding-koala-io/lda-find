import {mkdirSync, lstatSync, openSync, closeSync, writeFileSync, constants} from 'node:fs';
import {join, resolve} from 'node:path';
import {parse, stringify} from './precise-json.js';
import {checkStoragePaths} from './storage-paths.js';

// Opt-in local diagnostics: body only, never URLs, headers, metadata or writes.
const sensitive = /key|password|secret|token|authorization|service.?(?:url|prefix)|connection.?string/i;
// Conservative token recognition deliberately over-redacts long opaque search words.
const keyLike = /\b(?:Bearer\s+\S+|(?:sk|pk|api|key|token)[-_][A-Za-z0-9_./+=-]+)|[A-Za-z0-9_+/=-]{16,}|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi;
function redactor(servicePrefix) {
  const prefixes = [...new Set([servicePrefix, ...servicePrefix.split('/').filter(Boolean)].filter(Boolean).flatMap(value => [value, decodeURIComponent(value), encodeURIComponent(value)]))].sort((a, b) => b.length - a.length);
  const cleanText = value => {
    for (const prefix of prefixes) value = value.split(prefix).join('[redacted]');
    return value.replace(keyLike, '[redacted]');
  };
  function redact(value) {
    if (typeof value === 'string') return cleanText(value);
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [cleanText(key), sensitive.test(key) ? '[redacted]' : redact(item)]));
  }
  return redact;
}

export function searchRecorder({enabled, directory, servicePrefix = '', logger = console}) {
  if (!enabled) return () => {};
  const redact = redactor(servicePrefix);
  directory = resolve(directory);
  const file = join(directory, 'search-requests.ndjson');
  return (operation, text) => {
    if (!['_search', '_msearch'].includes(operation)) return;
    try {
      const bodies = operation === '_search' ? [parse(text || '{}')] : text.trim().split(/\r?\n/).filter((_, index) => index % 2 === 1).map(parse);
      checkStoragePaths(directory);
      mkdirSync(directory, {recursive: true});
      checkStoragePaths(directory);
      let size = 0;
      try {
        const stat = lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Recording must be a regular file');
        size = stat.size;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const data = bodies.map(body => stringify({operation, body: redact(body)}) + '\n').join('');
      if (size + Buffer.byteLength(data) > 10 * 1024 * 1024) return;
      const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { writeFileSync(fd, data); } finally { closeSync(fd); }
    } catch { logger.error('LDA Local Find could not record a search body'); }
  };
}
