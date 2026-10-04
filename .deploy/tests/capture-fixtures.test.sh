#!/usr/bin/env bash
#
# [T1] #86: capture-fixtures.sh is read-only on the host, redacts credentials and public-scan terms
# at capture, writes a manifest naming the command and host, refuses without its preconditions, and
# writes files that fixture-curl.sh replays unchanged. ssh, curl and the scanner are doubles that
# describe the CAPTURE side (what a host might answer), not fixtures. Hermetic. Bash 3.2 compatible.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
REPO_ROOT="$(pwd)"
CAPTURE="${REPO_ROOT}/.deploy/tests/capture-fixtures.sh"

pass=0; fail=0
ok()   { echo "  ok   - $1"; pass=$((pass+1)); }
nope() { echo "  FAIL - $1"; fail=$((fail+1)); }

is_mutating() {
    local c="$1"
    c="$(printf '%s' "$c" | sed -E 's#[0-9]?>&[0-9]##g; s#[0-9]?>[[:space:]]*/dev/null##g')"
    printf '%s' "$c" | grep -Eq '>|(^|[^a-z-])(mv|cp|rm|rmdir|ln|mkdir|touch|chmod|chown|tee|useradd|groupadd|install|tar)([[:space:]]|$)|systemctl[[:space:]]+(enable|disable|reload|restart|start|stop|daemon-reload)|nginx[[:space:]]+-s'
}

[[ -f "$CAPTURE" ]] || { nope "missing ${CAPTURE}"; echo "[T1] passed=${pass} failed=${fail}"; exit 1; }

STUB="$(mktemp -d)"
export FAKE_STATE="${STUB}/state"; mkdir -p "$FAKE_STATE"
cat > "${STUB}/ssh" <<'EOF'
#!/usr/bin/env bash
cmd="${@: -1}"
printf '%s\n---\n' "$cmd" >> "${FAKE_STATE}/ssh.log"
case "$cmd" in
    "echo ok") echo ok ;;
    "nginx -T 2>&1")
        printf '%s\n' 'nginx: the configuration file /etc/nginx/nginx.conf syntax is ok' \
            'server { server_name a.example.com; proxy_set_header Authorization "Basic dGVzdDpzM2NyZXQ="; }' \
            'server { server_name jevnotjev.breakoutwithai.com; include /etc/nginx/snippets/jevnotjev-backstage.conf; }' \
            '    set $api_key live-secret-value;' \
            '    proxy_set_header X-Api-Key live-secret-value;' \
            '    proxy_set_header  X-Auth-Token   tok-value-123 ;' \
            '    auth_basic "Restricted"; proxy_set_header Authorization "Basic SYNTHETIC_CREDENTIAL";' \
            '    auth_basic_user_file /etc/x/htpasswd; # token=SYNTHETIC_TOKEN_COMMENT' \
            '    auth_basic "Kept-Realm";' \
            '    auth_basic off;  # gate disabled here' \
            '    auth_basic_user_file /etc/kept/htpasswd;' \
            '# PRIVATE-TERM appears in a comment' ;;
    "ls -la /etc/nginx/sites-enabled/")
        if [ -n "${FAKE_SLOW:-}" ]; then : > "${FAKE_STATE}/slow"; sleep 3; fi
        printf '%s\n' 'lrwxrwxrwx 1 root root 40 Oct  4 a.example.com -> ../sites-available/a.example.com' ;;
    "cat /etc/nginx/snippets/jevnotjev-backstage.conf") cat "${FAKE_REPO}/.deploy/backstage-nginx.conf" ;;
    *"sites-enabled/*"*) printf '%s\n' 'server {' '    server_name a.example.com;' '}' 'server {' '    server_name jevnotjev.breakoutwithai.com;' '}' ;;
    *) echo "unexpected remote command" >&2; exit 1 ;;
esac
EOF
cat > "${STUB}/curl" <<'EOF'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "${FAKE_STATE}/curl.log"
out=""; prev=""; auth=false; url=""
for a in "$@"; do
    [ "$prev" = -o ] && out="$a"
    [ "$a" = --config ] && auth=true
    case "$a" in https://*) url="$a" ;; esac
    prev="$a"
