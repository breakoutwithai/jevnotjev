#!/usr/bin/env bash
# [T1] Hermetic external monitor. HTTP fixtures are hand-built from docs/design/monitoring.md.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/jev-monitor-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/state" "$TMP/archive"
pass=0; fail=0
ok() { echo "  ok   - $1"; pass=$((pass+1)); }
nope() { echo "  FAIL - $1"; fail=$((fail+1)); }
check() { if [[ $1 == yes ]]; then ok "$2"; else nope "$2: rc=$rc; $out"; fi; }
REAL_OPENSSL="$(command -v openssl)"; export REAL_OPENSSL
cat > "$TMP/bin/openssl" <<'SH'
#!/usr/bin/env bash
if [[ ${1:-} == s_client ]]; then
  [[ ${FAKE_HANG_OPENSSL:-} != yes ]] || exec sleep 60
  [[ -z ${FAKE_LOCK_PATH:-} ]] || { test -d "$FAKE_LOCK_PATH" && echo held >> "$FAKE_STATE/lock.log" || echo lost >> "$FAKE_STATE/lock.log"; }
  cat "$FAKE_CERT"
  [[ ${FAKE_TRAILING_CERT:-} != yes ]] || head -c 200000 /dev/zero | tr '\0' X
  exit "${FAKE_OPENSSL_EXIT:-0}"
else exec "$REAL_OPENSSL" "$@"; fi
SH
cat > "$TMP/bin/git" <<'SH'
#!/usr/bin/env bash
if [[ ${FAKE_HANG_GIT:-} == yes && " $* " == *' ls-remote '* ]]; then exec sleep 60; fi
exec "$REAL_GIT" "$@"
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
[[ ${FAKE_FORGED_ACCEPT:-} != yes || " $* " != *'Cookie: __Host-backstage_session=x.y'* ]] || who=auth
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
chmod +x "$TMP/bin/openssl" "$TMP/bin/curl" "$TMP/bin/git"
REAL_GIT="$(command -v git)"; export REAL_GIT
export FAKE_STATE="$TMP/state" PATH="$TMP/bin:$PATH" VERIFY_SLEEP=0 VERIFY_ATTEMPTS=1 MONITOR_CMD_TIMEOUT=1
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
archive_index=0
fresh() {
  archive_index=$((archive_index+1))
  [[ ! -d "$MONITOR_STATE_DIR" ]] || cp -R "$MONITOR_STATE_DIR" "$TMP/archive/state-${archive_index}"
  [[ ! -f "$FAKE_STATE/alerts.log" ]] || cp "$FAKE_STATE/alerts.log" "$TMP/archive/alerts-${archive_index}"
  rm -rf "$MONITOR_STATE_DIR"; : > "$FAKE_STATE/alerts.log"
}

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
if [[ $rc -eq 1 && $out == *'FAIL M6'* ]]; then ok 'M6 group-readable config fails run'; else nope "M6 mode: $out"; fi
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
if [[ $rc -eq 1 && $out == *'FAIL M6'* && $out == *'PASS M5'* ]]; then ok 'M6 missing config fails run while public checks continue'; else nope "M6 missing: $out"; fi
mv "$TMP/backstage.real" "$BACKSTAGE_CURL_CONFIG"
fresh; chmod 640 "$BACKSTAGE_CURL_CONFIG"; run; run
[[ $rc -eq 1 && $(grep -c AdaptiveCard "$FAKE_STATE/alerts.log") -eq 1 ]] && ok 'M6 bad Backstage config alerts on second run' || nope "M6 alert: $out"
chmod 600 "$BACKSTAGE_CURL_CONFIG"

