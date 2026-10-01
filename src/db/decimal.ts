// Exact decimal reading of number text: digits and a base-10 exponent, no JS float involved.

export interface Decimal {
  /** Significant digits without leading zeros; "0" for zero. */
  readonly digits: string;
  /** Value = digits x 10^exponent. */
  readonly exponent: bigint;
  readonly negative: boolean;
}

const DECIMAL_TEXT = /^\s*([+-]?)([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?\s*$/;

/** Parse decimal text such as 00042, 1.8e-06 or 0e-99999. Throws on anything else. */
export function parseDecimal(text: string): Decimal {
  const match = DECIMAL_TEXT.exec(text);
  const whole = match?.[2] ?? "";
  const fraction = match?.[3] ?? "";
  if (match === null || whole + fraction === "") throw new Error("not a decimal number");
  const digits = (whole + fraction).replace(/^0+/, "") || "0";
  const exponent = BigInt(match[4] ?? "0") - BigInt(fraction.length);
  return { digits, exponent, negative: match[1] === "-" };
}

export function isZero(value: Decimal): boolean {
  return value.digits === "0";
}

/** The exponent of the most significant digit: 1 for 42, -6 for 1.8e-06. */
export function adjusted(value: Decimal): bigint {
  return value.exponent + BigInt(value.digits.length) - 1n;
}

/** True when a non-negative decimal is above 1. */
export function isAboveOne(value: Decimal): boolean {
  if (value.negative || isZero(value)) return false;
  const top = adjusted(value);
  if (top !== 0n) return top > 0n;
  return value.digits[0] !== "1" || /[1-9]/.test(value.digits.slice(1));
}

function normalised(value: Decimal): { digits: string; exponent: bigint; negative: boolean } {
  if (isZero(value)) return { digits: "0", exponent: 0n, negative: false };
  const trimmed = value.digits.replace(/0+$/, "");
  return {
    digits: trimmed,
    exponent: value.exponent + BigInt(value.digits.length - trimmed.length),
    negative: value.negative,
  };
}

/** Decimal equality: 1.8e-06 equals 0.0000018, 00042 equals 42. */
export function decimalEquals(left: string, right: string): boolean {
  const a = normalised(parseDecimal(left));
  const b = normalised(parseDecimal(right));
  return a.digits === b.digits && a.exponent === b.exponent && a.negative === b.negative;
}
