# Monitoring and alerting for the site and Backstage (#106)

Status: built in the PR that refs #106. Not installed on any host: installation is the operator steps at the end of this file. Base `origin/main` at aa23633.

## Estate survey (2026-10-06)

Question: what does the estate already run for uptime checks, TLS expiry, restart monitoring and alert delivery, so #106 reuses it instead of adding a tool. Searched: breakout-infra, breakout-hermes, groit, trade-shows-whitelabel, clearance-dealmarket-v1 (each at its local `origin/main`; breakout-infra's `origin/main` is a 10-file skeleton, so its working tree on `refactor/deployment-engineer-v02` was read too), `~/.claude/knowledge/`, `~/.claude/scripts/`, `~/.agents/skills/`, `~/.claude/skills/`, `~/Library/LaunchAgents/`, `/Library/LaunchDaemons/` and the workstation crontab. No host was contacted and no `.env*` file was read.

**Result: no live external uptime monitor or web-health alert exists anywhere in the estate.** Every web-health or alert mechanism found is disabled, repo-only, deploy-time only, or watches something else. What is reusable is patterns, not a running service.

| Mechanism | Where | What it does | Live? |
|---|---|---|---|
| openclaw health check | `~/.claude/scripts/openclaw-health-check.sh:20` `ALERTS_ENABLED=false  # DISABLED 2026-04-14`; TLS at `:187-189` `openssl x509 ... -checkend 604800`, then `-checkend 0`; cooldown and last-status file at `:236-282` | HTTP, TLS expiry, services on ts-openclaw; Telegram | No. Alerts disabled; host offline in the 2026-09-15 tailnet listing (`kb-tailnet-server-access.md`) |
| stack health probe | `~/.claude/scripts/stack-health-probe.sh:13` `ALERTS_ENABLED=false` | SSH health of two tailnet hosts; Telegram | No. Disabled; no plist or crontab on the workstation |
| bridge-worker alerts | `~/.claude/scripts/bridge-worker.sh:96-110` | Pipeline errors to Telegram | Yes (launchd `com.breakout.bridge-worker`), but it is not uptime monitoring |
| groit units | `groit/deploy/vps/systemd/groit-booth@.service:22-23,39-40` `StartLimitBurst=5`, `Restart=always` | Self-restart; nothing watches the restart count | Repo; deploy-time only |
| groit deploy verify | `groit/deploy/vps/deploy-booth.sh:141-165` | `/livez` 200 and `/version` SHA match, with `--resolve` pinning | Per deploy, not continuous |
| whitelabel healthcheck | `trade-shows-whitelabel/scripts/healthcheck.sh` | One-shot `/healthz` plus security headers | Manual or per deploy; no `schedule:` in its workflows |
| hermes netdata | `breakout-hermes/monitoring/netdata/health.d/hermes-fleet.conf` | Container CPU and memory alarms | No outbound notify configured in hermes `origin/main` |
| breakout-infra monitoring | `breakout-infra/scripts/dns-monitor.sh:4` ("Run via cron"), `terraform/.../setup-monitoring.sh:114-125` (`send_alert` writes a log) | DNS drift, droplet metrics | Repo only; no crontab found |
| bridge resilience KB | `~/.claude/knowledge/kb-bridge-worker-resilience.md:68-72,208` | Proposes ntfy.sh | Proposal only; no ntfy call in any script |
| deploy-verify skill | `~/.claude/skills/deploy-verify/SKILL.md` | Reminds that the served SHA must match | Process nudge, no monitor |

