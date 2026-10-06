import { join, resolve, sep } from "node:path";
import { isIP } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { cookie, cookieName, credentialFingerprint, GoogleStates, inspectSession, isSameOrigin, LoginLimiter, normalizeEmail, OperatorStore, parseCookie, RevokedSessions, sanitizeNextPath, SESSION_TTL_MS, signSession, validateGoogleProfile, verifyPasswordHash } from "./auth.ts";
import { createEventLogger } from "./log.ts";
import type { AuthEvent, GoogleDeniedReason, SessionRejectedReason, RunEvent } from "./log.ts";
import type { Provider } from "./contracts.ts";
import { renderSignInPage } from "./sign-in-page.ts";
import { CATALOG_VERSION, MODEL_CATALOG, getModelEntry } from "./catalog.ts";
import { PROTOCOL_VERSION } from "./contracts.ts";
import {
  boundedText,
  callProvider,
  validateAnswerRequest,
  dispatchError,
} from "./providers.ts";
import type { ProviderFetch } from "./providers.ts";
import { openTrial, validTrialInput } from "./trial.ts";
import type { TrialConfig } from "./trial.ts";
declare const BACKSTAGE_BUILD_VERSION: string;
export function runtimeVersion(
  configured: string | undefined,
  compiled: string,
): string {
  if (!/^[a-f0-9]{40}$/.test(compiled) || configured !== compiled)
    throw new Error(
      "BACKSTAGE_VERSION must match the compiled server revision.",
    );
  return compiled;
}
export interface ServerOptions {
  readonly version: string;
  readonly staticRoot?: string;
  readonly origin?: string;
  readonly maxConcurrent?: number;
  readonly providerFetch?: ProviderFetch;
  readonly timeoutMs?: number;
  readonly trialConfig?: TrialConfig;
  readonly trialPricingVersion?: string;
  readonly trustProxy?: boolean;
  readonly requireSession?: boolean;
  readonly log?: (line: string) => void;
  readonly auth?: {
    readonly sessionSecret?: string | undefined;
    readonly operatorsPath?: string | undefined;
    readonly googleClientId?: string | undefined;
    readonly googleClientSecret?: string | undefined;
    readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    readonly googleFetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
    readonly clock?: () => number;
  };
}
export interface RequestContext {
  readonly remoteAddress?: string;
}
export interface BackstageHandler {
  (request: Request, context?: RequestContext): Promise<Response>;
  close(): void;
}
export const TRIAL_MIN_RESERVATION_MICRO_USD = 2753;
export function trialConfigFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): TrialConfig | undefined {
  if (!env.BACKSTAGE_TRIAL_KEY) return undefined;
  return {
    path: env.BACKSTAGE_TRIAL_LEDGER_PATH ?? "",
    fundedKey: env.BACKSTAGE_TRIAL_KEY,
    signingSecret: env.BACKSTAGE_TRIAL_SIGNING_SECRET ?? "",
    pricingVerified: env.BACKSTAGE_TRIAL_PRICING_VERSION === CATALOG_VERSION,
    worstCostMicroUsd: Number(env.BACKSTAGE_TRIAL_WORST_COST_MICRO_USD),
    dailyBudgetMicroUsd: Number(env.BACKSTAGE_TRIAL_DAILY_BUDGET_MICRO_USD),
    dailyMintLimit: Number(env.BACKSTAGE_TRIAL_DAILY_MINT_LIMIT),
    dailyNetworkMintLimit: Number(env.BACKSTAGE_TRIAL_DAILY_NETWORK_MINT_LIMIT),
    dailyNetworkAttemptLimit: Number(
      env.BACKSTAGE_TRIAL_DAILY_NETWORK_ATTEMPT_LIMIT,
    ),
  };
}
const HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};
function clientAddress(request: Request, context: RequestContext | undefined, trustProxy: boolean | undefined): string | null {
  const socket = context?.remoteAddress;
  const loopback = socket === "127.0.0.1" || socket === "::1" || socket === "::ffff:127.0.0.1";
  const address = trustProxy && loopback ? request.headers.get("x-backstage-client-ip") : socket;
  return address && isIP(address) ? address : null;
}
function json(value: unknown, status = 200): Response {
  const payload =
    status >= 400 &&
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    !("code" in value) &&
    typeof value.error === "string"
      ? dispatchError(
          status === 403
            ? "origin-rejected"
            : status === 503
              ? "runner-busy"
              : "request-rejected",
          value.error,
        )
      : value;
  return Response.json(payload, { status, headers: HEADERS });
}
export function createHandler(options: ServerOptions): BackstageHandler {
  const clock = options.auth?.clock ?? Date.now;
  const secret = options.auth?.sessionSecret ?? "";
  const origin = options.origin ?? "http://localhost:3456";
  const operators = new OperatorStore(options.auth?.operatorsPath);
  const limiter = new LoginLimiter(clock);
  const states = new GoogleStates(clock, secret);
  const revoked = new RevokedSessions(clock, options.auth?.operatorsPath);
  const googleReady = Boolean(options.auth?.googleClientId && options.auth.googleClientSecret && secret.length >= 32);
  const logger = createEventLogger(clock, options.log);
  const sessionFrom = (request: Request, emit: (event: "session.rejected", email: string, reason: SessionRejectedReason) => void) => {
    const header = request.headers.get("cookie");
    const name = cookieName(origin, "session");
    const value = parseCookie(header, name);
    if (secret.length < 32) return null;
    if (!value) {
      if (header?.split(";").some((part) => { const index = part.indexOf("="); return (index < 0 ? part : part.slice(0, index)).trim() === name; }))
        emit("session.rejected", "unknown", "bad-signature");
      return null;
    }
    const checked = inspectSession(value, secret, clock());
    if (!checked.ok) { emit("session.rejected", checked.reason === "expired" ? operators.get(checked.email)?.email ?? "unknown" : "unknown", checked.reason); return null; }
    const session = checked.session;
    const row = operators.get(session.email);
    if (!row || revoked.has(session.sid, session.iat) || session.cred !== credentialFingerprint(row.password_hash ?? "google")) {
      emit("session.rejected", row?.email ?? "unknown", "revoked");
      return null;
    }
    return session;
  };
  const redirect = (location: string, status = 303): Response => new Response(null, { status, headers: { ...HEADERS, location } });
  const denied = (): Response => Response.json({ code: "unauthenticated" }, { status: 401, headers: HEADERS });
  const authError = (code: string): Response => redirect(`/backstage/sign-in?error=${code}`);
  let active = 0,
    activeScrypt = 0,
    activeTrial = 0,
    activeByok = 0,
    fundingHeld = false;
  const entry = getModelEntry("jev"),
    funded = options.trialConfig;
  // Reserve the entire documented 64K input context, not a guessed character/token ratio.
  const trial = openTrial(
    funded &&
      options.trialPricingVersion === CATALOG_VERSION &&
      funded.worstCostMicroUsd >= TRIAL_MIN_RESERVATION_MICRO_USD &&
      entry?.modelId === "jev-1.13.0" &&
      entry.pricing?.inputUsdPerMillion === 0.042 &&
      entry.pricing.outputUsdPerMillion === 0 &&
      /^[\x21-\x7e]{8,512}$/.test(funded.fundedKey)
      ? funded
      : undefined,
  );
  const root = resolve(options.staticRoot ?? "site"),
    trialCookieName = "backstage_trial";
  const handler = async (
    request: Request,
    context?: RequestContext,
  ): Promise<Response> => {
    const rid = randomUUID();
    const ip = clientAddress(request, context, options.trustProxy) ?? "unknown";
    const emitAuth = (event: AuthEvent, email: string, reason?: GoogleDeniedReason | SessionRejectedReason): void => {
      if (event === "session.rejected") {
        logger.auth({ event, email, ip, rid, reason: reason === "expired" || reason === "revoked" ? reason : "bad-signature" });
      } else if (event === "signin.google.denied") {
        logger.auth({ event, email, ip, rid, reason: reason === "not-allowlisted" || reason === "unverified-email" || reason === "bad-state" || reason === "invalid-token" ? reason : "provider-error" });
      } else logger.auth({ event, email, ip, rid });
    };
    const emitRun = (event: RunEvent, provider: Provider, armId: string): void => {
      const entry = getModelEntry(armId);
      logger.run({ event, rid, provider, model: entry?.provider === provider ? entry.modelId : "unknown" });
    };
    const url = new URL(request.url);
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); }
    catch { return json({ error: "Not found." }, 404); }
    if (pathname.includes("\\") || pathname.includes("//") || pathname.split("/").some((segment) => segment === "." || segment === ".."))
      return json({ error: "Not found." }, 404);
    const lowerPathname = pathname.toLowerCase();
    const gatedPrefix = lowerPathname.startsWith("/backstage/") ? "/backstage/" : lowerPathname.startsWith("/api/backstage/") ? "/api/backstage/" : null;
    if (gatedPrefix && pathname.slice(0, gatedPrefix.length) !== gatedPrefix) return json({ error: "Not found." }, 404);
    if (pathname === "/backstage/sign-in" && request.method === "GET") {
      const message = url.searchParams.get("signed-out") === "1" ? "signed-out" : url.searchParams.get("error");
      return renderSignInPage(sanitizeNextPath(url.searchParams.get("next")), message, googleReady, HEADERS["content-security-policy"]);
    }
    if (pathname === "/api/auth/session") return request.method === "GET" ? (sessionFrom(request, emitAuth) ? new Response(null, { status: 204, headers: HEADERS }) : Response.json({ code: "unauthenticated", signIn: secret.length >= 32 ? "ready" : "unconfigured" }, { status: 401, headers: HEADERS })) : json({ error: "Method not allowed." }, 405);
    if (pathname === "/api/auth/password") {
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
      if (!isSameOrigin(request, origin)) return json({ error: "Forbidden." }, 403);
      let email = "", password = "", next = "/backstage/";
      const body = await request.text();
      if (body) {
        if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/x-www-form-urlencoded") { emitAuth("signin.password.fail", "unknown"); return authError("signin"); }
        const form = new URLSearchParams(body);
        email = form.get("email") ?? ""; password = form.get("password") ?? "";
        next = sanitizeNextPath(form.get("next"));
      } else {
        const basic = request.headers.get("authorization") ?? "";
        if (basic.startsWith("Basic ")) {
          try {
            const decoded = Buffer.from(basic.slice(6), "base64").toString("utf8");
            const separator = decoded.indexOf(":");
            if (separator >= 0) { email = decoded.slice(0, separator); password = decoded.slice(separator + 1); }
          } catch { /* Invalid credentials take the ordinary failure path. */ }
        }
      }
      email = normalizeEmail(email);
      const socket = context?.remoteAddress;
      const observed = options.trustProxy && (socket === "127.0.0.1" || socket === "::1" || socket === "::ffff:127.0.0.1") ? clientAddress(request, context, true) : null;
      const address = observed === "127.0.0.1" || observed === "::1" || observed === "::ffff:127.0.0.1" ? null : observed;
      const row = operators.get(email);
      const loggedEmail = row?.email ?? "unknown";
      if (limiter.locked(email, address)) { emitAuth("signin.lockout", loggedEmail); return authError("locked"); }
      if (activeScrypt >= 8) { emitAuth("signin.password.fail", loggedEmail); return authError("busy"); }
      if (!limiter.canAttempt(email, address)) { emitAuth("signin.password.fail", loggedEmail); return authError("busy"); }
      activeScrypt++;
      let verified: boolean;
      try { verified = await verifyPasswordHash(password, row?.password_hash); }
      finally { activeScrypt--; }
      const valid = secret.length >= 32 && verified && Boolean(row);
      if (!valid) { const failure = limiter.fail(email, address); emitAuth("signin.password.fail", loggedEmail); if (failure.locked) emitAuth("signin.lockout", loggedEmail); return authError("signin"); }
      limiter.success(email, address);
      const session = signSession({ email, auth: "password", iat: clock(), exp: clock() + SESSION_TTL_MS, sid: randomBytes(24).toString("base64url"), cred: credentialFingerprint(row?.password_hash ?? "google") }, secret);
      const response = redirect(next);
      response.headers.append("set-cookie", cookie(origin, "session", session, 43200));
      emitAuth("signin.password.ok", loggedEmail);
      return response;
    }
    if (pathname === "/api/auth/sign-out") {
      if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
      if (!isSameOrigin(request, origin)) return json({ error: "Forbidden." }, 403);
      const session = sessionFrom(request, emitAuth);
      if (session) {
        try { revoked.revoke(session.sid, session.exp); }
        catch { return Response.json({ code: "signout-failed" }, { status: 500, headers: HEADERS }); }
      }
      const response = redirect("/backstage/sign-in?signed-out=1");
      response.headers.append("set-cookie", cookie(origin, "session", "", 0));
      emitAuth("signout", session ? operators.get(session.email)?.email ?? "unknown" : "unknown");
      return response;
    }
    if (pathname === "/api/auth/google") {
      if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
      if (!googleReady || !options.auth?.googleClientId) return json({ error: "Google sign-in unavailable." }, 503);
      const { state, nonce } = states.start(sanitizeNextPath(url.searchParams.get("next")));
      const target = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      target.searchParams.set("client_id", options.auth.googleClientId);
      target.searchParams.set("redirect_uri", `${origin}/api/auth/google/callback`);
      target.searchParams.set("response_type", "code");
      target.searchParams.set("scope", "openid email profile");
      target.searchParams.set("state", state);
      target.searchParams.set("access_type", "online");
      target.searchParams.set("prompt", "select_account");
      const response = redirect(target.toString(), 302);
      response.headers.append("set-cookie", cookie(origin, "oauth", nonce, 600));
      return response;
    }
    if (pathname === "/api/auth/google/callback") {
      if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
      if (!googleReady || !options.auth?.googleClientId || !options.auth.googleClientSecret) return json({ error: "Google sign-in unavailable." }, 503);
      const responseError = authError("google");
      const clear = cookie(origin, "oauth", "", 0);
      const state = url.searchParams.get("state") ?? "";
      const next = states.take(state, parseCookie(request.headers.get("cookie"), cookieName(origin, "oauth")));
      if (!next || url.searchParams.has("error") || !url.searchParams.get("code")) {
        const reason = !next ? "bad-state" : url.searchParams.has("error") ? "provider-error" : "bad-state";
        emitAuth("signin.google.denied", "unknown", reason);
        responseError.headers.append("set-cookie", clear);
        return responseError;
      }
      try {
        // Ported from groit apps/booth/server.js:1720-1765 at bb29d8cc; test bypass omitted.
        const doFetch = options.auth.fetch ?? options.auth.googleFetch ?? fetch;
        const token = await doFetch("https://oauth2.googleapis.com/token", { method: "POST", signal: AbortSignal.timeout(10_000), headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code: url.searchParams.get("code") ?? "", client_id: options.auth.googleClientId, client_secret: options.auth.googleClientSecret, redirect_uri: `${origin}/api/auth/google/callback`, grant_type: "authorization_code" }) });
        if (!token.ok) throw new Error("Token exchange failed");
        const tokenData: unknown = await token.json();
        if (typeof tokenData !== "object" || tokenData === null || !("id_token" in tokenData) || typeof tokenData.id_token !== "string" || !tokenData.id_token) throw new Error("Missing token");
        const info = await doFetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenData.id_token)}`, { signal: AbortSignal.timeout(10_000) });
        if (!info.ok) throw new Error("Tokeninfo failed");
        const profile: unknown = await info.json();
        const checked = validateGoogleProfile(profile, options.auth.googleClientId, operators);
        if (!checked.ok) { emitAuth("signin.google.denied", checked.email, checked.reason); responseError.headers.append("set-cookie", clear); return responseError; }
        const row = operators.get(checked.email);
        if (!row) { emitAuth("signin.google.denied", "unknown", "not-allowlisted"); responseError.headers.append("set-cookie", clear); return responseError; }
        const session = signSession({ email: checked.email, auth: "google", iat: clock(), exp: clock() + SESSION_TTL_MS, sid: randomBytes(24).toString("base64url"), cred: credentialFingerprint(row.password_hash ?? "google") }, secret);
        const response = redirect(next);
        response.headers.append("set-cookie", clear);
        response.headers.append("set-cookie", cookie(origin, "session", session, 43200));
        emitAuth("signin.google.ok", row.email);
        return response;
      } catch { emitAuth("signin.google.denied", "unknown", "provider-error"); responseError.headers.append("set-cookie", clear); return responseError; }
    }
    if ((options.requireSession === true || request.headers.get("x-backstage-gate") === "session") && gatedPrefix && !sessionFrom(request, emitAuth)) {
      if (gatedPrefix === "/api/backstage/") return denied();
      return redirect(`/backstage/sign-in?next=${sanitizeNextPath(pathname)}`, 302);
    }
    const trialHeld = trial.available && (fundingHeld || trial.ledger.held());
    if (pathname === "/api/backstage/health")
      return request.method === "GET"
        ? json({
            protocol: PROTOCOL_VERSION,
            version: options.version,
            catalogVersion: CATALOG_VERSION,
            catalog: MODEL_CATALOG,
            origin: options.origin ?? url.origin,
            trial:
              trial.available && !trialHeld
                ? {
                    available: true,
                    limits: {
                      question: 200,
                      choiceName: 32,
                      choiceDefinition: 200,
                      input: 1000,
                    },
                  }
                : {
                    available: false,
                    reason: trialHeld
                      ? "Trial accounting is unavailable."
                      : trial.available
                        ? "Trial unavailable."
                        : trial.reason,
                  },
          })
        : json({ error: "Method not allowed." }, 405);
    if (
      [
        "/api/backstage/answer",
        "/api/backstage/trial/mint",
        "/api/backstage/trial/answer",
      ].includes(pathname)
    ) {
      const trialRoute = pathname.startsWith("/api/backstage/trial/");
      if (request.method !== "POST")
        return json({ error: "Method not allowed." }, 405);
      if (
        request.headers.get("origin") !== (options.origin ?? url.origin) ||
        request.headers.get("sec-fetch-site") === "cross-site"
      )
        return json({ error: "Same-origin requests required." }, 403);
      if (
        request.headers.get("content-type")?.split(";")[0]?.trim() !==
        "application/json"
      )
        return json({ error: "JSON required." }, 415);
      if (
        active >= (options.maxConcurrent ?? 8) ||
        (trialRoute ? activeTrial >= 2 : activeByok >= 6)
      )
        return json(
          dispatchError(
            "runner-busy",
            "Runner busy. Retry explicitly when ready.",
          ),
          503,
        );
      active++;
      if (trialRoute) activeTrial++;
      else activeByok++;
      try {
        if (Number(request.headers.get("content-length") ?? 0) > 65536)
          return json({ error: "Request too large." }, 413);
        const raw = await boundedText(
          new Response(request.body),
          65536,
          AbortSignal.timeout(5000),
        );
        const decoded: unknown = JSON.parse(raw);
        if (trialRoute) {
          const publicOrigin = new URL(options.origin ?? url.origin);
          if (
            publicOrigin.protocol !== "https:" &&
            !["localhost", "127.0.0.1", "[::1]"].includes(publicOrigin.hostname)
          )
            return json(
              dispatchError(
                "trial-unavailable",
                "Funded trials require a secure public origin.",
              ),
              503,
            );
          if (!trial.available || trialHeld || !funded)
            return json(
              dispatchError(
                "trial-unavailable",
                "The funded trial is unavailable. Use your own key or Playground.",
              ),
              503,
            );
          const token =
            request.headers
              .get("cookie")
              ?.split(";")
              .map((v) => v.trim())
              .find((v) => v.startsWith(`${trialCookieName}=`))
              ?.slice(trialCookieName.length + 1) ?? "";
          if (pathname.endsWith("/mint")) {
            if (trial.ledger.verify(token)) return json({ available: true });
            const address = clientAddress(request, context, options.trustProxy);
            if (!address)
              return json(
                dispatchError(
                  "trial-unavailable",
                  "Trial network identity is unavailable.",
                ),
                503,
              );
            const minted = trial.ledger.mint(address);
            if (minted.kind === "denied")
              return json(
                dispatchError(
                  minted.code,
                  "Trial allowance is unavailable or exhausted.",
                ),
                429,
              );
            const response = json({ available: true });
            response.headers.set(
              "set-cookie",
              `${trialCookieName}=${minted.token}; HttpOnly; SameSite=Strict; Path=/api/backstage/trial; Max-Age=7776000${publicOrigin.protocol === "https:" ? "; Secure" : ""}`,
            );
            return response;
          }
          if (
            typeof decoded !== "object" ||
            decoded === null ||
            Array.isArray(decoded) ||
            !("idempotencyKey" in decoded) ||
            typeof decoded.idempotencyKey !== "string" ||
            "key" in decoded
          )
            return json(
              dispatchError("invalid-request", "Invalid trial request."),
              400,
            );
          const { idempotencyKey, ...decision } = decoded;
          const checked = validateAnswerRequest({
            ...decision,
            key: funded.fundedKey,
          });
          if (!checked.ok) return json(checked.error, 400);
          const input = checked.request;
          if (input.revision !== options.version)
            return json(
              dispatchError(
                "revision-mismatch",
                "Page and runner versions differ. Reload before running.",
              ),
              409,
            );
          if (input.armId !== "jev" || !validTrialInput(input))
            return json(
              dispatchError(
                "invalid-request",
                "Trial supports one small Jev case only.",
              ),
              400,
            );
          const reservation = trial.ledger.reserve(
            token,
            idempotencyKey,
            input,
          );
          if (reservation.kind !== "reserved")
            return json(
              dispatchError(
                reservation.kind === "replay"
                  ? "trial-replay"
                  : reservation.code,
                reservation.kind === "replay"
                  ? "This trial request was already submitted; it will not be charged again."
                  : "Trial allowance is unavailable or exhausted.",
              ),
              429,
            );
          // A dispatched failure never restores the browser allowance automatically.
          emitRun("run.start", input.provider, input.armId);
          let result;
          try { result = await callProvider(input, options.providerFetch, options.timeoutMs); }
          catch (error) { emitRun("run.error", input.provider, input.armId); throw error; }
          emitRun(result.ok ? "run.done" : "run.error", input.provider, input.armId);
          const fundingFailure =
            !result.ok &&
            ["http-401", "http-403", "http-429"].includes(result.code);
          if (fundingFailure) fundingHeld = true;
          try {
            trial.ledger.settle(
              reservation.reservationId,
              fundingFailure && !result.ok
                ? { kind: "unknown", code: result.code }
                : result.costUsd !== null
                  ? {
                      kind: "known",
                      costMicroUsd: Math.ceil(result.costUsd * 1e6),
                    }
                  : {
                      kind: "unknown",
                      code: result.ok ? "missing-cost" : result.code,
                    },
            );
          } catch {
            fundingHeld = true;
          }
          return json(result);
        }
        const validated = validateAnswerRequest(decoded);
        if (!validated.ok)
          return json(
            validated.error,
            validated.error.code.endsWith("mismatch") ? 409 : 400,
          );
        const input = validated.request;
        if (input.revision !== options.version)
          return json(
            dispatchError(
              "revision-mismatch",
              "Page and runner versions differ. Reload before running.",
            ),
            409,
          );
        emitRun("run.start", input.provider, input.armId);
        try {
          const result = await callProvider(input, options.providerFetch, options.timeoutMs);
          emitRun(result.ok ? "run.done" : "run.error", input.provider, input.armId);
          return json(result);
        } catch (error) { emitRun("run.error", input.provider, input.armId); throw error; }
      } catch {
        return json({ error: "Invalid or oversized request." }, 400);
      } finally {
        active--;
        if (trialRoute) activeTrial--;
        else activeByok--;
      }
    }
    if (pathname.startsWith("/api/"))
      return json({ error: "Not found." }, 404);
    if (request.method !== "GET" && request.method !== "HEAD")
      return json({ error: "Method not allowed." }, 405);
    const path = pathname;
    if (path.split("/").some((p) => p.startsWith(".")))
      return json({ error: "Not found." }, 404);
    const target = resolve(
      root,
      `.${path.endsWith("/") ? `${path}index.html` : path}`,
    );
    if (!target.startsWith(`${root}${sep}`))
      return json({ error: "Not found." }, 404);
    const file = Bun.file(target);
    if (!(await file.exists())) return json({ error: "Not found." }, 404);
    const headers: Record<string, string> = {
      ...HEADERS,
      "content-type": file.type,
    };
    // Legacy stage pages already rely on inline scripts. Scope the new policy to Backstage.
    if (
      !target
        .toLowerCase()
        .startsWith(`${resolve(root, "backstage").toLowerCase()}${sep}`)
    )
      delete headers["content-security-policy"];
    return new Response(request.method === "HEAD" ? null : file, { headers });
  };
  return Object.assign(handler, {
    close() {
      if (trial.available) trial.ledger.close();
    },
  });
}
if (import.meta.main) {
  const version = runtimeVersion(
    process.env.BACKSTAGE_VERSION,
    BACKSTAGE_BUILD_VERSION,
  );
  const port = Number(process.env.PORT ?? "3456");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT.");
  const origin = process.env.BACKSTAGE_ORIGIN ?? `http://localhost:${port}`;
  if (new URL(origin).origin !== origin)
    throw new Error("BACKSTAGE_ORIGIN must be an origin.");
  const trialConfig = trialConfigFromEnvironment(process.env);
  const handler = createHandler({
    version,
    origin,
    staticRoot: process.env.BACKSTAGE_STATIC_ROOT ?? "site",
    ...(trialConfig ? { trialConfig } : {}),
    trialPricingVersion: process.env.BACKSTAGE_TRIAL_PRICING_VERSION ?? "",
    trustProxy: process.env.BACKSTAGE_TRUST_PROXY === "loopback",
    requireSession: process.env.BACKSTAGE_REQUIRE_SESSION === "1",
    auth: {
      sessionSecret: process.env.BACKSTAGE_SESSION_SECRET,
      operatorsPath: process.env.BACKSTAGE_OPERATORS_PATH ?? (process.env.STATE_DIRECTORY ? join(process.env.STATE_DIRECTORY, "operators.json") : undefined),
      googleClientId: process.env.BACKSTAGE_GOOGLE_CLIENT_ID,
      googleClientSecret: process.env.BACKSTAGE_GOOGLE_CLIENT_SECRET,
    },
  });
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    maxRequestBodySize: 65536,
    idleTimeout: 40,
    fetch(request, server) {
      const address = server.requestIP(request)?.address;
      return handler(request, address ? { remoteAddress: address } : undefined);
    },
  });
  console.info(`Backstage ${version} listening on 127.0.0.1:${port}`);
}
