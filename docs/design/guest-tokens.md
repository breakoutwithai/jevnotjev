# Guest tokens

Library contract for `src/guest-intake/tokens.ts` (#255, child of #253, PR 2). Spec: `docs/product/guest-intake.md`, section "Guest tokens (PR 2)". This covers the store only: the HTTP routes, the `--question-admin token` CLI dispatch and the MCP adapter are integrated separately and are not in this change.

## Store

- Table `guest_tokens` in the existing private `tickets.sqlite`, created with `CREATE TABLE IF NOT EXISTS`. The `tickets` table and any other table are not read or altered. Not `api-tokens.json`.
- Columns: `id` (`gtk_` + 12 hex), `label`, `sha256`, `created_at`, `expires_at`, `revoked_at`, `last_used_at` (epoch ms integers), `scopes` (fixed text `questions:submit questions:read-own`). CHECK constraints enforce each shape. The raw token is never stored.
- On open, the stored `CREATE TABLE` text must equal the one this release writes, or the constructor throws.

## API

```ts
type GuestScope = "questions:submit" | "questions:read-own";
const GUEST_SCOPES: readonly GuestScope[];
const GUEST_TOKEN_PREFIX = "jng_";
const DEFAULT_GUEST_TTL_MS: number; // 14 days, proposed
const MIN_GUEST_TTL_MS: number;     // 1 hour, proposed
const MAX_GUEST_TTL_MS: number;     // 90 days, proposed

interface GuestTokenRecord { id; label; created; expires; revokedAt: string | null; lastUsedAt: string | null; scopes }
interface GuestMinted { token: string; record: GuestTokenRecord }
interface GuestPrincipal { tokenId: string; scope: `guest:${string}`; scopes: readonly GuestScope[] }
interface GuestMintOptions { ttlMs?: number }

class GuestTokenStore {
  constructor(path: string, clock?: () => number);
  mint(label: string, options?: GuestMintOptions): GuestMinted;
  rotate(id: string, options?: GuestMintOptions): GuestMinted;
  verify(authorization: string | null): GuestPrincipal | null;
  list(): readonly GuestTokenRecord[];
  revoke(id: string): GuestTokenRecord | null;
  close(): void;
}
```

- `mint`: operator only. Returns `jng_` + 43 base64url characters (32 random bytes) once, with its record. Label: 1 to 64 ASCII characters from `[A-Za-z0-9 _.@-]`, starting with a letter or digit, not ending in a space. `ttlMs`: a safe integer from the minimum to the maximum. Any other option key throws, so no caller can name a scope.
- `verify`: takes the raw `Authorization` header. Accepts exactly `Bearer jng_<43>`; anything else is null. A token is valid when `created <= now < expires` and it is not revoked. Every call re-reads the row, so a revoke or rotate from another instance or process applies to the next request. A valid call records `last_used_at`; the write is conditional on the same unrevoked, unexpired state, so a revoke that lands between the read and the write wins. Returns a frozen principal; `scope` is `guest:<id>`, the value the question store uses.
- `list`: metadata only, oldest first. No hash, no token. A malformed row throws.
- `revoke`: by id. Idempotent; the first revoke time is kept. Unknown id is null, a malformed id throws. The token's question rows are not touched.
- `rotate`: operator only, by id. New secret, same id and principal, old secret invalid at once, expiry restarts from now. Allowed on an expired token (renewal), refused on a revoked one.

## Separation from decide tokens

- A `jng_` token fails the decide pattern `^jnj_[A-Za-z0-9_-]{43}$` in `ApiTokenStore.verify`, even when its hash is written into a well-formed `api-tokens.json` (tested against the real verifier).
- A `jnj_` token fails the guest pattern, even when its hash sits in `guest_tokens` (tested).
- The module imports `bun:sqlite`, `node:crypto`, `node:fs` and `node:path` only, reads no environment, and makes no network call or spawn (tested).

## Fail closed

- The path must be absolute. Its directory must be a real directory, mode 0700 or narrower, owned by the running user. The file, and any `-wal` or `-shm` beside it, must be a regular file, mode 0600 or narrower, owned by the running user, and not a symlink.
- These checks run in the constructor and again at the start of every call, which also refuses a file whose inode changed since open. A failed check throws; it never returns a principal. The error names the path and mode, never a token.
- A new file is created with `O_EXCL` at 0600 before SQLite opens it.
- An invalid clock value (not a safe non-negative integer within the `Date` range) throws.

## Integration notes for the parent

- `server.ts` builds one store on the resolved tickets path and calls `verify(req.headers.get("authorization"))` for `/api/v1/guest/` before `createApiV1`. A throw is a 503, not a 401.
- `--question-admin token mint|list|revoke` maps to `mint`, `list` and `revoke`. `rotate` exists in the library; whether the CLI exposes it is the parent's decision.
- Quotas per token (10 new rows per UTC day) belong to the question store, keyed by `principal.scope`.

## Limits

- Expiry, minimum and maximum TTL are proposals until the operator approves them.
- The ownership check is not exercised by the tests (it needs a second user).
- Lookup is by an indexed sha256 of a 256-bit random secret; the store does not add a constant-time compare.
