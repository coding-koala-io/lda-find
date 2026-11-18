import {mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {HttpError, object} from './errors.js';
import {clone, parse, stringify} from './precise-json.js';
import {storageDirectory, checkStoragePaths} from './storage-paths.js';

const identity = (index, type, id) => JSON.stringify([index, type, id]);
export const dataVersion = 1;
export const defaultLimits = Object.freeze({indexDocuments: 10000, storeDocuments: 25000, indexBytes: 64 * 1024 * 1024, storeBytes: 128 * 1024 * 1024, indices: 128});

/** One process owns a store. A completed write is visible and saved before acknowledgement. */
export class Store {
  constructor({dataDir, dataRoot, now = Date.now, limits = {}} = {}) {
    this.now = now;
    this.limits = {...defaultLimits, ...limits};
    for (const [name, value] of Object.entries(this.limits)) if (!(name in defaultLimits) || !Number.isSafeInteger(value) || value < 1 || value > defaultLimits[name]) throw new Error('Store limits must be positive integers no greater than the defaults');
    this.encoded = new WeakMap();
    this.dataDir = storageDirectory(dataDir === ':memory:' ? undefined : dataDir, dataRoot);
    this.docs = new Map();
    this.indices = new Map();
    if (dataDir === ':memory:') return;
    checkStoragePaths(this.dataDir);
    this.file = join(this.dataDir, 'store.json');
    let state;
    try {
      if (statSync(this.file).size > this.limits.storeBytes) throw new Error('Stored data exceeds the store byte quota');
      state = parse(readFileSync(this.file, 'utf8'));
    }
    catch (error) { if (error.code === 'ENOENT') return; throw new Error('Cannot load LDA Local Find data; repair or move the store before starting', {cause: error}); }
    if (state?.version !== dataVersion || !Array.isArray(state.docs) || !Array.isArray(state.indices)) throw new Error('Invalid LDA Local Find store format');
    for (const [index, settings] of state.indices) {
      if (typeof index !== 'string' || !Array.isArray(settings.languages) || !settings.languages.every(value => typeof value === 'string') || typeof settings.refresh !== 'boolean') throw new Error('Invalid stored index');
      this.indices.set(index, settings);
    }
    for (const doc of state.docs) {
      this.validateIdentity(doc.index, doc.type, doc.id);
      object(doc.source, 'Stored source');
      if (!Number.isSafeInteger(doc.version) || doc.version < 1) throw new Error('Invalid stored version');
      if (doc.expiresAt !== undefined && (!Number.isSafeInteger(doc.expiresAt) || doc.expiresAt < 0)) throw new Error('Invalid stored expiry');
      if (doc.parent !== undefined && (typeof doc.parent !== 'string' || !doc.parent.length)) throw new Error('Invalid stored parent');
      const key = identity(doc.index, doc.type, doc.id);
      if (this.docs.has(key)) throw new Error('Duplicate stored identity');
      this.docs.set(key, doc);
    }
    this.checkCapacity();
  }

  // Cache immutable document records: subsequent saves never serialize unchanged sources.
  encode(doc) {
    let encoded = this.encoded.get(doc);
    if (!encoded) {
      const text = stringify(doc);
      encoded = {text, bytes: Buffer.byteLength(text)};
      this.encoded.set(doc, encoded);
    }
    return encoded;
  }

  checkCapacity(candidate, candidateSettings) {
    const indices = new Map(this.indices);
    if (candidate) indices.set(candidate.index, candidateSettings ?? this.settings(candidate.index));
    const usage = new Map([...indices].map(([index, settings]) => [index, {count: 0, bytes: Buffer.byteLength(stringify([index, settings])) + 1}]));
    const replacement = candidate && identity(candidate.index, candidate.type, candidate.id);
    let count = 0; let bytes = 39; // Snapshot framing, including both arrays.
    const add = doc => {
      if (!usage.has(doc.index)) usage.set(doc.index, {count: 0, bytes: 0});
      const item = usage.get(doc.index);
      item.count++; item.bytes += this.encode(doc).bytes + 1; count++;
    };
    const now = this.now();
    for (const [key, doc] of this.docs) if (key !== replacement && this.live(doc, now)) add(doc);
    if (candidate) add(candidate);
    if (usage.size > this.limits.indices) throw new HttpError(413, 'Store index quota exceeded');
    for (const item of usage.values()) {
      if (item.count > this.limits.indexDocuments) throw new HttpError(413, 'Index document quota exceeded');
      if (item.bytes > this.limits.indexBytes) throw new HttpError(413, 'Index byte quota exceeded');
      bytes += item.bytes;
    }
    if (count > this.limits.storeDocuments) throw new HttpError(413, 'Store document quota exceeded');
    if (bytes > this.limits.storeBytes) throw new HttpError(413, 'Store byte quota exceeded');
  }

  validateIdentity(index, type, id) {
    for (const value of [index, type, id]) if (typeof value !== 'string' || !value.length) throw new HttpError(400, 'Index, type and ID must be nonempty strings');
    if ([index, type].some(value => value.startsWith('_') || value.includes(','))) throw new HttpError(400, 'Writes require a concrete index and type');
  }

  live(doc, now = this.now()) { return doc && (doc.expiresAt === undefined || doc.expiresAt > now); }
  get(index, type, id) { const doc = this.docs.get(identity(index, type, id)); return this.live(doc) ? doc : undefined; }
  settings(index) { return this.indices.get(index) ?? {refresh: true, languages: []}; }

  /** Roll back memory if the atomic file replacement fails. */
  transaction(operation) {
    const previousDocs = this.docs; const previousIndices = this.indices;
    this.docs = new Map(this.docs);
    this.indices = new Map(structuredClone([...this.indices]));
    try {
      const now = this.now();
      for (const [key, doc] of this.docs) if (!this.live(doc, now)) this.docs.delete(key);
      const result = operation();
      this.checkCapacity();
      if (this.file) {
        checkStoragePaths(this.dataDir);
        if (mkdirSync(this.dataDir, {recursive: true})) checkStoragePaths(this.dataDir);
        const temporary = `${this.file}.tmp`;
        // Exclusive creation rejects even a dangling link or stale staging file.
        const fd = openSync(temporary, 'wx', 0o600);
        let renamed = false;
        try {
          try {
            writeFileSync(fd, `{"version":${dataVersion},"docs":[`, 'utf8');
            let separator = '';
            for (const doc of this.docs.values()) {
              writeFileSync(fd, separator + this.encode(doc).text, 'utf8'); separator = ',';
            }
            writeFileSync(fd, '],"indices":' + stringify([...this.indices]) + '}', 'utf8');
          }
          finally { closeSync(fd); }
          checkStoragePaths(this.dataDir);
          renameSync(temporary, this.file);
          renamed = true;
        } finally { if (!renamed) unlinkSync(temporary); }
      }
      return result;
    } catch (error) { this.docs = previousDocs; this.indices = previousIndices; throw error; }
  }

  ensureIndex(index) {
    if (!this.indices.has(index)) {
      if (this.indices.size >= this.limits.indices) throw new HttpError(413, 'Store index quota exceeded');
      this.indices.set(index, {refresh: true, languages: []});
    }
    return this.indices.get(index);
  }

  checkVersion(previous, version) {
    if (version !== undefined && previous?.version !== version) throw new HttpError(409, 'Document version conflict');
  }

  put(index, type, id = randomUUID(), source, {create = false, language, version: expectedVersion, ttl, parent} = {}) {
    this.validateIdentity(index, type, id); object(source, 'Document');
    const previous = this.get(index, type, id);
    if (create && previous) throw new HttpError(409, 'Document already exists');
    this.checkVersion(previous, expectedVersion);
    const version = (previous?.version ?? 0) + 1;
    if (!Number.isSafeInteger(version)) throw new HttpError(409, 'Document version limit reached');
    const expiresAt = ttl === undefined ? undefined : this.now() + ttl;
    if (expiresAt !== undefined && !Number.isSafeInteger(expiresAt)) throw new HttpError(400, 'TTL deadline exceeds the local time range');
    parent ??= previous?.parent;
    const document = {index, type, id, version, source: clone(source), ...(expiresAt !== undefined ? {expiresAt} : {}), ...(parent !== undefined ? {parent} : {})};
    const settings = structuredClone(this.settings(index));
    if (language && !settings.languages.includes(language)) settings.languages.push(language);
    this.checkCapacity(document, settings);
    this.indices.set(index, settings);
    this.docs.set(identity(index, type, id), document);
    return {ok: true, _index: index, _type: type, _id: id, _version: version};
  }

  delete(index, type, id, {version} = {}) {
    this.validateIdentity(index, type, id);
    const previous = this.get(index, type, id);
    this.checkVersion(previous, version);
    this.docs.delete(identity(index, type, id));
    const found = Boolean(previous);
    return {ok: true, _index: index, _type: type, _id: id, found};
  }

  select(indices, types) {
    const now = this.now();
    return [...this.docs.values()].filter(doc => this.live(doc, now) && (!indices || indices.includes(doc.index)) && (!types || types.includes(doc.type)));
  }

  indexNames(indices) { return indices ?? [...new Set([...this.indices.keys(), ...[...this.docs.values()].map(doc => doc.index)])]; }
}
