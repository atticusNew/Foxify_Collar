/**
 * EXACT DECIMALS: a venue's decimal read into integer units without a float in between.
 *
 * A venue writes money and sizes as decimal strings ("0.54", "1.0000", "0.1055", "50.00"). A
 * float cannot hold most of them (0.29 x 100 is 28.999999999999996), so the member's sale reads
 * the digits themselves into integers and does every sum, product and division on integers:
 *   - a price is micro-dollars per contract (1_000_000 = $1): two digits past the venue's
 *     four-decimal grid, the unit kalshiOrders.dollarsToMicro already uses;
 *   - a size is milli-contracts (1000 = one contract), the unit the books use elsewhere here;
 *   - money shown or written is whole cents, and every division that lands on cents names its
 *     direction.
 * BigInt carries the products, so no intermediate can pass 2^53 unseen: a result that would not
 * fit a safe integer is refused, never rounded silently.
 */

export const MICRO_PER_DOLLAR = 1_000_000;
export const MICRO_PER_CENT = 10_000;
export const MILLI_PER_CONTRACT = 1000;

/** down: toward minus infinity. up: toward plus infinity. nearest: to the closer integer, a tie going up (as Math.round). */
export type Rounding = "down" | "up" | "nearest";

/** A decimal as written: `digits` / 10^`scale`, signed. */
export interface ExactDecimal {
  digits: bigint;
  scale: number;
}

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/**
 * Read a decimal as the venue wrote it. A string is read digit by digit. A number is read through
 * its shortest decimal form, which is the decimal the venue's JSON carried for anything of 15
 * significant digits or fewer. Null for anything else: empty, not a plain decimal, an exponent
 * form, absurdly long.
 */
export function readDecimal(v: unknown): ExactDecimal | null {
  let s: string;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    s = String(v);
  } else if (typeof v === "string") {
    s = v.trim();
  } else {
    return null;
  }
  if (s.length === 0 || s.length > 40) return null;
  const m = DECIMAL.exec(s);
  if (!m) return null;
  const whole = m[2];
  const frac = m[3] ?? "";
  if (whole.length === 0 && frac.length === 0) return null;
  const digits = BigInt(`${whole}${frac}` || "0");
  return { digits: m[1] === "-" ? -digits : digits, scale: frac.length };
}

function divideBig(num: bigint, den: bigint, round: Rounding): bigint {
  if (den <= 0n) throw new RangeError("exactDecimal: the divisor must be positive");
  if (round === "nearest") return divideBig(2n * num + den, 2n * den, "down");
  const q = num / den;
  const r = num % den;
  if (r === 0n) return q;
  // BigInt division truncates toward zero: step to the side asked for
  if (round === "down") return num < 0n ? q - 1n : q;
  return num < 0n ? q : q + 1n;
}

function safeNumber(q: bigint): number {
  if (q > BigInt(Number.MAX_SAFE_INTEGER) || q < -BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("exactDecimal: the result does not fit a safe integer");
  return Number(q);
}

function big(n: number): bigint {
  if (!Number.isSafeInteger(n)) throw new RangeError(`exactDecimal: ${n} is not a safe integer`);
  return BigInt(n);
}

/** The decimal in units of 10^-`decimals` (2 = cents, 3 = milli, 6 = micro), digits past that going the way `round` says. Null when unreadable or too large. */
export function decimalUnits(v: unknown, decimals: number, round: Rounding): number | null {
  const d = readDecimal(v);
  if (!d) return null;
  const q = d.scale <= decimals ? d.digits * 10n ** BigInt(decimals - d.scale) : divideBig(d.digits, 10n ** BigInt(d.scale - decimals), round);
  return q > BigInt(Number.MAX_SAFE_INTEGER) || q < -BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(q);
}

/** a x b / c on integers, exactly, the remainder going the way `round` says. c must be positive. */
export function mulDiv(a: number, b: number, c: number, round: Rounding): number {
  return safeNumber(divideBig(big(a) * big(b), big(c), round));
}

/** a / b on integers, the remainder going the way `round` says. b must be positive. */
export function divInt(a: number, b: number, round: Rounding): number {
  return safeNumber(divideBig(big(a), big(b), round));
}

/** num / den on BigInt, for a sum of products kept whole until the one division. den must be positive. */
export function divBig(num: bigint, den: bigint, round: Rounding): number {
  return safeNumber(divideBig(num, den, round));
}

/** Whole cents as the venue's two-decimal dollar string ("0.53", "1.08"). Refuses anything that is not a whole, non-negative number of cents. */
export function centsToDollarString(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError(`exactDecimal: ${cents} is not a whole number of cents`);
  const c = cents % 100;
  return `${(cents - c) / 100}.${String(c).padStart(2, "0")}`;
}