done
w() { [ -z "$out" ] || [ "$out" = /dev/null ] || printf '%s\n' "$1" > "$out"; }
case "$url" in
    https://a.example.com/) printf 000; exit 60 ;;
    */api/backstage/health) if $auth; then w '{"version":"abc","password":"hunter2hunter2"}'; printf 200; else w unauthorized; printf 401; fi ;;
    */backstage/) if $auth; then w '<html>backstage</html>'; printf 200; else w unauthorized; printf 401; fi ;;
    */DEPLOYED_SHA) w 0123456789abcdef0123456789abcdef01234567; printf 200 ;;
    *) w '<html>page</html>'; printf 200 ;;
esac
EOF
# The scanner double: flags any line containing PRIVATE-TERM, in public-scan.sh's output format.
cat > "${STUB}/scan.sh" <<'EOF'
#!/usr/bin/env bash
tree="$1"; shift
hits="$(cd "$tree" && grep -n -e "${SCAN_TERM:-PRIVATE-TERM}" -- "$@" 2>/dev/null || true)"
[ -z "$hits" ] || printf '%s\n' "$hits"
if [ -z "$hits" ]; then echo "VERDICT public-scan OK files=$# hits=0"; exit 0; fi
echo "VERDICT public-scan HITS files=$# hits=$(printf '%s\n' "$hits" | grep -c .)"; exit 1
EOF
# awk double: the real awk, except the credential redactor fails when FAKE_REDACT_FAIL is set.
REAL_AWK="$(command -v awk)"
cat > "${STUB}/awk" <<EOF
#!/usr/bin/env bash
case "\$*" in *redact-credentials*) [ -z "\${FAKE_REDACT_FAIL:-}" ] || exit 1 ;; esac
exec "${REAL_AWK}" "\$@"
EOF
chmod +x "${STUB}/ssh" "${STUB}/curl" "${STUB}/scan.sh" "${STUB}/awk"
export TMPDIR="${STUB}/tmp"; mkdir -p "$TMPDIR"
staging_left() { find "$TMPDIR" -maxdepth 1 -name 'jevnotjev-capture.*' | head -1; }
: > "${STUB}/key"
CFG="${STUB}/curl-config"; printf 'user = "tester:s3cretpass"\n' > "$CFG"; chmod 600 "$CFG"
export JEVNOTJEV_SSH_KEY="${STUB}/key" JEVNOTJEV_SERVER_HOST=192.0.2.1 FAKE_REPO="$REPO_ROOT"
capture() { PATH="${STUB}:${PATH}" bash "$CAPTURE" "$@"; }

echo "[T1] a capture against a host double"
OUT="${STUB}/out"
out="$(BACKSTAGE_CURL_CONFIG="$CFG" capture --scan "${STUB}/scan.sh" --out "$OUT" 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && ok "capture exits 0" || nope "capture rc=${rc}; out: ${out}"
mut=""; buf=""
while IFS= read -r line; do
    if [[ "$line" == "---" ]]; then is_mutating "$buf" && mut="${mut}${buf};"; buf=""; else buf="${buf}${buf:+ }${line}"; fi
done < "${FAKE_STATE}/ssh.log"
[[ -z "$mut" && -s "${FAKE_STATE}/ssh.log" ]] && ok "every remote command is read-only" || nope "mutating remote commands: ${mut}"
grep -q 'capture-fixtures.sh' "${OUT}/MANIFEST.md" 2>/dev/null && grep -q '192.0.2.1' "${OUT}/MANIFEST.md" \
    && ok "MANIFEST.md names the capture command and the host" || nope "manifest: $(cat "${OUT}/MANIFEST.md" 2>/dev/null)"
for f in nginx-T.txt sites-enabled.txt backstage-snippet.conf neighbours.txt \
         http/a.example.com_.txt http/jevnotjev.breakoutwithai.com_backstage_.txt \
         http/jevnotjev.breakoutwithai.com_api_backstage_health@auth.txt http/jevnotjev.breakoutwithai.com_little-shop_.txt; do
    [[ -f "${OUT}/${f}" ]] && ok "wrote ${f}" || nope "missing ${f}"
done
leaks="$(grep -rl -e 'dGVzdDpzM2NyZXQ=' -e 'hunter2hunter2' -e 's3cretpass' -e 'PRIVATE-TERM' "$OUT" 2>/dev/null)"
[[ -z "$leaks" ]] && ok "no credential, password or public-scan term survives the capture" || nope "leaked into: ${leaks}"
leaks="$(grep -rl -e 'live-secret-value' -e 'tok-value-123' "$OUT" 2>/dev/null)"
[[ -z "$leaks" ]] && ok "sweep #1: nginx 'set \$api_key ...;' and whitespace-separated credential headers are redacted" \
    || nope "sweep #1 nginx credential syntax leaked into: ${leaks}"
