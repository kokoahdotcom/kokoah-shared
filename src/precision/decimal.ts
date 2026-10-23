/**
 * Minimal exact decimal arithmetic on top of BigInt, used for price and size rounding.
 *
 * A value is represented as `m × 10^-s` with an integer mantissa `m` and a non-negative scale `s`.
 * This avoids binary floating-point surprises (e.g. `1.1 * 3 = 3.3000000000000003`) when producing
 * the exact strings that get hashed and signed.
 *
 * @module
 * @internal
 */

/** Exact decimal value `m × 10^-s`. */
export interface Dec {
  readonly m: bigint;
  readonly s: number;
}

/** Thrown when a price or size cannot be parsed, is not finite, or cannot be represented. */
export class PrecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrecisionError";
  }
}

/** Rounding direction. `down` rounds toward zero, `up` away from zero, `nearest` is half away from zero. */
export type RoundingDirection = "nearest" | "up" | "down";

const DECIMAL_RE = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * Longest decimal string {@link parseDec} accepts. Hyperliquid's prices and sizes are far shorter; longer input (a
 * caller's 250 KB `"1.000…"`) would only cost BigInt work that grows with the square of its length.
 */
export const MAX_DECIMAL_LENGTH = 40;

/**
 * Parses a number or decimal string into an exact decimal.
 *
 * Numbers are first reduced to 15 significant digits, the precision a float64 reliably carries,
 * so float noise such as `3.3000000000000003` becomes `3.3`. Strings are parsed exactly, up to
 * {@link MAX_DECIMAL_LENGTH} characters.
 *
 * @throws {PrecisionError} on empty, malformed, over-long or non-finite input.
 */
export function parseDec(input: number | string): Dec {
  let text: string;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new PrecisionError(`Not a finite number: ${String(input)}`);
    text = input === 0 ? "0" : input.toPrecision(15);
  } else if (typeof input === "string") {
    text = input.trim();
    // Checked before any parsing, and never echoed: the input may be huge.
    if (text.length > MAX_DECIMAL_LENGTH) throw new PrecisionError(`Decimal is too long: at most ${MAX_DECIMAL_LENGTH} characters`);
  } else {
    throw new PrecisionError(`Expected a number or decimal string, got ${typeof input}`);
  }
  const match = DECIMAL_RE.exec(text);
  if (!match) throw new PrecisionError(`Not a decimal number: ${JSON.stringify(typeof input === "string" ? text : input)}`);
  const [, sign = "", intPart = "", fracPart = "", expPart] = match;
  if (intPart === "" && fracPart === "") throw new PrecisionError(`Not a decimal number: ${JSON.stringify(typeof input === "string" ? text : input)}`);
  let m = BigInt((intPart || "0") + fracPart);
  let s = fracPart.length;
  const exp = expPart === undefined ? 0 : Number(expPart);
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 1000) throw new PrecisionError(`Exponent out of range: ${text}`);
  if (exp > 0) {
    if (exp >= s) {
      m = m * 10n ** BigInt(exp - s);
      s = 0;
    } else {
      s -= exp;
    }
  } else if (exp < 0) {
    s += -exp;
  }
  if (sign === "-") m = -m;
  return normalize({ m, s });
}

/** Removes trailing zeros from the fractional part (keeps the value). */
export function normalize(d: Dec): Dec {
  const { m, s } = d;
  if (m === 0n) return { m: 0n, s: 0 };
  if (s <= 0 || m % 10n !== 0n) return { m, s };
  // Counted on the digits and divided out at once, not one BigInt division per zero.
  const digits = m.toString();
  let zeros = 0;
  while (zeros < s && digits.charCodeAt(digits.length - 1 - zeros) === 48) zeros++;
  return { m: m / 10n ** BigInt(zeros), s: s - zeros };
}

