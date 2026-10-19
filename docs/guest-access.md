# Guest access from Claude Code or Codex

A selected guest can send a decision question to the Jev!Jev team and read the reviewed reply from their own coding agent. The adapter is a local stdio MCP server, `src/guest-intake/mcp.ts` (server name `jevnotjev-guest`). Contract: `docs/product/guest-intake.md` "Guest MCP adapter (PR 3)". Issues: #253, #254, #256.

Status: the adapter, the guest HTTP routes and the token commands are built and pass an end-to-end check on a local build (`bun scripts/guest-intake/verify.ts --local`). They are not deployed, so no guest token exists yet and every tool call fails against the live site until the operator deploys and issues one. Steps marked **after deployment** wait for that.

## What it does

| Tool | Sends | Returns |
|---|---|---|
| `submit_question` | `POST /api/v1/guest/questions` | `{ id, state, replay }` |
| `get_my_question` | `GET /api/v1/guest/questions/<id>` | `{ id, state, updated_at, response, response_source }` |
| `list_my_questions` | `GET /api/v1/guest/questions` | `{ questions: [{ id, state, created_at, updated_at }] }` |

- A person reviews each question and may write a reply. No Jev run happens and the adapter calls no model.
- Only `submit_question` writes. There is no edit, withdraw or delete tool.
- `submit_question` takes `question` (1 to 4,096 characters), `reply_consent: true`, optional `marketing_consent`, and `request_key`. It takes no email, name or other identity field: the server identifies you by your token.
- `request_key` is 43 base64url characters, new for each new question. Sending the same key with the same question again returns the original id with `replay: true`; the same key with a different question is refused with `request-key-reused`. One way to make a key: `bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"))'`.
- Reads return your own rows only. Question text is never returned.
- Do not put credentials, personal data about other people, or private client data in a question.

## The entrypoint

```
bun <checkout>/src/guest-intake/mcp.ts
```

- It takes no arguments; any argument is refused with exit code 2.
- The origin is fixed in the code as `https://jevnotjev.breakoutwithai.com`. No argument, environment variable or config file changes it.
- The only value it reads from the environment is `JNJ_GUEST_TOKEN`: `jng_` followed by 43 base64url characters. A decide API token (`jnj_`) is refused, and so is anything else that does not match.
- Every request goes to `/api/v1/guest/` on that origin with redirects refused, so the token is never sent to another host. Requests are capped at 16 KiB, responses at 64 KiB, and each call at 10 seconds.

`<checkout>` is a clone of this repository at a reviewed commit, after `bun install`.

## One-time private handoff (after deployment)

1. The operator mints one token for one named guest on the host: `server.js --question-admin token mint "<guest label>"` (optionally `--ttl-days 1-90`). It is printed once and only its hash is stored.
2. The operator sends it to the guest once, over a private channel the guest already uses. Never in a GitHub issue or pull request, a shared chat channel, a screenshot, a repository, or a file that syncs to others.
3. The guest stores it as below and deletes the message. The operator keeps no copy.
4. If the token is exposed, the guest tells the operator, who revokes it and mints a new one.

## Storing the token

Keep the token in a private env file that only your user can read, and point Bun at it. The host's MCP config then holds a file path, not the token.

```sh
mkdir -p "$HOME/.config/jevnotjev" && chmod 700 "$HOME/.config/jevnotjev"
( umask 077; printf 'Paste the guest token, then Enter: '; read -rs T; echo; printf 'JNJ_GUEST_TOKEN=%s\n' "$T" > "$HOME/.config/jevnotjev/guest.env" )
```

- `read -s` keeps the token off the screen and out of shell history.
- The file is mode 0600 inside a 0700 directory. Do not commit it or put it in a synced folder.
- `GI-18-ENVFILE` in `src/guest-intake/mcp.test.ts` runs this exact form (`bun --env-file=<file> src/guest-intake/mcp.ts`) and checks the token reaches only the fixed origin.

## Claude Code

```sh
claude mcp add jevnotjev-guest --scope user -- bun --env-file="$HOME/.config/jevnotjev/guest.env" <checkout>/src/guest-intake/mcp.ts
```

Use `/mcp` in Claude Code to see the server and reconnect it after the token file changes. Do not pass the token with `-e JNJ_GUEST_TOKEN=...`: that writes it into the Claude Code config file.

## Codex

```sh
codex mcp add jevnotjev-guest -- bun --env-file="$HOME/.config/jevnotjev/guest.env" <checkout>/src/guest-intake/mcp.ts
```

Do not pass the token with `--env JNJ_GUEST_TOKEN=...`: that writes it into `~/.codex/config.toml`. Restart Codex after the token file changes.

## Renew or revoke (after deployment)

