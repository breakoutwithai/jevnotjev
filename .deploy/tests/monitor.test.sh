#!/usr/bin/env bash
# [T1] Hermetic external monitor. HTTP fixtures are hand-built from docs/design/monitoring.md.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/jev-monitor-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/state"
pass=0; fail=0
ok() { echo "  ok   - $1"; pass=$((pass+1)); }
nope() { echo "  FAIL - $1"; fail=$((fail+1)); }
check() { if [[ $1 == yes ]]; then ok "$2"; else nope "$2: rc=$rc; $out"; fi; }
REAL_OPENSSL="$(command -v openssl)"; export REAL_OPENSSL
cat > "$TMP/bin/openssl" <<'SH'
#!/usr/bin/env bash
if [[ ${1:-} == s_client ]]; then cat "$FAKE_CERT"; else exec "$REAL_OPENSSL" "$@"; fi
SH
cat > "$TMP/bin/curl" <<'SH'
#!/usr/bin/env bash
# source: hand-built from docs/design/monitoring.md; no network fallback.
printf '%s\n' "$@" >> "$FAKE_STATE/argv.log"
url='' bodyfile='' headers='' jar='' code=200 who=anon alert=no prev=''
for a in "$@"; do
  case "$prev" in
    -o) bodyfile="$a"; prev=''; continue;;
    -D) headers="$a"; prev=''; continue;;
    -c) jar="$a"; prev=''; continue;;
    -b) who=auth; prev=''; continue;;
    --config) who=config; prev=''; continue;;
    -X|-w|-H|--resolve|--max-time|payload) prev=''; continue;;
  esac
  case "$a" in
    -o|-D|-c|-b|--config|-X|-w|-H|--resolve|--max-time) prev="$a";;
    --data-binary|--data-urlencode) alert=yes; prev=payload;;
    https://*) url="$a";;
  esac
done
if [[ $alert == yes ]]; then
  cat >> "$FAKE_STATE/alerts.log"
  printf '\n' >> "$FAKE_STATE/alerts.log"
  printf '%s' "${FAKE_ALERT_CODE:-200}"
  exit "${FAKE_ALERT_EXIT:-0}"
fi
path="/${url#*://*/}"
case "$path" in
  /|/label/|/little-shop/) content=static; [[ ${FAKE_BREAK:-} != M1 ]] || code=404;;
  /backstage/sign-in) content='<form action="/api/auth/password">'; [[ ${FAKE_BREAK:-} != M2 ]] || code=502;;
  /api/auth/password) code=303; content=''; [[ -z $jar ]] || printf '#HttpOnly_jevnotjev.test\tTRUE\t/\tTRUE\t0\t__Host-backstage_session\tx.y\n' > "$jar";;
  /backstage/) if [[ $who == auth ]]; then code=200; content=backstage; else code=302; content=''; fi;;
  /api/backstage/health)
    if [[ $who == auth ]]; then code=200; content="{\"version\":\"${EXPECTED_SHA}\"}"; [[ ${FAKE_BREAK:-} != M4 ]] || content='{"version":"wrong"}'
    else code=401; content='{"code":"unauthenticated"}'; fi;;
  *) code=404; content='';;
esac
if [[ -n $headers ]]; then
  {
    printf 'HTTP/1.1 %s Fixture\r\n' "$code"
    case "$path" in
      /api/auth/password) printf 'Set-Cookie: __Host-backstage_session=x.y; Secure; HttpOnly\r\n';;
      /backstage/) [[ $code != 302 ]] || printf 'Location: %s/backstage/sign-in?next=/backstage/\r\n' "${url%/backstage/}";;
      /api/backstage/health) printf 'Content-Type: application/json\r\n'; [[ ${FAKE_BREAK:-} != M3 || $who == auth ]] || printf 'WWW-Authenticate: Basic realm="x"\r\n';;
    esac
    printf '\r\n'
  } > "$headers"
