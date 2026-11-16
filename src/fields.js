const own = (value, key) => value != null && typeof value === 'object' && Object.hasOwn(value, key);
export const words = value => String(value).toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];

/** Read exact submitted keys first, then dotted paths through objects and arrays. */
function read(value, path) {
  if (Array.isArray(value)) return value.flatMap(item => read(item, path));
  if (!path) return value === undefined ? [] : [value];
  if (own(value, path)) return [value[path]];
  const split = path.indexOf('.');
  if (split < 0) return [];
  const head = path.slice(0, split);
  return own(value, head) ? read(value[head], path.slice(split + 1)) : [];
}

export function fieldValues(doc, field) {
  if (field === '_id') return [doc.id];
  if (field === '_type') return [doc.type];
  if (field === '_index') return [doc.index];
  if (field === '_all') return strings(doc.source);
  const exact = read(doc.source, field).flat(Infinity).filter(value => value != null);
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

export function assignPath(target, path, value) {
  const [head, ...tail] = path.split('.');
  if (!tail.length) { Object.defineProperty(target, head, {value: structuredClone(value), enumerable: true, writable: true, configurable: true}); return; }
  if (!own(target, head) || !target[head] || typeof target[head] !== 'object') Object.defineProperty(target, head, {value: {}, enumerable: true, writable: true, configurable: true});
  assignPath(target[head], tail.join('.'), value);
}

export function project(doc, fields) {
  const result = {};
  const absent = Symbol('absent');
  const set = (target, key, value) => Object.defineProperty(target, key, {value, enumerable: true, writable: true, configurable: true});
  function pick(source, parts) {
    if (Array.isArray(source)) return source.map(item => { const selected = pick(item, parts); return selected === absent ? {} : selected; });
    if (!source || typeof source !== 'object') return absent;
    const path = parts.join('.');
    if (own(source, path)) { const selected = {}; assignPath(selected, path, source[path]); return selected; }
    const [head, ...tail] = parts;
    if (!own(source, head)) return absent;
    const selected = tail.length ? pick(source[head], tail) : structuredClone(source[head]);
    if (selected === absent) return absent;
    const value = {}; set(value, head, selected); return value;
  }
  function merge(target, source) {
    for (const [key, value] of Object.entries(source)) {
      if (value && typeof value === 'object') {
        if (!own(target, key) || !target[key] || typeof target[key] !== 'object' || Array.isArray(target[key]) !== Array.isArray(value)) set(target, key, Array.isArray(value) ? [] : {});
        merge(target[key], value);
      } else set(target, key, value);
    }
  }
  for (const field of fields) {
    const selected = pick(doc.source, field.split('.'));
    if (selected !== absent) merge(result, selected);
    else {
      const values = fieldValues(doc, field);
      if (values.length) assignPath(result, field, values.length === 1 ? values[0] : values);
    }
  }
  return result;
}

