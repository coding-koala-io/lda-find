import {HttpError} from './errors.js';

export function urlOptions(params, allowed = []) {
  const values = Object.create(null);
  for (const [name, value] of params) {
    if (!allowed.includes(name)) throw new HttpError(name === 'scroll' ? 501 : 400, 'Unsupported URL option');
    if (Object.hasOwn(values, name)) throw new HttpError(400, 'Duplicate URL option');
    if (!value.length) throw new HttpError(400, 'URL options must be nonempty');
    values[name] = value;
  }
  return values;
}

export function integerOption(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new HttpError(400, `${name} must be a bounded nonnegative integer`);
  return Number(value);
}
