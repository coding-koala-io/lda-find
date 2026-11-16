import {mkdirSync, readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {HttpError, object} from './errors.js';
import {parse, stringify} from './precise-json.js';
import {storageDirectory, checkStoragePaths} from './storage-paths.js';

const identity = (index, type, id) => JSON.stringify([index, type, id]);

/** One process owns a store. A completed write is visible and saved before acknowledgement. */
export class Store {
  constructor({dataDir, dataRoot} = {}) {
    this.dataDir = storageDirectory(dataDir === ':memory:' ? undefined : dataDir, dataRoot);
    this.docs = new Map();
    this.indices = new Map();
    if (dataDir === ':memory:') return;
    checkStoragePaths(this.dataDir);
    this.file = join(this.dataDir, 'store.json');
    let state;
    try { state = parse(readFileSync(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw new Error('Cannot load LDA Local Find data; repair or move the store before starting', {cause: error}); }
    if (state?.version !== 1 || !Array.isArray(state.docs) || !Array.isArray(state.indices)) throw new Error('Invalid LDA Local Find store format');
    for (const [index, settings] of state.indices) {
      if (typeof index !== 'string' || !Array.isArray(settings.languages) || !settings.languages.every(value => typeof value === 'string') || typeof settings.refresh !== 'boolean') throw new Error('Invalid stored index');
      this.indices.set(index, settings);
    }
    for (const doc of state.docs) {
      this.validateIdentity(doc.index, doc.type, doc.id);
      object(doc.source, 'Stored source');
      if (!Number.isSafeInteger(doc.version) || doc.version < 1) throw new Error('Invalid stored version');
      const key = identity(doc.index, doc.type, doc.id);
      if (this.docs.has(key)) throw new Error('Duplicate stored identity');
      this.docs.set(key, doc);
    }
  }

  validateIdentity(index, type, id) {
    for (const value of [index, type, id]) if (typeof value !== 'string' || !value.length) throw new HttpError(400, 'Index, type and ID must be nonempty strings');
    if ([index, type].some(value => value.startsWith('_') || value.includes(','))) throw new HttpError(400, 'Writes require a concrete index and type');
  }

  get(index, type, id) { return this.docs.get(identity(index, type, id)); }
  settings(index) { return this.indices.get(index) ?? {refresh: true, languages: []}; }

  /** Roll back memory if the atomic file replacement fails. */
  transaction(operation) {
    const previousDocs = this.docs; const previousIndices = this.indices;
    this.docs = new Map(this.docs);
    this.indices = new Map(structuredClone([...this.indices]));
    try {
      const result = operation();
      if (this.file) {
        checkStoragePaths(this.dataDir);
        if (mkdirSync(this.dataDir, {recursive: true})) checkStoragePaths(this.dataDir);
        const temporary = `${this.file}.tmp`;
        // Exclusive creation rejects even a dangling link or stale staging file.
        const fd = openSync(temporary, 'wx', 0o600);
        let renamed = false;
        try {
          try { writeFileSync(fd, stringify({version: 1, docs: [...this.docs.values()], indices: [...this.indices]}), 'utf8'); }
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
    if (!this.indices.has(index)) this.indices.set(index, {refresh: true, languages: []});
    return this.indices.get(index);
  }

  put(index, type, id = randomUUID(), source, {create = false, language} = {}) {
    this.validateIdentity(index, type, id); object(source, 'Document');
    const previous = this.get(index, type, id);
    if (create && previous) throw new HttpError(409, 'Document already exists');
    const version = (previous?.version ?? 0) + 1;
    this.docs.set(identity(index, type, id), {index, type, id, version, source: structuredClone(source)});
    const settings = this.ensureIndex(index);
    if (language && !settings.languages.includes(language)) settings.languages.push(language);
    return {ok: true, _index: index, _type: type, _id: id, _version: version};
  }

  delete(index, type, id) {
    this.validateIdentity(index, type, id);
    const found = this.docs.delete(identity(index, type, id));
    return {ok: true, _index: index, _type: type, _id: id, found};
  }

  select(indices, types) {
    return [...this.docs.values()].filter(doc => (!indices || indices.includes(doc.index)) && (!types || types.includes(doc.type)));
  }

  indexNames(indices) { return indices ?? [...new Set([...this.indices.keys(), ...[...this.docs.values()].map(doc => doc.index)])]; }
}