fi
[[ -z $bodyfile || $bodyfile == /dev/null ]] || printf '%s' "$content" > "$bodyfile"
printf '%s' "$code"
SH
chmod +x "$TMP/bin/openssl" "$TMP/bin/curl"
export FAKE_STATE="$TMP/state" PATH="$TMP/bin:$PATH" VERIFY_SLEEP=0 VERIFY_ATTEMPTS=1
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.test GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.test
git init -q --bare "$TMP/bare.git"
git init -q "$TMP/work"
git -C "$TMP/work" config commit.gpgsign false
git -C "$TMP/work" config tag.gpgsign false
printf a > "$TMP/work/readme"
git -C "$TMP/work" add readme
git -C "$TMP/work" commit -qm initial
EXPECTED_SHA="$(git -C "$TMP/work" rev-parse HEAD)"; export EXPECTED_SHA
git -C "$TMP/work" tag -a v2026.10.06.1 -m release
git -C "$TMP/work" push -q "$TMP/bare.git" refs/tags/v2026.10.06.1
export MONITOR_REPO="$TMP/bare.git" MONITOR_URL=https://jevnotjev.test MONITOR_STATE_DIR="$TMP/state/monitor"
export MONITOR_ALERT_KIND=teams BACKSTAGE_CURL_CONFIG="$TMP/backstage.curl" MONITOR_ALERT_CURL_CONFIG="$TMP/alert.curl"
printf 'user = "SENTINEL_BACKSTAGE"\n' > "$BACKSTAGE_CURL_CONFIG"
printf 'url = "SENTINEL_ALERT"\n' > "$MONITOR_ALERT_CURL_CONFIG"
chmod 600 "$BACKSTAGE_CURL_CONFIG" "$MONITOR_ALERT_CURL_CONFIG"
"$REAL_OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 30 -subj /CN=jevnotjev.test -keyout "$TMP/key" -out "$TMP/cert30" >/dev/null 2>&1
"$REAL_OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 7 -subj /CN=jevnotjev.test -keyout "$TMP/key7" -out "$TMP/cert7" >/dev/null 2>&1
export FAKE_CERT="$TMP/cert30"
run() { rc=0; out="$(bash "$ROOT/.deploy/monitor.sh" "$@" 2>&1)" || rc=$?; printf '%s\n' "$out" >> "$FAKE_STATE/output.log"; }
fresh() { rm -rf "$MONITOR_STATE_DIR"; : > "$FAKE_STATE/alerts.log"; }

echo '[T1] check matrix'
fresh; run --dry-run
for id in M1 M2 M3 M4 M5 M6; do if [[ $rc -eq 0 && $out == *"PASS $id"* ]]; then ok "$id healthy fixture"; else nope "$id healthy fixture: rc=$rc; $out"; fi; done
for id in M1 M2 M3 M4; do
  fresh; export FAKE_BREAK="$id"; run --dry-run
  if [[ $rc -eq 1 && $out == *"FAIL $id"* ]]; then ok "$id negative control fails by name"; else nope "$id negative control: rc=$rc; $out"; fi
done
unset FAKE_BREAK
fresh; export FAKE_CERT="$TMP/cert7"; run --dry-run
if [[ $rc -eq 1 && $out == *'FAIL M5'* && $out == *'notAfter='* ]]; then ok 'M5 seven-day cert fails with expiry'; else nope "M5 expiry: $out"; fi
export FAKE_CERT="$TMP/cert30"
fresh; MONITOR_REPO="$TMP/missing" run --dry-run
if [[ $rc -eq 1 && $out == *'FAIL M4'* ]]; then ok 'M4 tag listing failure fails'; else nope "M4 tag listing: $out"; fi
printf b >> "$TMP/work/readme"
git -C "$TMP/work" commit -qam next
git -C "$TMP/work" tag -a v2026.10.06.2 -m older HEAD^
git -C "$TMP/work" tag -a v2026.10.06.10 -m newer HEAD
git -C "$TMP/work" push -q "$TMP/bare.git" refs/tags/v2026.10.06.2 refs/tags/v2026.10.06.10
fresh; run --dry-run
if [[ $rc -eq 1 && $out == *'FAIL M4'* ]]; then ok 'M4 picks numeric newest annotated tag'; else nope "M4 numeric tag order: $out"; fi
git --git-dir="$TMP/bare.git" tag -d v2026.10.06.2 v2026.10.06.10 >/dev/null
git -C "$TMP/work" tag v2026.10.06.999 HEAD
git -C "$TMP/work" push -q "$TMP/bare.git" refs/tags/v2026.10.06.999
fresh; run --dry-run
if [[ $rc -eq 0 && $out == *'PASS M4'* ]]; then ok 'M4 ignores lightweight release tag'; else nope "M4 lightweight tag: $out"; fi
git --git-dir="$TMP/bare.git" tag -d v2026.10.06.999 >/dev/null
fresh; MONITOR_RESOLVE='jevnotjev.test:443:127.0.0.1 --insecure' run --dry-run
if [[ $rc -eq 2 && $out == *'MONITOR_RESOLVE must contain one address'* ]]; then ok 'MONITOR_RESOLVE refuses extra curl arguments'; else nope "MONITOR_RESOLVE injection: $out"; fi
fresh; chmod 640 "$BACKSTAGE_CURL_CONFIG"; run --dry-run
if [[ $rc -eq 2 && $out == *'FAIL M6'* ]]; then ok 'M6 group-readable config refused'; else nope "M6 mode: $out"; fi
chmod 600 "$BACKSTAGE_CURL_CONFIG"
fresh; mv "$MONITOR_ALERT_CURL_CONFIG" "$TMP/alert.real"; ln -s "$TMP/alert.real" "$MONITOR_ALERT_CURL_CONFIG"; run --dry-run
if [[ $rc -eq 2 && $out == *'FAIL M6'* ]]; then ok 'M6 symlink config refused'; else nope "M6 symlink: $out"; fi
rm "$MONITOR_ALERT_CURL_CONFIG"; mv "$TMP/alert.real" "$MONITOR_ALERT_CURL_CONFIG"
fresh; chmod 640 "$MONITOR_ALERT_CURL_CONFIG"; run --dry-run
if [[ $rc -eq 2 && $out == *'FAIL M6'* ]]; then ok 'M6 group-readable alert config refused'; else nope "M6 alert mode: $out"; fi
chmod 600 "$MONITOR_ALERT_CURL_CONFIG"
fresh; mv "$MONITOR_ALERT_CURL_CONFIG" "$TMP/alert.real"; run
if [[ $rc -eq 2 && $out == *'FAIL M6'* ]]; then ok 'M6 missing alert config refused'; else nope "M6 missing alert: $out"; fi
mv "$TMP/alert.real" "$MONITOR_ALERT_CURL_CONFIG"
fresh; mv "$BACKSTAGE_CURL_CONFIG" "$TMP/backstage.real"; run --dry-run
if [[ $rc -eq 2 && $out == *'FAIL M6'* ]]; then ok 'M6 missing config refused'; else nope "M6 missing: $out"; fi
mv "$TMP/backstage.real" "$BACKSTAGE_CURL_CONFIG"