leaks="$(grep -rl -e 'SYNTHETIC_CREDENTIAL' -e 'SYNTHETIC_TOKEN_COMMENT' "$OUT" 2>/dev/null)"
[[ -z "$leaks" ]] && ok "gate P1: an auth_basic line carrying a second directive or a credential comment is redacted" \
    || nope "gate P1 auth_basic exemption leaked into: ${leaks}"
grep -qxF '    auth_basic "Kept-Realm";' "${OUT}/nginx-T.txt" \
    && grep -qxF '    auth_basic off;  # gate disabled here' "${OUT}/nginx-T.txt" \
    && grep -qxF '    auth_basic_user_file /etc/kept/htpasswd;' "${OUT}/nginx-T.txt" \
    && ok "a lone auth_basic / auth_basic_user_file directive (optional safe comment) is kept verbatim" \
    || nope "safe auth_basic lines were not kept: $(grep -n 'auth_basic\|REDACTED' "${OUT}/nginx-T.txt")"
grep -q 'auth_basic_user_file /etc/jevnotjev-backstage/htpasswd;' "${OUT}/backstage-snippet.conf" \
    && ok "the htpasswd path line survives (a path, not a credential), so the snippet still parses" \
    || nope "snippet over-redacted: $(cat "${OUT}/backstage-snippet.conf")"
[[ -z "$(staging_left)" ]] && ok "sweep #4: no staging directory is left after a capture" || nope "staging left: $(staging_left)"
grep -q '\[REDACTED: credential\]' "${OUT}/nginx-T.txt" && grep -q '\[REDACTED: public-scan term\]' "${OUT}/nginx-T.txt" \
    && ok "redacted lines are marked, so the fixture shows where content was removed" || nope "redaction markers missing"
[[ "$out" != *PRIVATE-TERM* && "$out" != *s3cretpass* ]] && ok "the console output carries no flagged text" || nope "console leaked: ${out}"
grep 'a.example.com' "${FAKE_STATE}/curl.log" | grep -q -- '--config' \
    && nope "a co-tenant probe carried the private curl config" || ok "co-tenant probes never carry the private curl config"
grep '/api/backstage/health' "${FAKE_STATE}/curl.log" | grep -q -- '--config' \
    && ok "the authenticated health read uses the private curl config (backstage_curl)" || nope "auth read without --config"

echo "[T1] fixture-curl.sh replays the capture unchanged"
REPLAY="$(mktemp -d)"; cp "${REPO_ROOT}/.deploy/tests/fixture-curl.sh" "${REPLAY}/curl"; chmod +x "${REPLAY}/curl"
code="$(FIXTURE_DIRS="$OUT" PATH="${REPLAY}:${PATH}" curl -q -sS -o /dev/null -w '%{http_code}' https://a.example.com/ 2>/dev/null)"; rrc=$?
[[ "$code" == 000 && $rrc -eq 60 ]] && ok "co-tenant replay: 000, curl exit 60 (as captured)" || nope "replay a.example.com: '${code}' rc=${rrc}"
code="$(FIXTURE_DIRS="$OUT" PATH="${REPLAY}:${PATH}" curl -q -sS -o /dev/null -w '%{http_code}' https://jevnotjev.breakoutwithai.com/backstage/ 2>/dev/null)"
[[ "$code" == 401 ]] && ok "anonymous /backstage/ replays 401" || nope "replay /backstage/: '${code}'"
rm -rf "$REPLAY"

