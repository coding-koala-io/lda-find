export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function object(value, label = 'Value') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${label} must be an object`);
  return value;
}

export function unsupported(label) { throw new HttpError(400, `Unsupported ${label}`); }

export function keys(value, allowed, label) {
  object(value, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) unsupported(`${label} member: ${key}`);
}
