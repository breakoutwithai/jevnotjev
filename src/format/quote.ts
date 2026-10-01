// How validator and loader messages show a value: quoted text, numbers, null and lists. The message
// contract in format/README.md states these rules; changing one changes every message that quotes a value.
// Pure: no Node or Bun APIs, the browser imports it.

const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function hex(codePoint: number, width: number): string {
  return codePoint.toString(16).padStart(width, "0");
}

/**
 * Quote text for a message: single quotes, or double quotes when the text holds ' and no ". The
 * chosen quote and \ are backslash-escaped; tab, newline and carriage return print as \t \n \r; other
 * control and non-printable characters print as \xNN, \uNNNN or \UNNNNNNNN. Everything else is literal.
 */
export function quoteText(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === quote || char === "\\") out += "\\" + char;
    else if (char === "\t") out += "\\t";
    else if (char === "\n") out += "\\n";
    else if (char === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += "\\x" + hex(code, 2);
    else if (code < 0x7f) out += char;
    else if (char !== " " && NOT_PRINTABLE.test(char)) {
      out += code <= 0xff ? "\\x" + hex(code, 2) : code <= 0xffff ? "\\u" + hex(code, 4) : "\\U" + hex(code, 8);
    } else out += char;
  }
  return out + quote;
}

/**
 * A float in a message: the shortest digits that read back to the same value, always with a decimal
 * point (1.0). Below 1e-4 or from 1e16 up it prints in exponent form with a sign and at least two
 * exponent digits (1e-05, 1e+16). nan, inf and -inf are spelled out; negative zero is -0.0.
 */
export function formatFloat(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (value === Infinity) return "inf";
  if (value === -Infinity) return "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0.0" : "0.0";
  const sign = value < 0 ? "-" : "";
  const [mantissa = "", exponentText = "0"] = Math.abs(value).toExponential().split("e");
  const digits = mantissa.replace(".", "");
  const exponent = Number(exponentText);
  const point = exponent + 1;
  if (point > -4 && point <= 16) {
    if (point <= 0) return `${sign}0.${"0".repeat(-point)}${digits}`;
    if (point >= digits.length) return `${sign}${digits}${"0".repeat(point - digits.length)}.0`;
    return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  const rest = digits.slice(1);
  const magnitude = String(Math.abs(exponent)).padStart(2, "0");
  return `${sign}${digits.slice(0, 1)}${rest ? "." + rest : ""}e${exponent < 0 ? "-" : "+"}${magnitude}`;
}

/** A float fixed at six decimal places (the summary's cost total), nan / inf / -inf spelled out. */
export function formatFixed6(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (Math.abs(value) >= 1e21) return `${BigInt(value).toString()}.000000`;
  const fixed = value.toFixed(6);
  return Object.is(value, -0) || (value < 0 && !fixed.startsWith("-")) ? "-" + fixed : fixed;
}

export type Scalar = null | string | number | bigint;

/** A cell value in a message: null prints as None, text is quoted, an integer (bigint) prints bare, a float as formatFloat. */
export function formatValue(value: Scalar): string {
  if (value === null) return "None";
  if (typeof value === "string") return quoteText(value);
  if (typeof value === "bigint") return value.toString();
  return formatFloat(value);
}

/** A list in a message: [a, b] with each item shown as formatValue shows it. */
export function formatList(values: readonly Scalar[]): string {
  return `[${values.map(formatValue).join(", ")}]`;
}
