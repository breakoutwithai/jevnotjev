#!/usr/bin/env bash
# [T1] Host monitor through a fake systemctl and fake alert endpoint. No network.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/jev-host-monitor.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"
pass=0; fail=0
ok() { echo "  ok   - $1"; pass=$((pass+1)); }
nope() { echo "  FAIL - $1"; fail=$((fail+1)); }
cat > "$TMP/bin/systemctl" <<'SH'
#!/usr/bin/env bash
[[ "$1" == show && "$2" == "${MONITOR_UNIT:-jevnotjev-backstage}" ]] || exit 99
[[ ${FAKE_SYSTEMCTL_BAD:-} != yes ]] || { echo 'garbled'; exit 0; }
printf 'ActiveState=%s\nRestart=%s\nNRestarts=%s\n' "${FAKE_ACTIVE:-active}" "${FAKE_RESTART:-on-failure}" "${FAKE_NRESTARTS:-0}"
SH
cat > "$TMP/bin/curl" <<'SH'
#!/usr/bin/env bash
cat >> "$FAKE_ALERT_LOG"
printf '\n' >> "$FAKE_ALERT_LOG"
printf '%s' "${FAKE_ALERT_CODE:-200}"
SH
chmod +x "$TMP/bin/systemctl" "$TMP/bin/curl"
export PATH="$TMP/bin:$PATH" MONITOR_ALERT_KIND=teams MONITOR_STATE_DIR="$TMP/state" FAKE_ALERT_LOG="$TMP/alerts"
export MONITOR_ALERT_CURL_CONFIG="$TMP/alert.curl"
printf 'url = "SENTINEL_HOST_ALERT"\n' > "$MONITOR_ALERT_CURL_CONFIG"; chmod 600 "$MONITOR_ALERT_CURL_CONFIG"
run() { rc=0; out="$(bash "$ROOT/.deploy/monitor-host.sh" "$@" 2>&1)" || rc=$?; }
fresh() { rm -rf "$MONITOR_STATE_DIR"; : > "$FAKE_ALERT_LOG"; }
echo '[T1] H1-H3 positive and negative controls'
fresh; run --dry-run
for id in H1 H2 H3; do [[ $rc -eq 0 && $out == *"PASS $id"* ]] && ok "$id positive" || nope "$id positive: $out"; done
export FAKE_RESTART=no; run --dry-run
[[ $rc -eq 1 && $out == *'FAIL H1'* ]] && ok 'H1 Restart=no fails' || nope "H1 negative: $out"
unset FAKE_RESTART
export FAKE_ACTIVE=inactive; run --dry-run
[[ $rc -eq 1 && $out == *'FAIL H2'* ]] && ok 'H2 inactive fails' || nope "H2 negative: $out"
FAKE_ACTIVE=failed; export FAKE_ACTIVE; run --dry-run
[[ $rc -eq 1 && $out == *'FAIL H2'* ]] && ok 'H2 failed fails' || nope "H2 failed: $out"
unset FAKE_ACTIVE
export FAKE_NRESTARTS=1; run --dry-run
[[ $rc -eq 1 && $out == *'FAIL H3 NRestarts grew'* ]] && ok 'H3 growth fails' || nope "H3 growth: $out"
FAKE_NRESTARTS=0; export FAKE_NRESTARTS; run --dry-run
[[ $rc -eq 0 && $out == *'PASS H3'* ]] && ok 'H3 lower count resets baseline' || nope "H3 reset: $out"
export FAKE_SYSTEMCTL_BAD=yes; run --dry-run
[[ $rc -eq 1 && $out == *'FAIL H1-H3 unparseable'* ]] && ok 'unparseable systemctl output fails' || nope "malformed output: $out"
unset FAKE_SYSTEMCTL_BAD
echo '[T2] alert after two growth runs, then recovery'
fresh; FAKE_NRESTARTS=0; export FAKE_NRESTARTS; run
[[ $rc -eq 0 && ! -s $FAKE_ALERT_LOG ]] && ok 'first run stores baseline without alert' || nope 'baseline'
FAKE_NRESTARTS=1; export FAKE_NRESTARTS; run
[[ $rc -eq 1 && ! -s $FAKE_ALERT_LOG ]] && ok 'first growth is pending' || nope "first growth: $out"
FAKE_NRESTARTS=2; export FAKE_NRESTARTS; run
[[ $rc -eq 1 && $(grep -c AdaptiveCard "$FAKE_ALERT_LOG") -eq 1 ]] && ok 'second growth sends one alert' || nope "second growth: $out"
run
[[ $rc -eq 0 && $(grep -c AdaptiveCard "$FAKE_ALERT_LOG") -eq 2 ]] && ok 'quiet run sends recovery' || nope "quiet recovery: $out"
run
[[ $rc -eq 0 && $(grep -c AdaptiveCard "$FAKE_ALERT_LOG") -eq 2 ]] && ok 'subsequent quiet run sends nothing' || nope 'quiet repeat'
echo "monitor-host tests: ${pass} passed, ${fail} failed"
echo "[T1] passed=${pass} failed=${fail}"
[[ $fail -eq 0 ]]
