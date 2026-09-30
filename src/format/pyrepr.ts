// Python repr() for the values the validator quotes, so messages match the Python original byte for byte.
// Pure: no Node or Bun APIs, the browser imports it.

const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;

function hex(codePoint: number, width: number): string {
  return codePoint.toString(16).padStart(width, "0");
}

/** repr(str): single quotes unless the text holds ' and no ", escapes the way CPython does. */
export function pyStrRepr(text: string): string {
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

/** repr(float): shortest round-trip digits, fixed notation for exponents -4..15, else 1e+16 style. */
export function pyFloatRepr(value: number): string {
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

/** f"{value:.6f}" for a float. */
export function pyFixed6(value: number): string {
  if (Number.isNaN(value)) return "nan";
  if (!Number.isFinite(value)) return value > 0 ? "inf" : "-inf";
  if (Math.abs(value) >= 1e21) return `${BigInt(value).toString()}.000000`;
  const fixed = value.toFixed(6);
  return Object.is(value, -0) || (value < 0 && !fixed.startsWith("-")) ? "-" + fixed : fixed;
}

export type PyScalar = null | string | number | bigint;

/** repr() of None, str, float (number) or int (bigint). */
export function pyRepr(value: PyScalar): string {
  if (value === null) return "None";
  if (typeof value === "string") return pyStrRepr(value);
  if (typeof value === "bigint") return value.toString();
  return pyFloatRepr(value);
}

/** repr(list) of scalars. */
export function pyListRepr(values: readonly PyScalar[]): string {
  return `[${values.map(pyRepr).join(", ")}]`;
}
