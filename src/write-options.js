import {HttpError, keys, unsupported} from './errors.js';

const common = ['routing', 'refresh', 'consistency', 'parent', 'replication', 'language_routing'];
const allowed = {
  index: [...common, 'version', 'timeout', 'ttl', 'percolate'],
  delete: [...common, 'version'],
  update: [...common, 'timeout', 'percolate'],
  bulk: ['refresh'],
};

function positiveInteger(value, name) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1) throw new HttpError(400, `${name} must be a positive safe integer`);
  return number;
}

/** Validate controls before mutation. Cluster coordination is immediate on this node. */
export function writeOptions(values, operation = 'index') {
  keys(values, allowed[operation], 'write option');
  for (const name of common.filter(name => name !== 'refresh')) {
    if (values[name] !== undefined && (typeof values[name] !== 'string' || !values[name].length)) throw new HttpError(400, `${name} must be nonempty text`);
  }
  if (values.refresh !== undefined && ![true, false, 'true', 'false', 'wait_for'].includes(values.refresh)) throw new HttpError(400, 'refresh must be true, false or wait_for');
  if (values.consistency !== undefined && !['quorum', 'one', 'all'].includes(values.consistency)) throw new HttpError(400, 'Invalid write consistency');
  if (values.replication !== undefined && !['sync', 'async'].includes(values.replication)) throw new HttpError(400, 'Invalid write replication');
  if (values.timeout !== undefined && (typeof values.timeout !== 'string' || !/^\d+(?:\.\d+)?s$/.test(values.timeout) || !Number.isFinite(Number(values.timeout.slice(0, -1))))) throw new HttpError(400, 'timeout must be a nonnegative duration in seconds');
  // No registered-query execution contract is supplied; never claim it ran.
  if (values.percolate !== undefined) unsupported('percolation on writes; registered-query execution is not specified by the local profile');
  if (values.parent !== undefined && !values.parent.length) throw new HttpError(400, 'parent must be nonempty');
  return {
    ...(values.version !== undefined ? {version: positiveInteger(values.version, 'version')} : {}),
    ...(values.ttl !== undefined ? {ttl: positiveInteger(values.ttl, 'ttl')} : {}),
    ...(values.parent !== undefined ? {parent: values.parent} : {}),
    ...(values.language_routing ? {language: values.language_routing} : {}),
  };
}

export function queryWriteOptions(params, operation) {
  const values = {};
  for (const [name, value] of params) {
    if (Object.hasOwn(values, name)) throw new HttpError(400, `Duplicate write option: ${name}`);
    Object.defineProperty(values, name, {value, enumerable: true});
  }
  return writeOptions(values, operation);
}

export function bulkWriteOptions(metadata, action) {
  keys(metadata, ['_index', '_type', '_id', '_routing', '_version', '_parent', '_percolate', '_ttl', 'language_routing', 'consistency', 'refresh'], 'bulk metadata');
  const values = {};
  for (const [name, value] of Object.entries(metadata)) {
    if (['_index', '_type', '_id'].includes(name)) continue;
    Object.defineProperty(values, name.startsWith('_') ? name.slice(1) : name, {value, enumerable: true});
  }
  return writeOptions(values, action === 'delete' ? 'delete' : 'index');
}
