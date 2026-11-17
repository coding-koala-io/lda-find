// Fixed codes only: exception messages can contain user-supplied field names.
const codes = {400: 'bad_request', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'payload_too_large', 415: 'unsupported_media_type', 499: 'request_closed', 500: 'internal_error', 501: 'not_implemented'};
export const errorCode = status => codes[status] ?? 'http_error';

export class HttpError extends Error {
  constructor(status, message, code = errorCode(status)) { super(message); this.status = status; this.code = code; }
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
