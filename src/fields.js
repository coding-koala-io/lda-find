import {appendNumeric, clone, copyNumericToken, flattenNumeric} from './precise-json.js';

const own = (value, key) => value != null && typeof value === 'object' && Object.hasOwn(value, key);
const metadataFields = new Set(['_id', '_type', '_index', '_version', '_parent']);
export const words = value => String(value).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];

/** Read exact submitted keys first, then dotted paths through objects and arrays. */
function read(value, path, preserveArrays = false) {
  if (Array.isArray(value)) {
    const selected = flattenNumeric(value.map(item => read(item, path, preserveArrays)), 1);
    return preserveArrays && selected.length ? [flattenNumeric(selected, 1)] : selected;
  }
  if (!path) return value === undefined ? [] : [value];
  if (own(value, path)) {
    const selected = [];
    appendNumeric(selected, value, path);
    return selected;
  }
  const split = path.indexOf('.');
  if (split < 0) return [];
  const head = path.slice(0, split);
  return own(value, head) ? read(value[head], path.slice(split + 1), preserveArrays) : [];
}

export function fieldValues(doc, field) {
  if (field === '_id') return [doc.id];
  if (field === '_type') return [doc.type];
  if (field === '_index') return [doc.index];
  if (field === '_version') return [doc.version];
  if (field === '_parent') return doc.parent === undefined ? [] : [doc.parent];
  if (field === '_all') return strings(doc.source);
  const exact = [];
  const flattened = flattenNumeric(read(doc.source, field));
  for (let i = 0; i < flattened.length; i++) if (flattened[i] != null) appendNumeric(exact, flattened, i);
  if (exact.length) return exact;
  const match = field.match(/^(.*\$\$(?:string|strings))\.([^\.]+)$/);
  if (!match) return [];
  const values = read(doc.source, match[1]).flat(Infinity).filter(value => value != null);
  if (match[2] === 'lowercase' || match[2] === 'sort') return values.map(value => typeof value === 'string' ? value.toLowerCase() : value);
  return values.flatMap(value => words(value));
}

export function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.entries(value).filter(([key]) => !key.startsWith('$') && !key.startsWith('___') && !key.endsWith('$$attachment')).flatMap(([, item]) => strings(item));
  return [];
}

/** Explicit field selections are keyed by the complete requested name. Scalar
 * leaves stay scalar; source collections keep their array shape. */
export function project(doc, fields, onField = () => {}) {
  const result = {};
  for (const field of fields) {
    const selected = metadataFields.has(field) ? [] : read(doc.source, field, true);
    const values = selected.length ? selected : fieldValues(doc, field);
    if (values.length) {
      Object.defineProperty(result, field, {value: clone(values.length === 1 ? values[0] : flattenNumeric(values, 1)), enumerable: true, writable: true, configurable: true});
      if (values.length === 1) copyNumericToken(values, 0, result, field);
      onField(field, result[field], result);
    }
  }
  return result;
}