echo '[T2] alert state machine'
fresh; run; [[ $rc -eq 0 && ! -s $FAKE_STATE/alerts.log ]] && ok 'OK pass stays quiet' || nope 'OK pass'
export FAKE_BREAK=M1; run; [[ $rc -eq 1 && ! -s $FAKE_STATE/alerts.log ]] && ok 'OK fail becomes PENDING' || nope 'OK fail'
unset FAKE_BREAK; run; [[ $rc -eq 0 && ! -s $FAKE_STATE/alerts.log ]] && ok 'PENDING pass is silent blip' || nope 'PENDING pass'
export FAKE_BREAK=M1; run
export FAKE_ALERT_CODE=500; run
[[ $rc -eq 1 && $(cat "$MONITOR_STATE_DIR/external/alert.state") == '2 no' ]] && ok 'alert HTTP failure stays closed at count two' || nope "alert HTTP failure: $out"
unset FAKE_ALERT_CODE; run
[[ $rc -eq 1 && $(grep -c AdaptiveCard "$FAKE_STATE/alerts.log") -eq 2 ]] && ok 'next failure retries alert' || nope "alert retry: $out"
[[ $(grep -c 'FAIL M1' "$FAKE_STATE/alerts.log") -eq 2 ]] && ok 'ALERT includes failing check id' || nope 'ALERT lacks check id'
run; [[ $rc -eq 1 && $(grep -c AdaptiveCard "$FAKE_STATE/alerts.log") -eq 2 ]] && ok 'ALERTING fail sends no repeat' || nope 'ALERTING fail'
unset FAKE_BREAK; export FAKE_ALERT_EXIT=7; run
[[ $rc -eq 1 && $(cat "$MONITOR_STATE_DIR/external/alert.state") == '2 yes' ]] && ok 'recovery curl failure stays open' || nope "recovery failure: $out"
unset FAKE_ALERT_EXIT; run
[[ $rc -eq 0 && $(cat "$MONITOR_STATE_DIR/external/alert.state") == '0 no' && $(grep -c 'checks recovered' "$FAKE_STATE/alerts.log") -eq 2 ]] && ok 'next pass retries exactly one recovery' || nope "recovery retry: $out"
run; [[ $rc -eq 0 && $(cat "$MONITOR_STATE_DIR/external/alert.state") == '0 no' ]] && ok 'recovered OK sends no repeat' || nope 'recovered OK'
[[ $(grep -c 'checks recovered' "$FAKE_STATE/alerts.log") -eq 2 ]] && ok 'healthy repeat adds no RECOVERED payload' || nope 'repeat recovery payload'
[[ $(grep -c 'checks failed' "$FAKE_STATE/alerts.log") -eq 2 ]] && ok 'exactly one successful ALERT payload' || nope 'ALERT payload count'
echo '[T3] secrets after real deliveries'
grep -q SENTINEL_BACKSTAGE "$BACKSTAGE_CURL_CONFIG" && grep -q SENTINEL_ALERT "$MONITOR_ALERT_CURL_CONFIG" && ok 'leak scan positive control finds config sentinels' || nope 'leak scan positive control'
if ! grep -rE 'SENTINEL_BACKSTAGE|SENTINEL_ALERT' "$FAKE_STATE/argv.log" "$FAKE_STATE/output.log" "$FAKE_STATE/alerts.log" "$MONITOR_STATE_DIR" "$TMP/archive" >/dev/null; then ok 'secrets absent after real deliveries and prior state'; else nope 'secret leaked after delivery'; fi
fresh; export MONITOR_ALERT_KIND=telegram
printf 'url = "SENTINEL_ALERT"\ndata-urlencode = "chat_id=SENTINEL_CHAT"\n' > "$MONITOR_ALERT_CURL_CONFIG"; chmod 600 "$MONITOR_ALERT_CURL_CONFIG"
export FAKE_BREAK=M1; run; run
[[ $rc -eq 1 && $(grep -c 'FAIL M1' "$FAKE_STATE/alerts.log") -eq 1 && $(grep -c '^text@-$' "$FAKE_STATE/argv.log") -ge 1 ]] && ok 'Telegram text is URL encoded and sent after two failures' || nope "Telegram delivery: $out"
if ! grep -rE 'SENTINEL_ALERT|SENTINEL_CHAT' "$FAKE_STATE/argv.log" "$FAKE_STATE/output.log" "$FAKE_STATE/alerts.log" "$MONITOR_STATE_DIR" "$TMP/archive" >/dev/null; then ok 'Telegram chat id and URL stay in config'; else nope 'Telegram config leaked'; fi
export MONITOR_ALERT_KIND=teams
printf 'url = "SENTINEL_ALERT"\n' > "$MONITOR_ALERT_CURL_CONFIG"
fresh; export FAKE_BREAK=M1; run --dry-run; run --dry-run
[[ $rc -eq 1 && ! -s $FAKE_STATE/alerts.log ]] && ok 'dry-run sends nothing' || nope "dry-run: $out"
[[ ! -e "$MONITOR_STATE_DIR/external/alert.state" ]] && ok 'dry-run leaves state absent' || nope 'dry-run wrote state'
run; [[ ! -s $FAKE_STATE/alerts.log ]] && ok 'first real failure still pending after dry-runs' || nope 'dry-run changed real transition'
run --dry-run
[[ $out == *'ALERT (dry-run):'* ]] && ok 'dry-run prints pending alert' || nope 'dry-run missed pending alert'
cp "$MONITOR_STATE_DIR/external/alert.state" "$TMP/state-before"; run --dry-run
cmp -s "$TMP/state-before" "$MONITOR_STATE_DIR/external/alert.state" && ok 'dry-run leaves existing state byte-identical' || nope 'dry-run changed existing state'
run; [[ $(grep -c AdaptiveCard "$FAKE_STATE/alerts.log") -eq 1 ]] && ok 'real failure pair still alerts after dry-runs' || nope 'dry-run changed real transition'
mkdir -p "$MONITOR_STATE_DIR/external/lock"; sleep 30 & lock_owner=$!; echo "$lock_owner" > "$MONITOR_STATE_DIR/external/lock/pid"; run
[[ $rc -eq 0 && $out == *'previous run active'* && $(grep -c AdaptiveCard "$FAKE_STATE/alerts.log") -eq 1 ]] && ok 'held lock sends nothing' || nope "held lock: $out"
kill "$lock_owner"; wait "$lock_owner" 2>/dev/null || true
printf '99999999\n' > "$MONITOR_STATE_DIR/external/lock/pid"; run
[[ $rc -eq 1 && $out == *'FAIL M1'* ]] && ok 'dead owner lock is reclaimed' || nope "dead lock: $out"
mkdir -p "$MONITOR_STATE_DIR/external/lock"; run
[[ $rc -eq 1 && $out == *'FAIL M1'* ]] && ok 'missing owner PID lock is reclaimed' || nope "missing PID lock: $out"
export FAKE_LOCK_PATH="$MONITOR_STATE_DIR/external/lock"; : > "$FAKE_STATE/lock.log"; unset FAKE_BREAK; run --dry-run
[[ $rc -eq 0 && $(tail -1 "$FAKE_STATE/lock.log") == held ]] && ok 'lock remains held during TLS check' || nope "lock lost during TLS: $out"
unset FAKE_LOCK_PATH
export FAKE_OPENSSL_EXIT=1; run --dry-run
[[ $rc -eq 0 && $out == *'PASS M5'* ]] && ok 's_client exit 1 with valid cert passes' || nope "LibreSSL exit: $out"
unset FAKE_OPENSSL_EXIT
export FAKE_TRAILING_CERT=yes; run --dry-run
[[ $rc -eq 0 && $out == *'PASS M5'* ]] && ok 'large trailing s_client output passes' || nope "trailing cert: $out"
unset FAKE_TRAILING_CERT
export FAKE_HANG_OPENSSL=yes; start=$SECONDS; run --dry-run; elapsed=$((SECONDS-start))
[[ $rc -eq 1 && $out == *'FAIL M5'* && $elapsed -le 6 ]] && ok 'hanging TLS command fails within deadline' || nope "TLS deadline: elapsed=$elapsed $out"
unset FAKE_HANG_OPENSSL
export FAKE_HANG_GIT=yes; start=$SECONDS; run --dry-run; elapsed=$((SECONDS-start))
[[ $rc -eq 1 && $out == *'FAIL M4'* && $elapsed -le 6 ]] && ok 'hanging git command fails within deadline' || nope "git deadline: elapsed=$elapsed $out"
unset FAKE_HANG_GIT
export FAKE_FORGED_ACCEPT=yes; run --dry-run
[[ $rc -eq 1 && $out == *'FAIL M7 forged session rejected'* ]] && ok 'forged cookie accepted fails M7' || nope "M7 accepted cookie: $out"
unset FAKE_FORGED_ACCEPT
if ! grep -E '__Host-backstage_session=' "$FAKE_STATE/argv.log" | grep -v '__Host-backstage_session=x.y' >/dev/null; then ok 'only constant garbage cookie appears in argv'; else nope 'near-valid cookie in argv'; fi
MONITOR_URL=http://jevnotjev.test run --dry-run
[[ $rc -eq 2 ]] && ok 'HTTP monitor URL refused' || nope 'HTTP monitor URL accepted'
unset FAKE_BREAK

