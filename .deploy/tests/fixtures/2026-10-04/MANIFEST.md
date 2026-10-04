# Deploy test fixtures, 2026-10-04

Read by `.deploy/tests/fixture-curl.sh` (the curl double in the deploy tests). File format and lookup
rules are in that script's header. No file here was captured from the host yet.

- host: breakout-apps, 178.62.69.200 (`jevnotjev.breakoutwithai.com` and its co-tenants)
- capture command (operator-run, read-only):
  `BACKSTAGE_CURL_CONFIG=<private curl config> .deploy/tests/capture-fixtures.sh --scan <private public-scan.sh>`
  writes `.deploy/tests/fixtures/<UTC date>/live/` with its own MANIFEST.md. Until it runs, the files
  below stand in for it, each marked on line 1:
  - `source: transcribed-from-live-log 2026-10-04`: what the host did on 2026-10-04 as recorded in
    issues #85 and #86 (status and curl exit only); bodies were not recorded and are left empty or
    shaped like the gated fixture
  - `source: hand-built from spec`: the answer docs/DEPLOY.md "Seams under test" requires; replace
    with the captured file

| Scenario | File | Source | What it records |
|---|---|---|---|
| cotenants | `http/showngrow.groit.global_.txt` | transcribed | TLS name mismatch: no status, curl exit 60 (aborted setup before #81) |
| cotenants | `http/nfflakelife.breakoutwithai.com_.txt` | transcribed | status 200, then timeout, curl exit 28 (rolled setup back before #81) |
| health-start | `http/jevnotjev.breakoutwithai.com_api_backstage_health@auth.1.txt` | transcribed | 502 while the Backstage service starts |
| health-start | `http/jevnotjev.breakoutwithai.com_api_backstage_health@auth.2.txt` | transcribed | 200 once it is up |
| no-auth | `http/jevnotjev.breakoutwithai.com_backstage_.txt`, `..._api_backstage_health.txt` | transcribed | Backstage page and API served without auth (before #83) |
| gated | `http/jevnotjev.breakoutwithai.com_*.txt` | hand-built | S1/S2 answers: `/`, `/label/`, `/little-shop/` 200; `/backstage/` and `/api/backstage/health` 401 anonymous, 200 with the curl config; `/DEPLOYED_SHA` and health `version` carry the served SHA token |

Bodies carrying `{{STATIC_SHA}}` / `{{BACKSTAGE_SHA}}` are filled by the double from the test's served
state, so one file serves every SHA a test sets up.
