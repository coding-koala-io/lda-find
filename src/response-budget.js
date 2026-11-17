import {HttpError} from './errors.js';
import {numericTokenAt, stringifyResponse} from './precise-json.js';

/** Charge each fragment before retaining it, never serialize the assembled response
 * to discover overflow. Copies and overwritten aliases still consume capacity. */
export class ResponseBudget {
  constructor(maximum = 16 * 1024 * 1024) { this.remaining = maximum; }
  bytes(count) {
    this.remaining -= count;
    if (this.remaining < 0) throw new HttpError(413, 'Search aggregate response byte quota exceeded', 'search_output_limit');
  }
  add(value, holder, key) {
    const token = holder ? numericTokenAt(holder, key) : undefined;
    if (token !== undefined) { this.bytes(Buffer.byteLength(token)); return; }
    if (!value || typeof value !== 'object' || JSON.isRawJSON(value)) {
      this.bytes(Buffer.byteLength(stringifyResponse(value))); return;
    }
    this.bytes(2);
    let first = true;
    for (const name of Object.keys(value)) {
      if (!first) this.bytes(1);
      first = false;
      if (!Array.isArray(value)) this.bytes(Buffer.byteLength(JSON.stringify(name)) + 1);
      this.add(value[name], value, name);
    }
  }
  member(name, value, holder) {
    // Includes a comma even for the first member (a conservative single byte).
    this.bytes(Buffer.byteLength(JSON.stringify(name)) + 2);
    this.add(value, holder, name);
  }
}
