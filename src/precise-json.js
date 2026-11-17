/** Node 24 supplies the original numeric token to the reviver, before rounding.
 * Keep integral tokens outside the safe Number range as BigInt. JSON syntax,
 * string escapes and object keys remain the responsibility of the native parser.
 */
function numberToken(token, approximate) {
  const [, sign, whole, fraction = '', exponent = '0'] = token.match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  const digits = (whole + fraction).replace(/^0+/, '') || '0';
  if (digits === '0') return approximate;
  const shift = Number(exponent) - fraction.length;
  // Nonintegral JSON numbers retain the existing floating-point semantics.
  if (shift < 0 && (shift < -digits.length || !digits.endsWith('0'.repeat(-shift)))) return approximate;
  if (!Number.isFinite(shift) || shift > 10000) throw new SyntaxError('JSON integer exponent is too large');
  const integer = BigInt(sign + (shift < 0 ? digits.slice(0, shift) : digits + '0'.repeat(shift)));
  return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer;
}

// $$number is shared by CLR integral and floating-point properties. Preserve
// the indexed token's type on its containing object, without boxing numbers or
// changing query arithmetic. Weak metadata never becomes a document property.
const decimalTokens = new WeakMap();
export function numericTokenAt(holder, key) {
  const entry = decimalTokens.get(holder)?.get(String(key));
  return entry && Object.is(entry.value, holder[key]) ? entry.token : undefined;
}

export function copyNumericToken(source, key, target, targetKey = key) {
  const token = numericTokenAt(source, key);
  if (token === undefined) return;
  if (!decimalTokens.has(target)) decimalTokens.set(target, new Map());
  decimalTokens.get(target).set(String(targetKey), {value: target[targetKey], token});
}

export function parse(text) {
  return JSON.parse(text, function (key, value, context) {
    if (typeof value !== 'number') return value;
    const parsed = numberToken(context.source, value);
    if (/[.eE]/.test(context.source)) {
      if (!decimalTokens.has(this)) decimalTokens.set(this, new Map());
      decimalTokens.get(this).set(key, {value: parsed, token: context.source});
    }
    return parsed;
  });
}

/** Clone document data while retaining indexed numeric token types. */
export function clone(value) {
  const result = structuredClone(value);
  function transfer(source, target) {
    if (!source || typeof source !== 'object') return;
    for (const key of Object.keys(source)) {
      copyNumericToken(source, key, target);
      transfer(source[key], target[key]);
    }
  }
  transfer(value, result);
  return result;
}

/** Array selection must carry token types along with the primitive values. */
export function appendNumeric(target, source, key) {
  const index = target.length;
  target.push(source[key]);
  copyNumericToken(source, key, target, index);
}

export function flattenNumeric(values, depth = Infinity) {
  const result = [];
  function visit(array, remaining) {
    for (let i = 0; i < array.length; i++) {
      if (remaining > 0 && Array.isArray(array[i])) visit(array[i], remaining - 1);
      else appendNumeric(result, array, i);
    }
  }
  visit(values, depth);
  return result;
}

/** BigInt is emitted as a JSON numeric token, never a string or marker object. */
export function stringify(value) {
  return JSON.stringify(value, function (key, item) {
    const token = numericTokenAt(this, key);
    if (token !== undefined) return JSON.rawJSON(token);
    return typeof item === 'bigint' ? JSON.rawJSON(item.toString()) : item;
  });
}

/** Preserve a floating-point wire type even when the value is whole. Keep the
 * decimal point in the mantissa for exponent notation as well. */
export function decimal(value) {
  if (!isNumeric(value) || typeof value === 'number' && !Number.isFinite(value)) return value;
  const [mantissa, exponent] = String(value).split('e');
  return JSON.rawJSON(`${mantissa.includes('.') ? mantissa : `${mantissa}.0`}${exponent === undefined ? '' : `e${exponent}`}`);
}

/** Document numbers retain their indexed token types. Computed floating-point
 * values (scores) are explicitly marked with decimal() at their origin. */
export const stringifyResponse = stringify;

export const isNumeric = value => typeof value === 'number' || typeof value === 'bigint';
export const comparable = (a, b) => typeof a === typeof b || isNumeric(a) && isNumeric(b);
export const equal = (a, b) => a === b || isNumeric(a) && isNumeric(b) && a <= b && a >= b;
export const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Exact integer sums/averages are compared as fractions, without division. */
export function numericSort(values, average) {
  let numerator = 0n; let denominator = 1n;
  for (const value of values) {
    const [, sign, whole, fraction = '', exponent = '0'] = String(value).match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
    const shift = Number(exponent) - fraction.length;
    const n = BigInt(sign + whole + fraction) * 10n ** BigInt(Math.max(0, shift));
    const d = 10n ** BigInt(Math.max(0, -shift));
    // Denominators are powers of ten: reuse their common scale rather than
    // multiplying it for every array member.
    if (d > denominator) { numerator *= d / denominator; denominator = d; }
    numerator += n * (denominator / d);
  }
  return {numerator, denominator: denominator * BigInt(average ? values.length : 1)};
}

export function compareSort(a, b) {
  if (a && typeof a === 'object' && b && typeof b === 'object') return compare(a.numerator * b.denominator, b.numerator * a.denominator);
  return compare(a, b);
}
