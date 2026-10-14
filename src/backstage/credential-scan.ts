export interface CredentialPattern {
  readonly name: string;
  /** Global; a fixed prefix then ONE quantified run, captured as group 1 (the body), so a scan is linear in the text. */
  readonly pattern: RegExp;
}
/**
 * Credential SHAPES, never words: a fixed vendor prefix (or the Bearer scheme, case-insensitive per RFC 7235) followed
 * by a long random body that mixes letters and digits (isTokenShaped). Words, slugs, version strings and model ids after
 * a look-alike prefix are prose. A credential in a shape not listed is not caught; pass exact values as knownKeys.
 * Any change here is checked against the PROSE_CORPUS and KEY_CORPUS tables in export-check.test.ts.
 */
export const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  { name: "Anthropic key (sk-ant-)", pattern: /sk-ant-([A-Za-z0-9_-]{32,})/g },
  { name: "OpenAI project key (sk-proj-)", pattern: /\bsk-(?:proj|svcacct|admin)-([A-Za-z0-9_-]{32,})/g },
  { name: "OpenAI key (sk-)", pattern: /\bsk-([A-Za-z0-9]{32,})/g },
  { name: "xAI key (xai-)", pattern: /\bxai-([A-Za-z0-9]{32,})/g },
  { name: "Google key (AIza)", pattern: /\bAIza([0-9A-Za-z_-]{35})/g },
  { name: "GitHub token", pattern: /\bgh[pousr]_([A-Za-z0-9]{30,})/g },
  { name: "Bearer token", pattern: /\bbearer\s+([A-Za-z0-9._~+/=-]{20,})/gi },
];
/** A random token body holds both letters and digits. */
function isTokenShaped(body: string): boolean {
  return /[0-9]/.test(body) && /[A-Za-z]/.test(body);
}
function matchesCredential({ pattern }: CredentialPattern, s: string): boolean {
  // matchAll copies the pattern, so its lastIndex never leaks between calls; each match consumes its run, so this is linear.
  for (const match of s.matchAll(pattern)) if (isTokenShaped(match[1] ?? "")) return true;
  return false;
}
/** Nesting beyond this is refused before anything else reads the export; a real export nests under ten deep. */
export const MAX_EXPORT_DEPTH = 64;
/** Values (strings, numbers, keys, containers) beyond this are refused; a 400-request run holds well under it. */
export const MAX_EXPORT_NODES = 2_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function credentialNames(s: string, knownKeys: readonly string[]): string[] {
  const names = CREDENTIAL_PATTERNS.filter((p) => matchesCredential(p, s)).map(({ name }) => `looks like a ${name}`);
  if (knownKeys.some((key) => key.length > 0 && s.includes(key))) names.push("contains a supplied key");
  return names;
}

interface Scan {
  readonly hits: string[];
  /** Set when the export is too deep or too large to scan; the scan stopped there. */
  readonly limit: string | null;
}
/**
 * Every string in the value, object keys included, checked against the patterns, iteratively and bounded. A path
 * segment from a key that matched is written {redacted}, so no hit's path, nor any path below it, carries the key.
 */
export function scan(value: unknown, knownKeys: readonly string[]): Scan {
  const hits: string[] = [];
  const stack: { value: unknown; path: string; depth: number }[] = [{ value, path: "$", depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    if (++nodes > MAX_EXPORT_NODES) return { hits, limit: `Refused: the export holds more than ${MAX_EXPORT_NODES} values.` };
    if (item.depth > MAX_EXPORT_DEPTH) return { hits, limit: `Refused: the export nests deeper than ${MAX_EXPORT_DEPTH} levels.` };
    const { value: v, path, depth } = item;
    if (typeof v === "string") for (const name of credentialNames(v, knownKeys)) hits.push(`${path}: ${name}`);
    else if (Array.isArray(v))
      for (let i = v.length - 1; i >= 0; i--) stack.push({ value: v[i], path: `${path}[${i}]`, depth: depth + 1 });
    else if (isRecord(v)) {
      const entries = Object.entries(v);
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry === undefined) continue;
        const [key, child] = entry;
        const names = credentialNames(key, knownKeys);
        const segment = names.length ? "{redacted}" : key;
        for (const name of names) hits.push(`${path}.${segment}{key}: ${name}`);
        stack.push({ value: child, path: `${path}.${segment}`, depth: depth + 1 });
      }
    }
  }
  return { hits, limit: null };
}

/** Paths and pattern names of credential-shaped strings; never the matched text, nor a matching key in a path. */
export function findCredentials(value: unknown, knownKeys: readonly string[] = []): string[] {
  const { hits, limit } = scan(value, knownKeys);
  return limit === null ? hits : [...hits, limit];
}