echo '[T2] alert state machine'
fresh; run; [[ $rc -eq 0 && ! -s $FAKE_STATE/alerts.log ]] && ok 'OK pass stays quiet' || nope 'OK pass'
export FAKE_BREAK=M1; run; [[ $rc -eq 1 && ! -s $FAKE_STATE/alerts.log ]] && ok 'OK fail becomes PENDING' || nope 'OK fail'
unset FAKE_BREAK; run; [[ $rc -eq 0 && ! -s $FAKE_STATE/alerts.log ]] && ok 'PENDING pass is silent blip' || nope 'PENDING pass'
export FAKE_BREAK=M1; run
export FAKE_ALERT_CODE=500; run
[[ $rc -eq 1 && $(cat "$MONITOR_STATE_DIR/external/alert.state") == '2 no' ]] && ok 'alert HTTP failure stays closed at count two' || nope "alert HTTP failure: $out"
unset FAKE_ALERT_CODE; run
[[ $rc -eq 1 && $(grep -c AdaptiveCard "$FAKE_STATE/alerts.log") -eq 2 ]] && ok 'next failure retries alert' || nope "alert retry: $out"
run; [[ $rc -eq 1 && $(grep -c AdaptiveCard "$FAKE_STATE/alerts.log") -eq 2 ]] && ok 'ALERTING fail sends no repeat' || nope 'ALERTING fail'
unset FAKE_BREAK; export FAKE_ALERT_EXIT=7; run
[[ $rc -eq 1 && $(cat "$MONITOR_STATE_DIR/external/alert.state") == '2 yes' ]] && ok 'recovery curl failure stays open' || nope "recovery failure: $out"
unset FAKE_ALERT_EXIT; run
[[ $rc -eq 0 && $(cat "$MONITOR_STATE_DIR/external/alert.state") == '0 no' ]] && ok 'next pass retries recovery' || nope "recovery retry: $out"
run; [[ $rc -eq 0 && $(cat "$MONITOR_STATE_DIR/external/alert.state") == '0 no' ]] && ok 'recovered OK sends no repeat' || nope 'recovered OK'
fresh; export FAKE_BREAK=M1; run --dry-run; run --dry-run
[[ $rc -eq 1 && $out == *'ALERT (dry-run):'* && ! -s $FAKE_STATE/alerts.log ]] && ok 'dry-run sends nothing' || nope "dry-run: $out"
mkdir -p "$MONITOR_STATE_DIR/external/lock"; run
[[ $rc -eq 0 && $out == *'previous run active'* && ! -s $FAKE_STATE/alerts.log ]] && ok 'held lock sends nothing' || nope "held lock: $out"
unset FAKE_BREAK

echo '[T3] credential and repository contract'
if ! rg -q 'SENTINEL_BACKSTAGE|SENTINEL_ALERT' "$FAKE_STATE/argv.log" "$FAKE_STATE/output.log" "$MONITOR_STATE_DIR"; then ok 'secret absent from argv, stdout/stderr, state'; else nope 'secret leaked'; fi
if ! git -C "$ROOT" ls-files -z | xargs -0 rg -n 'webhook\.office\.com|logic\.azure\.com|api\.telegram\.org/bot[0-9]' >/dev/null 2>&1; then ok 'tracked files have no webhook or bot URL'; else nope 'webhook or bot URL in repo'; fi
rg -q '^Restart=on-failure$' "$ROOT/.deploy/backstage.service" && ok 'Backstage unit Restart=on-failure' || nope 'Backstage restart policy'
for timer in "$ROOT"/.deploy/monitor/*.timer; do rg -q '^OnCalendar=\*:0/5$' "$timer" && ok "$(basename "$timer") five-minute timer" || nope "$(basename "$timer") timer"; done
echo "monitor tests: ${pass} passed, ${fail} failed"
echo "[T1] passed=${pass} failed=${fail}"
[[ $fail -eq 0 ]]