Negatives, with scope:
- **Teams incoming webhook:** none in `~/projects` (scan for the Teams and Logic Apps webhook hostnames and `TEAMS_WEBHOOK`, excluding `.env*`, `node_modules`, `.git`), `~/.claude/scripts`, `~/.claude/knowledge` or `~/.agents/skills`. Teams is the operator's channel (global config, "Comms: Teams") but has no webhook yet.
- **ntfy, Pushover, healthchecks.io, UptimeRobot, Better Stack:** no endpoint URL in the same `~/projects` grep. UptimeRobot and Better Uptime appear only as "configure manually" echo text in breakout-infra's `setup-monitoring.sh`.
- **NRestarts, `OnFailure=`, `OnCalendar=` timers:** none in breakout-infra, groit or this repo.
- **breakout-apps is not on the tailnet;** it is reached by public IP (`kb-tailnet-server-access.md:58`), so an external check uses the public hostname.

Caveat: the `~/projects` webhook grep ran under a 120 s timeout and printed no match; if it timed out, the negative is weaker for repos outside the five named above.

Security note from the survey: `openclaw-health-check.sh`, `stack-health-probe.sh` and `bridge-worker.sh` carry a Telegram bot token in plaintext in the file. This design does not copy that pattern; the token should be rotated (operator step 7).

## Decision

Nothing runs today, so there is nothing to wire into. Port the patterns and build the smallest missing piece:

