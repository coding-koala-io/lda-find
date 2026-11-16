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

export function parse(text) {
  return JSON.parse(text, (key, value, context) => typeof value === 'number' ? numberToken(context.source, value) : value);
}

/** BigInt is emitted as a JSON numeric token, never a string or marker object. */
export function stringify(value) {
  return JSON.stringify(value, (key, item) => typeof item === 'bigint' ? JSON.rawJSON(item.toString()) : item);
}

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
