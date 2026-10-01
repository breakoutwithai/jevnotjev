// A JSON Schema (draft 2020-12) evaluator for the keywords record-v1.schema.json uses. Error order and
// message text are part of the message contract in format/README.md.
// Any other keyword throws: the schema cannot silently gain a rule this file does not enforce.
// Pure: no Node or Bun APIs, the browser imports it.

import { formatList, formatValue, quoteText, type Scalar } from "./quote.ts";

/** An instance value: a CSV cell after parsing (int is bigint, float is number) or a row. */
export type Value = Scalar | ReadonlyMap<string, Value>;

export interface SchemaError {
  readonly path: readonly string[];
  readonly message: string;
}

type JsonObject = { readonly [key: string]: unknown };

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRow(value: Value): value is ReadonlyMap<string, Value> {
  return value instanceof Map;
}

function isScalar(value: unknown): value is Scalar {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "bigint";
}

function scalarList(value: unknown, keyword: string): Scalar[] {
  if (!Array.isArray(value)) throw new Error(`schema: ${keyword} must be an array`);
  return value.map((item) => {
    if (!isScalar(item)) throw new Error(`schema: ${keyword} holds a non-scalar`);
    return item;
  });
}

function stringList(value: unknown, keyword: string): string[] {
  return scalarList(value, keyword).map((item) => {
    if (typeof item !== "string") throw new Error(`schema: ${keyword} must hold strings`);
    return item;
  });
}

function schemaNumber(value: unknown, keyword: string): number {
  if (typeof value !== "number") throw new Error(`schema: ${keyword} must be a number`);
  return value;
}

/** A schema bound in a message: an integer prints bare (1, not 1.0), any other number as formatValue shows it. */
function formatBound(value: number): string {
  return Number.isInteger(value) ? String(value) : formatValue(value);
}

function isNumeric(value: Value): value is number | bigint {
  return typeof value === "number" || typeof value === "bigint";
}

function isType(value: Value, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "number":
      return isNumeric(value);
    case "integer":
      return typeof value === "bigint" || (typeof value === "number" && Number.isInteger(value));
    case "object":
      return isRow(value);
    case "boolean":
    case "array":
      return false;
    default:
      throw new Error(`schema: unknown type ${type}`);
  }
}

/** An int against a float, exactly, without rounding the int to a float: -1, 0 or 1. */
function compareIntFloat(whole: bigint, fraction: number): number {
  if (Number.isNaN(fraction)) return 0;
  if (fraction === Infinity) return -1;
  if (fraction === -Infinity) return 1;
  const floor = BigInt(Math.floor(fraction));
  if (whole !== floor) return whole < floor ? -1 : 1;
  return Number.isInteger(fraction) ? 0 : -1;
}

/** Numeric comparison without losing precision on large integers: -1, 0 or 1. */
function compareNumbers(left: number | bigint, right: number | bigint): number {
  if (typeof left === "bigint" && typeof right === "number") return compareIntFloat(left, right);
  if (typeof left === "number" && typeof right === "bigint") return -compareIntFloat(right, left);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Equality for const and enum: numbers compare by value (1 equals 1.0), everything else strictly. */
function equal(left: Value, right: Value): boolean {
  if (isNumeric(left) && isNumeric(right)) return compareNumbers(left, right) === 0;
  return left === right;
}

/** A schema pattern: matches anywhere in the text, and an unescaped $ outside a class also matches before a final newline. */
function schemaPattern(pattern: string): RegExp {
  let out = "";
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] ?? "";
    if (char === "\\") {
      out += char + (pattern[i + 1] ?? "");
      i += 1;
    } else if (inClass) {
      if (char === "]") inClass = false;
      out += char;
    } else if (char === "[") {
      inClass = true;
      out += char;
    } else if (char === "$") out += "(?=\\n?$)";
    else out += char;
  }
  return new RegExp(out, "u");
}

const patterns = new Map<string, RegExp>();

function compiled(pattern: string): RegExp {
  const found = patterns.get(pattern);
  if (found) return found;
  const made = schemaPattern(pattern);
  patterns.set(pattern, made);
  return made;
}

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "title", "description", "default", "examples", "then", "else"]);