1. **Check logic reuses the repo's S1/S2 functions.** `.deploy/monitor.sh` sources `.deploy/backstage-lib.sh` and `.deploy/verify-lib.sh` and runs the relevant checks in the parent shell with gate `session`. The forged-cookie check uses a constant garbage cookie so no near-valid signature enters command arguments. It never calls `ship.sh --verify`, because that reads the gate state over SSH (`ship.sh:407`, `backstage_auth_state`) and a monitor must not hold an SSH key to the host.
2. **Expected version is the newest release tag,** read with `git ls-remote --tags` from the public repository: the newest annotated `vYYYY.MM.DD.N` tag's peeled SHA. The authenticated `/api/backstage/health` `version` must equal it.
3. **TLS expiry** ports `openclaw-health-check.sh:187`: `openssl s_client` into `openssl x509 -checkend 1209600` (14 days).
4. **Alert state** ports the last-status file from `openclaw-health-check.sh:236-282` and adds what no estate script has: a consecutive-failure counter. Alert after 2 consecutive failing runs, once; recovery notice once.
5. **Delivery** is one HTTPS POST through a private curl config, the `BACKSTAGE_CURL_CONFIG` pattern (`docs/backstage-deploy.md:93`). Two payload shapes: `teams` (a Teams Workflows webhook, the operator's channel) and `telegram` (the only channel the survey found in use).
6. **Host side** is a separate script on breakout-apps run by a systemd timer: `jevnotjev-backstage` must be active, its `Restart=` must be `on-failure` or `always`, and `NRestarts` must not grow between runs. The repository unit already sets `Restart=on-failure` and `RestartSec=2` (`.deploy/backstage.service:20-21`); whether the installed unit matches is an operator check (no host contact in this PR).
7. **Schedule:** systemd timers, every 5 minutes. The external timer runs on any Linux box that is not breakout-apps; GitHub Actions is not used (scheduled runs bill credits, and the global rule keeps gates off Actions).

## Check matrix

Each check has a passing case and a negative control that must make the run fail.

| Id | Check | Negative control |
|---|---|---|
| M1 | `/`, `/label/`, `/little-shop/` return 200 | static root removed (404) or upstream error |
| M2 | anon `/backstage/sign-in` 200 with `action="/api/auth/password"` | Backstage service stopped (nginx 502) |
| M3 | anon `/api/backstage/health` 401, JSON `{"code":"unauthenticated"}`, no `WWW-Authenticate` | nginx adds a `WWW-Authenticate` header |
| M4 | monitor session minted; authenticated `/api/backstage/health` `version` equals the newest release tag SHA | newest tag points at a different commit; tag listing unreachable |
| M5 | certificate valid for at least 14 more days | a certificate expiring inside 14 days |
| M6 | the Backstage curl config is private and owned by the runner; the alert config has the same rule except a systemd credential may be root-owned and ACL-readable with no world bits | group-readable Backstage config, missing alert config |
| M7 | a constant garbage session cookie is rejected | garbage cookie accepted |
| H1 | `Restart=` is `on-failure` or `always` | `Restart=no` |
| H2 | `ActiveState=active` | `inactive` or `failed` |
| H3 | `NRestarts` did not grow since the previous run; a lower value is a reset and becomes the baseline | `NRestarts` grew |

## Alert state machine

One state file per monitor: consecutive failure count and whether an alert is open.

| State | Run passes | Run fails |
|---|---|---|
| OK (0, closed) | OK, no message | PENDING (1), no message |
| PENDING (1, closed) | OK, no message | send ALERT; on success ALERTING, on send failure stay closed with count 2 so the next failing run retries |
| ALERTING (open) | send RECOVERED; on success OK, on send failure stay open so the next passing run retries | ALERTING, no repeat |

A missing or unreadable state file is OK. The lock records its owner PID: a live owner makes the run exit quietly; a dead or missing owner lets the next run reclaim the lock. `--dry-run` prints the message instead of sending it and never writes the alert state or host restart baseline.

## Operator steps

Values in angle brackets are the operator's to choose; nothing here is created by the PR.

1. **Monitor account.** Choose an unpublished local part for the monitor email, then run `bun scripts/backstage-operator-password.ts <chosen email>` on the workstation; add the printed row to `operators.json` and install it as in `docs/backstage-deploy.md` step 3. Use this account for nothing else. Keep the email private because the email-level login lock can be triggered by anyone who knows it.
2. **Monitor curl config** on the monitor box, mode 0600, owned by the user the timer runs as, outside any repository: one line `user = "<chosen email>:<printed password>"`.
3. **Alert channel.** Teams: in the target channel, add a Workflows flow that posts an incoming webhook request to the channel (the template name is UNVERIFIED here; the PR was not tested against a live Teams webhook), and copy its URL. Alert curl config, mode 0600: `url = "<workflow URL>"`. Both services set `MONITOR_ALERT_KIND=teams`. Telegram instead: `url = "https://api.telegram.org/bot<token>/sendMessage"` and `data-urlencode = "chat_id=<chat id>"`; override `MONITOR_ALERT_KIND=telegram` in the relevant service unit.
4. **External timer** on a Linux box other than breakout-apps: install bun at `/usr/local/bin/bun`, plus git, curl and openssl. Create the dedicated `jevnotjev-monitor` user and clone the repository at `/opt/jevnotjev` for that user. Install `.deploy/monitor/jevnotjev-monitor.service` and `.timer`; copy `.deploy/monitor/monitor.env.example` to `/etc/jevnotjev-monitor/monitor.env` and set the two private config paths there. Run `systemd-analyze verify` on all four monitor units, then `systemctl enable --now jevnotjev-monitor.timer`. First check: `systemctl start jevnotjev-monitor.service; journalctl -u jevnotjev-monitor -n 30`.
5. **Host timer** on breakout-apps: install `.deploy/monitor-host.sh`, `.deploy/monitor-lib.sh` and `.deploy/monitor/jevnotjev-backstage-restarts.service` and `.timer` under `/opt/jevnotjev` as the unit file states, the alert config as `/etc/jevnotjev-monitor/alert.curl` (root, 0600), then `systemctl enable --now jevnotjev-backstage-restarts.timer`. First check that the credential is accepted: `systemctl start jevnotjev-backstage-restarts.service; journalctl -u jevnotjev-backstage-restarts -n 20`.
6. **Confirm the live restart policy:** `systemctl show jevnotjev-backstage -p Restart -p RestartUSec -p NRestarts` must print `Restart=on-failure`, `RestartUSec=2s`.
   A crash loop can hit systemd's start limit and leave the service inactive, which fails H2. One restart alone is not alerted: H3 alerts after growth in two consecutive five-minute windows.
7. **Rotate** the Telegram bot token that sits in plaintext in the three `~/.claude/scripts` files named in the survey, if Telegram is the chosen channel.