echo "[T1] refusals"
out="$(BACKSTAGE_CURL_CONFIG="$CFG" capture --out "${STUB}/o2" 2>&1)"; rc=$?
[[ $rc -eq 2 && ! -e "${STUB}/o2" ]] && ok "without --scan: exit 2, nothing written" || nope "no --scan: rc=${rc}"
out="$(BACKSTAGE_CURL_CONFIG= capture --scan "${STUB}/scan.sh" --out "${STUB}/o3" 2>&1)"; rc=$?
[[ $rc -ne 0 && ! -e "${STUB}/o3" && "$out" == *BACKSTAGE_CURL_CONFIG* ]] && ok "without BACKSTAGE_CURL_CONFIG: refused by name, nothing written" || nope "no config: rc=${rc}; ${out}"
: > "${FAKE_STATE}/ssh.log"
out="$(BACKSTAGE_CURL_CONFIG="$CFG" capture --scan "${STUB}/scan.sh" --out "$OUT" 2>&1)"; rc=$?
[[ $rc -ne 0 && ! -s "${FAKE_STATE}/ssh.log" ]] && ok "an existing capture is never overwritten" || nope "overwrite: rc=${rc}"
out="$(SCAN_TERM=html BACKSTAGE_CURL_CONFIG="$CFG" capture --scan "${STUB}/scan.sh" --out "${STUB}/o4" 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && ok "lines the scanner flags are redacted until the scan is clean" || nope "redact-to-clean: rc=${rc}; ${out}"
cat > "${STUB}/scan-dirty.sh" <<'EOF'
#!/usr/bin/env bash
echo "VERDICT public-scan HITS files=$(($# - 1)) hits=1"
EOF
out="$(BACKSTAGE_CURL_CONFIG="$CFG" capture --scan "${STUB}/scan-dirty.sh" --out "${STUB}/o5" 2>&1)"; rc=$?
[[ $rc -ne 0 && ! -e "${STUB}/o5" ]] && ok "a scan that stays dirty removes the capture" || nope "dirty scan: rc=${rc}, exists $( [[ -e "${STUB}/o5" ]] && echo yes || echo no)"

echo "[T1] sweep #2: the scanner must succeed and cover every file"
cat > "${STUB}/scan-crash.sh" <<'EOF'
#!/usr/bin/env bash
echo "VERDICT public-scan OK files=0 hits=0"; exit 2
EOF
out="$(BACKSTAGE_CURL_CONFIG="$CFG" capture --scan "${STUB}/scan-crash.sh" --out "${STUB}/o6" 2>&1)"; rc=$?
[[ $rc -ne 0 && ! -e "${STUB}/o6" && -z "$(staging_left)" ]] && ok "a scanner exiting 2 with an OK line is a failure: nothing kept" || nope "scanner rc 2: rc=${rc}; ${out}"
cat > "${STUB}/scan-short.sh" <<'EOF'
#!/usr/bin/env bash
echo "VERDICT public-scan OK files=1 hits=0"; exit 0
EOF
out="$(BACKSTAGE_CURL_CONFIG="$CFG" capture --scan "${STUB}/scan-short.sh" --out "${STUB}/o7" 2>&1)"; rc=$?
[[ $rc -ne 0 && ! -e "${STUB}/o7" ]] && ok "a verdict covering fewer files than captured is a failure" || nope "short verdict: rc=${rc}; ${out}"

echo "[T1] sweep #5 / #6: exclusive destination, every step checked"
mkdir -p "${STUB}/o8"
out="$(BACKSTAGE_CURL_CONFIG="$CFG" capture --scan "${STUB}/scan.sh" --out "${STUB}/o8" 2>&1)"; rc=$?
[[ $rc -ne 0 && -z "$(ls -A "${STUB}/o8")" && -d "${STUB}/o8" ]] && ok "an existing destination, even empty, is refused and left alone" || nope "empty dest: rc=${rc}"
out="$(FAKE_REDACT_FAIL=1 BACKSTAGE_CURL_CONFIG="$CFG" capture --scan "${STUB}/scan.sh" --out "${STUB}/o9" 2>&1)"; rc=$?
[[ $rc -ne 0 && ! -e "${STUB}/o9" && -z "$(staging_left)" ]] && ok "a failing redactor aborts the capture: nothing kept" || nope "redactor fail: rc=${rc}; ${out}"

echo "[T1] sweep #4: an interrupted capture leaves nothing behind"
rm -f "${FAKE_STATE}/slow"
FAKE_SLOW=1 BACKSTAGE_CURL_CONFIG="$CFG" PATH="${STUB}:${PATH}" bash "$CAPTURE" --scan "${STUB}/scan.sh" --out "${STUB}/o10" >/dev/null 2>&1 &
pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [[ -e "${FAKE_STATE}/slow" ]] && break; sleep 0.5; done
kill -TERM "$pid" 2>/dev/null; wait "$pid"; rc=$?
[[ $rc -ne 0 && ! -e "${STUB}/o10" && -z "$(staging_left)" ]] && ok "TERM mid-capture: exit ${rc}, no destination, no staging" \
    || nope "interrupted: rc=${rc}, dest $( [[ -e "${STUB}/o10" ]] && echo yes || echo no), staging '$(staging_left)'"

rm -rf "$STUB"
echo "[T1] passed=${pass} failed=${fail}"
[[ "$fail" -eq 0 ]]