/** Errors in schema order: schema keys in document order, depth first. */
export function* iterErrors(schema: unknown, instance: Value, path: readonly string[] = []): Generator<SchemaError> {
  if (schema === true) return;
  if (schema === false) {
    yield { path, message: `False schema does not allow ${formatInstance(instance)}` };
    return;
  }
  if (!isJsonObject(schema)) throw new Error("schema: a schema must be an object or a boolean");
  for (const [keyword, argument] of Object.entries(schema)) {
    if (ANNOTATIONS.has(keyword)) continue;
    switch (keyword) {
      case "type": {
        const types = typeof argument === "string" ? [argument] : stringList(argument, "type");
        if (!types.some((type) => isType(instance, type))) {
          yield { path, message: `${formatInstance(instance)} is not of type ${types.map(quoteText).join(", ")}` };
        }
        break;
      }
      case "const": {
        if (!isScalar(argument)) throw new Error("schema: const must be a scalar");
        if (!equal(instance, argument)) yield { path, message: `${formatValue(argument)} was expected` };
        break;
      }
      case "enum": {
        const options = scalarList(argument, "enum");
        if (!options.some((option) => equal(instance, option))) {
          yield { path, message: `${formatInstance(instance)} is not one of ${formatList(options)}` };
        }
        break;
      }
      case "pattern": {
        if (typeof argument !== "string") throw new Error("schema: pattern must be a string");
        if (typeof instance === "string" && !compiled(argument).test(instance)) {
          yield { path, message: `${quoteText(instance)} does not match ${quoteText(argument)}` };
        }
        break;
      }
      case "minLength": {
        const limit = schemaNumber(argument, keyword);
        if (typeof instance === "string" && codePoints(instance) < limit) {
          yield { path, message: `${quoteText(instance)} ${limit === 1 ? "should be non-empty" : "is too short"}` };
        }
        break;
      }
      case "maxLength": {
        const limit = schemaNumber(argument, keyword);
        if (typeof instance === "string" && codePoints(instance) > limit) {
          yield { path, message: `${quoteText(instance)} ${limit === 0 ? "is expected to be empty" : "is too long"}` };
        }
        break;
      }
      case "minimum": {
        const limit = schemaNumber(argument, keyword);
        if (isNumeric(instance) && compareNumbers(instance, limit) < 0) {
          yield { path, message: `${formatValue(instance)} is less than the minimum of ${formatBound(limit)}` };
        }
        break;
      }
      case "maximum": {
        const limit = schemaNumber(argument, keyword);
        if (isNumeric(instance) && compareNumbers(instance, limit) > 0) {
          yield { path, message: `${formatValue(instance)} is greater than the maximum of ${formatBound(limit)}` };
        }
        break;
      }
      case "required": {
        if (isRow(instance)) {
          for (const name of stringList(argument, keyword)) {
            if (!instance.has(name)) yield { path, message: `${quoteText(name)} is a required property` };
          }
        }
        break;
      }
      case "properties": {
        if (!isJsonObject(argument)) throw new Error("schema: properties must be an object");
        if (isRow(instance)) {
          for (const [name, subschema] of Object.entries(argument)) {
            const value = instance.get(name);
            if (value !== undefined) yield* iterErrors(subschema, value, [...path, name]);
          }
        }
        break;
      }
      case "additionalProperties": {
        if (!isRow(instance)) break;
        const known = isJsonObject(schema["properties"]) ? Object.keys(schema["properties"]) : [];
        const extras = [...instance.keys()].filter((name) => !known.includes(name));
        if (argument === false) {
          if (extras.length > 0) {
            const names = [...extras].sort().map(quoteText).join(", ");
            yield { path, message: `Additional properties are not allowed (${names} ${extras.length === 1 ? "was" : "were"} unexpected)` };
          }
        } else {
          for (const name of extras) {
            const value = instance.get(name);
            if (value !== undefined) yield* iterErrors(argument, value, [...path, name]);
          }
        }
        break;
      }
      case "allOf": {
        if (!Array.isArray(argument)) throw new Error("schema: allOf must be an array");
        for (const subschema of argument) yield* iterErrors(subschema, instance, path);
        break;
      }
      case "if": {
        const passes = iterErrors(argument, instance, path).next().done === true;
        const branch = passes ? "then" : "else";
        if (branch in schema) yield* iterErrors(schema[branch], instance, path);
        break;
      }
      default:
        throw new Error(`schema: keyword ${keyword} is not supported by this validator`);
    }
  }
}

function formatInstance(value: Value): string {
  if (isRow(value)) return "{...}";
  return formatValue(value);
}