echo '[T4] credential and repository contract'
if ! git -C "$ROOT" ls-files -z | xargs -0 grep -nE 'webhook\.office\.com|logic\.azure\.com|api\.powerplatform\.com|api\.telegram\.org/bot[0-9]' >/dev/null 2>&1; then ok 'tracked files have no webhook or bot URL'; else nope 'webhook or bot URL in repo'; fi
grep -q '^Restart=on-failure$' "$ROOT/.deploy/backstage.service" && ok 'Backstage unit Restart=on-failure' || nope 'Backstage restart policy'
for timer in "$ROOT"/.deploy/monitor/*.timer; do grep -q '^OnCalendar=\*:0/5$' "$timer" && ok "$(basename "$timer") five-minute timer" || nope "$(basename "$timer") timer"; done
for service in "$ROOT"/.deploy/monitor/*.service; do
  if grep -q '^TimeoutStartSec=180$' "$service" && grep -q '^PrivateDevices=true$' "$service" && grep -q '^RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6$' "$service"; then ok "$(basename "$service") timeout and isolation"; else nope "$(basename "$service") timeout or isolation"; fi
done
echo "monitor tests: ${pass} passed, ${fail} failed"
echo "[T1] passed=${pass} failed=${fail}"
[[ $fail -eq 0 ]]