/** Formats as a plain decimal string without exponent and without trailing zeros. Negative zero becomes "0". */
export function decToString(d: Dec): string {
  const n = normalize(d);
  const negative = n.m < 0n;
  const digits = (negative ? -n.m : n.m).toString();
  if (n.s === 0) return negative ? `-${digits}` : digits;
  const padded = digits.padStart(n.s + 1, "0");
  const intPart = padded.slice(0, padded.length - n.s);
  const fracPart = padded.slice(padded.length - n.s);
  return `${negative ? "-" : ""}${intPart}.${fracPart}`;
}

/** Converts to a JS number (may lose precision for very long values). */
export function decToNumber(d: Dec): number {
  return Number(decToString(d));
}

/** Sign of the value: -1, 0 or 1. */
export function decSign(d: Dec): -1 | 0 | 1 {
  return d.m === 0n ? 0 : d.m < 0n ? -1 : 1;
}

/** Number of decimal places after normalization. */
export function decDecimals(d: Dec): number {
  return normalize(d).s;
}

/** True when the value has no fractional part. */
export function decIsInteger(d: Dec): boolean {
  return normalize(d).s === 0;
}

/** Number of significant digits after normalization (integers keep their trailing zeros as significant). */
export function decSignificantDigits(d: Dec): number {
  const n = normalize(d);
  if (n.m === 0n) return 0;
  const abs = n.m < 0n ? -n.m : n.m;
  return abs.toString().length;
}

/**
 * Decimal exponent of the leading digit: `floor(log10(|value|))`.
 * For example 1234.5 → 3, 0.001234 → -3. Throws for zero.
 */
export function decExponent(d: Dec): number {
  const n = normalize(d);
  if (n.m === 0n) throw new PrecisionError("Exponent of zero is undefined");
  const abs = n.m < 0n ? -n.m : n.m;
  return abs.toString().length - 1 - n.s;
}

/**
 * Rounds to `scale` decimal places (a negative scale rounds to tens, hundreds, …).
 * `down` truncates toward zero, `up` rounds away from zero, `nearest` rounds half away from zero.
 */
export function decRound(d: Dec, scale: number, direction: RoundingDirection): Dec {
  const n = normalize(d);
  if (n.s <= scale) return n;
  const drop = BigInt(n.s - scale);
  const factor = 10n ** drop;
  const negative = n.m < 0n;
  const abs = negative ? -n.m : n.m;
  let q = abs / factor;
  const r = abs % factor;
  if (r !== 0n) {
    if (direction === "up") q += 1n;
    else if (direction === "nearest" && r * 2n >= factor) q += 1n;
  }
  const signed = negative ? -q : q;
  if (scale >= 0) return normalize({ m: signed, s: scale });
  return normalize({ m: signed * 10n ** BigInt(-scale), s: 0 });
}

/** Compares two decimals: -1 if a < b, 0 if equal, 1 if a > b. */
export function decCompare(a: Dec, b: Dec): -1 | 0 | 1 {
  const s = Math.max(a.s, b.s);
  const am = a.m * 10n ** BigInt(s - a.s);
  const bm = b.m * 10n ** BigInt(s - b.s);
  return am === bm ? 0 : am < bm ? -1 : 1;
}

/** Exact multiplication. */
export function decMul(a: Dec, b: Dec): Dec {
  return normalize({ m: a.m * b.m, s: a.s + b.s });
}

/** Exact addition. */
export function decAdd(a: Dec, b: Dec): Dec {
  const s = Math.max(a.s, b.s);
  return normalize({ m: a.m * 10n ** BigInt(s - a.s) + b.m * 10n ** BigInt(s - b.s), s });
}

/** Exact subtraction. */
export function decSub(a: Dec, b: Dec): Dec {
  return decAdd(a, { m: -b.m, s: b.s });
}

/** `10^-scale` as a decimal (the step at a given number of decimals). */
export function decStep(scale: number): Dec {
  return scale >= 0 ? { m: 1n, s: scale } : { m: 10n ** BigInt(-scale), s: 0 };
}
