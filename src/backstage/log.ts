import type { Provider } from "./contracts.ts";

export type AuthEvent = "signin.password.ok" | "signin.password.fail" | "signin.lockout" | "signin.google.ok" | "signin.google.denied" | "signout" | "session.rejected";
export type RunEvent = "run.start" | "run.done" | "run.error";
export type GoogleDeniedReason = "not-allowlisted" | "unverified-email" | "bad-state" | "provider-error" | "invalid-token";
export type SessionRejectedReason = "expired" | "revoked" | "bad-signature";
type PlainAuthEvent = Exclude<AuthEvent, "signin.google.denied" | "session.rejected">;
export type AuthLog = { event: PlainAuthEvent; email: string; ip: string; rid: string } |
  { event: "signin.google.denied"; email: string; ip: string; rid: string; reason: GoogleDeniedReason } |
  { event: "session.rejected"; email: string; ip: string; rid: string; reason: SessionRejectedReason };
export interface RunLog { event: RunEvent; rid: string; provider: Provider; model: string }

// Ported from groit apps/booth/lib/api/email-audit.js:71-100 at bb29d8cc and clearance-dealmarket-v1 backend/src/modules/buyers/lib/login-outcome.ts at e2f7cefc.
// A closed journal pipe raises an async EPIPE on stdout; one shared no-op listener keeps it from crashing the server.
const ignoreStdoutError = (): void => {};
export function createEventLogger(clock: () => number, sink?: (line: string) => void) {
  if (!sink && !process.stdout.listeners("error").includes(ignoreStdoutError)) process.stdout.on("error", ignoreStdoutError);
  const output = sink ?? ((line: string) => { process.stdout.write(line + "\n"); });
  const write = (entry: () => object): void => { try { output(JSON.stringify(entry())); } catch { /* Logging cannot affect a request. */ } };
  return {
    auth(fields: AuthLog): void {
      write(() => {
        const ts = new Date(clock()).toISOString();
        const { event, email, ip, rid } = fields;
        return fields.event === "signin.google.denied" || fields.event === "session.rejected"
          ? { ts, event, email, ip, rid, reason: fields.reason }
          : { ts, event, email, ip, rid };
      });
    },
    run(fields: RunLog): void {
      write(() => {
        const ts = new Date(clock()).toISOString();
        const { event, rid, provider, model } = fields;
        return { ts, event, rid, provider, model };
      });
    },
  };
}