- Tokens expire (proposed default 14 days, not yet approved). To renew, ask the operator: they run `server.js --question-admin token rotate <id>` on the host and hand the new token over as above. Rotation keeps your id, so your earlier questions stay readable; the old token stops working at once. Replace the line in `guest.env` and reconnect the server.
- Revoking a token (`token revoke <id>`) stops its reads and submissions on the next request. Questions already sent stay in the queue.
- There is no self-service renew or revoke from the adapter.

## Errors

A failed call returns `{ "error": { "code": ..., "status": ... } }`; `status` is the HTTP status when there was one. The token is never in a result or an error.

| Code | Meaning |
|---|---|
| `token-missing` | `JNJ_GUEST_TOKEN` is not set for the server |
| `token-invalid` | The value is not `jng_` + 43 base64url characters |
| `unauthenticated` (401) | Token unknown, expired, revoked or replaced by a rotation |
| `rate-limited` (429) | Too many submissions from your network in 10 minutes; nothing was stored |
| `auth-unavailable` (503) | The server cannot check tokens right now; nothing was stored |
| `not-found` (404) | No question with that id for this token |
| `request-key-reused` (409) | Same `request_key`, different question |
| `deleted` (410) | That `request_key` belonged to a deleted question |
| `capacity` (503) | Intake is full or over quota; nothing was stored |
| `request-too-large` | The request body is over 16 KiB; nothing was sent |
| `response-too-large` | The reply was over 64 KiB and was dropped |
| `timeout` | No complete reply within 10 seconds |
| `redirect-refused` | The server answered with a redirect |
| `non-json-response` | The reply was not JSON |
| `invalid-response` | The reply did not match the guest schema |
| `network-error` | The origin could not be reached |
| `http-error` | Any other non-2xx reply without a known code |

## Operator access (#282)

The operator's own agent can list, read and answer submitted `/ask/` questions through a second stdio MCP server, `src/guest-intake/admin-mcp.ts` (server name `jevnotjev-admin`), using an operator token. It is not for guests. Status: built and tested locally; not deployed, so no operator token exists until the operator deploys and mints one.

| Tool | Sends | Returns |
|---|---|---|
| `list_questions` | `GET /api/v1/admin/questions` | `{ total, questions: [{ id, state, created_at, updated_at, version }] }`, newest first, at most 200 |
| `get_question` | `GET /api/v1/admin/questions/<id>` | `{ id, created_at, updated_at, email, question, state, version, response, response_source }` |
| `reply_question` | `POST /api/v1/admin/questions/<id>/reply` | `{ id, state, version }` |

- `reply_question` takes `id`, `version` (from `get_question`), `to`, and `text` and `source` only when `to` is `needs_info` or `answered`. Text sent with any other target is refused with `text-not-stored`; a stale version is `stale-version` (409). These are the CLI's and the `/backstage/questions/` page's rules, through the same store methods.
- There is no delete or purge tool or route; those stay CLI-only.
- `list_questions` and `get_question` are marked read-only for the client. The server enforces it: the read routes are GET-only and never write.
- The same safety posture as the guest adapter: fixed origin `https://jevnotjev.breakoutwithai.com`, redirects refused, requests capped at 64 KiB (nginx's `/api/v1/` limit), responses at 256 KiB, 10 seconds per call, the token never in a result.
- The only environment value it reads is `JNJ_ADMIN_TOKEN`: `jna_` followed by 43 base64url characters. A guest (`jng_`) or decide (`jnj_`) token is refused locally and by the server, and an operator token is refused by the guest and decide routes.

### Mint (on the host, after deployment)

```sh
sudo -u jevnotjev-backstage env STATE_DIRECTORY=/var/lib/jevnotjev-backstage \
  /usr/local/bin/bun /var/www/jevnotjev-backstage-current/server.js --question-admin admin-token mint "<device label>"
```

- `--ttl-days 1-30` sets the lifetime; the default is 7 days. The token is printed once; only its sha256 is stored, in `admin_tokens` in `tickets.sqlite`.
- `admin-token list` shows ids, labels, expiry and status, never a token. `admin-token rotate <atk_id>` renews: same id, new secret printed once, old secret refused at once.

### Store it and add it to Claude Code

```sh
mkdir -p "$HOME/.config/jevnotjev" && chmod 700 "$HOME/.config/jevnotjev"
( umask 077; printf 'Paste the operator token, then Enter: '; read -rs T; echo; printf 'JNJ_ADMIN_TOKEN=%s\n' "$T" > "$HOME/.config/jevnotjev/admin.env" )
claude mcp add jevnotjev-admin --scope user -- bun --env-file="$HOME/.config/jevnotjev/admin.env" <checkout>/src/guest-intake/admin-mcp.ts
```

Reconnect with `/mcp` after the file changes. Do not pass the token with `-e JNJ_ADMIN_TOKEN=...`: that writes it into the Claude Code config file.

### Revoke

`server.js --question-admin admin-token revoke <atk_id>` on the host. The admin API refuses the token from the next request; a reply whose body was still uploading is refused too. Then delete the line from `admin.env`.
