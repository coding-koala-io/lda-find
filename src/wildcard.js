import {HttpError} from './errors.js';

export const wildcardLimits = Object.freeze({length: 1024, count: 64});

/** A bounded finite-state matcher: each character advances a set of states.
 * No regular expression or recursive/backtracking path is used. */
export function wildcard(pattern, {escaped = false, lowercase = false} = {}) {
  if (pattern.length > wildcardLimits.length) throw new HttpError(400, 'Wildcard pattern is too long');
  const tokens = []; let count = 0;
  const chars = [...pattern];
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (escaped && char === '\\' && i + 1 < chars.length) tokens.push({literal: chars[++i]});
    else if (char === '*' || char === '?') { tokens.push({kind: char}); count++; }
    else tokens.push({literal: char});
  }
  if (count > wildcardLimits.count) throw new HttpError(400, 'Wildcard pattern has too many wildcards');
  if (lowercase) for (const token of tokens) if (token.literal !== undefined) token.literal = token.literal.toLowerCase();
  const close = states => {
    for (let i = 0; i < tokens.length; i++) if (states[i] && tokens[i].kind === '*') states[i + 1] = 1;
    return states;
  };
  return value => {
    let states = new Uint8Array(tokens.length + 1); states[0] = 1; close(states);
    for (const char of lowercase ? value.toLowerCase() : value) {
      const next = new Uint8Array(tokens.length + 1); let live = false;
      for (let i = 0; i < tokens.length; i++) {
        if (!states[i]) continue;
        const token = tokens[i];
        if (token.kind === '*') { next[i] = 1; live = true; }
        else if (token.kind === '?' || token.literal === char) { next[i + 1] = 1; live = true; }
      }
      if (!live) return false;
      states = close(next);
    }
    return Boolean(states[tokens.length]);
  };
}
