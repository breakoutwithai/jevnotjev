import { resolve, sep } from "node:path";
import { MODELS, PROTOCOL_VERSION } from "./contracts.ts";
import { boundedText, callProvider, parseAnswerRequest } from "./providers.ts";
import type { ProviderFetch } from "./providers.ts";
export interface ServerOptions {
  readonly version: string;
  readonly staticRoot?: string;
  readonly origin?: string;
  readonly maxConcurrent?: number;
  readonly providerFetch?: ProviderFetch;
  readonly timeoutMs?: number;
}
const HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: HEADERS });
}
export function createHandler(
  options: ServerOptions,
): (request: Request) => Promise<Response> {
  let active = 0;
  const root = resolve(options.staticRoot ?? "site");
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/backstage/health")
      return request.method === "GET"
        ? json({
            protocol: PROTOCOL_VERSION,
            version: options.version,
            models: MODELS,
          })
        : json({ error: "Method not allowed." }, 405);
    if (url.pathname === "/api/backstage/answer") {
      if (request.method !== "POST")
        return json({ error: "Method not allowed." }, 405);
      if (request.headers.get("origin") !== (options.origin ?? url.origin))
        return json({ error: "Same-origin requests required." }, 403);
      if (request.headers.get("sec-fetch-site") === "cross-site")
        return json({ error: "Same-origin requests required." }, 403);
      if (
        request.headers.get("content-type")?.split(";")[0]?.trim() !==
        "application/json"
      )
        return json({ error: "JSON required." }, 415);
      if (active >= (options.maxConcurrent ?? 8))
        return json(
          { error: "Runner busy. Retry explicitly when ready." },
          503,
        );
      active++;
      try {
        if (Number(request.headers.get("content-length") ?? 0) > 65536)
          return json({ error: "Request too large." }, 413);
        // Bound both byte size and upload time before parsing. No user data is logged.
        const raw = await boundedText(
          new Response(request.body),
          65536,
          AbortSignal.timeout(5000),
        );
        const input = parseAnswerRequest(JSON.parse(raw));
        if (!input)
          return json(
            { error: "Invalid request. Check case, options and credentials." },
            400,
          );
        return json(
          await callProvider(input, options.providerFetch, options.timeoutMs),
        );
      } catch {
        return json({ error: "Invalid or oversized request." }, 400);
      } finally {
        active--;
      }
    }
    if (url.pathname.startsWith("/api/"))
      return json({ error: "Not found." }, 404);
    if (request.method !== "GET" && request.method !== "HEAD")
      return json({ error: "Method not allowed." }, 405);
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return json({ error: "Not found." }, 404);
    }
    if (path.split("/").some((p) => p.startsWith(".")) || path.includes("\\"))
      return json({ error: "Not found." }, 404);
    const target = resolve(
      root,
      `.${path.endsWith("/") ? `${path}index.html` : path}`,
    );
    if (!target.startsWith(`${root}${sep}`))
      return json({ error: "Not found." }, 404);
    const file = Bun.file(target);
    if (!(await file.exists())) return json({ error: "Not found." }, 404);
    return new Response(request.method === "HEAD" ? null : file, {
      headers: { ...HEADERS, "content-type": file.type },
    });
  };
}
if (import.meta.main) {
  const version = process.env.BACKSTAGE_VERSION;
  if (!version) throw new Error("BACKSTAGE_VERSION is required.");
  const port = Number(process.env.PORT ?? "3456");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT.");
  const origin = process.env.BACKSTAGE_ORIGIN ?? `http://localhost:${port}`;
  if (new URL(origin).origin !== origin)
    throw new Error("BACKSTAGE_ORIGIN must be an origin.");
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 65536,
    idleTimeout: 40,
    fetch: createHandler({
      version,
      origin,
      staticRoot: process.env.BACKSTAGE_STATIC_ROOT ?? "site",
    }),
  });
  console.info(`Backstage ${version} listening on 127.0.0.1:${port}`);
}
