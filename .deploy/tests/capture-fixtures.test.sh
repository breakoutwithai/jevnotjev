#!/usr/bin/env bash
#
# [T1] #86: capture-fixtures.sh is read-only on the host and writes ONLY allowlisted facts: parsed
# nginx facts (server_name, listen ports, user, snippet auth + sha256), co-tenant code and curl exit,
# route codes, the DEPLOYED_SHA value and four health fields. It never writes raw nginx -T, snippet
# text or response bodies, fails on input it cannot parse, scans the result, and stages privately
# until published. ssh, curl and the scanner are doubles describing the CAPTURE side (what a host
# might answer), not fixtures. Hermetic. Bash 3.2 compatible.
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
# A synthetic secret placed everywhere the host could leak one: a header value, a `set`, a comment,
# a value continued across lines, a single-quoted value, a health field and a page body.
export SECRET="SYNTHETIC_SECRET_4e1a"
cat > "${STUB}/ssh" <<'EOF'
#!/usr/bin/env bash
cmd="${@: -1}"
printf '%s\n---\n' "$cmd" >> "${FAKE_STATE}/ssh.log"
case "$cmd" in
    "echo ok") echo ok ;;
    "nginx -T 2>/dev/null")
        printf '%s\n' '# configuration file /etc/nginx/nginx.conf:' 'user www-data;' 'http {' \
            '    server {' '        listen 443 ssl;' '        listen [::]:443 ssl;' \
            '        server_name a.example.com www.a.example.com;' \
            "        proxy_set_header Authorization \"Basic ${SECRET}\";" \
            "        set \$api_key ${SECRET};" \
            "        # comment naming ${SECRET}" \
            "        proxy_set_header X-Multi \"first part" \
            "            ${SECRET} continued\";" \
            '    }' '    server {' '        listen 80;' '        server_name jevnotjev.breakoutwithai.com;' \
            "        add_header X-Note '${SECRET} single quoted';" \
            '        include /etc/nginx/snippets/jevnotjev-backstage.conf;' '    }' '}'
        if [ -n "${FAKE_NGINX_BAD:-}" ]; then printf '%s\n' "server { listen 443; # ${SECRET}"; fi ;;
    "cat /etc/nginx/snippets/jevnotjev-backstage.conf") cat "${FAKE_REPO}/.deploy/backstage-nginx.conf" ;;
    *"sites-enabled/*"*) printf '%s\n' 'server {' '    server_name a.example.com;' '}' 'server {' '    server_name jevnotjev.breakoutwithai.com;' '}' ;;
    *) echo "unexpected remote command" >&2; exit 1 ;;
esac
if [ -n "${FAKE_SLOW:-}" ] && [ "$cmd" = "nginx -T 2>/dev/null" ]; then : > "${FAKE_STATE}/slow"; sleep 3; fi
EOF
cat > "${STUB}/curl" <<'EOF'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "${FAKE_STATE}/curl.log"
out=""; heads=""; jar=""; prev=""; auth=false; session=false; mint=false; url=""
for a in "$@"; do
    [ "$prev" = -o ] && out="$a"
    [ "$prev" = -D ] && heads="$a"
    [ "$prev" = -c ] && jar="$a"
    [ "$a" = --config ] && auth=true
    [ "$a" = -b ] && session=true
    [ "$a" = POST ] && [ "$prev" = -X ] && mint=true
    case "$a" in https://*) url="$a" ;; esac
    prev="$a"
done
# Like curl: the body goes to -o FILE, nowhere for -o /dev/null, else to stdout before the -w text.
w() { if [ -z "$out" ]; then printf '%s\n' "$1"; elif [ "$out" != /dev/null ]; then printf '%s\n' "$1" > "$out"; fi; }
case "$url" in
    https://a.example.com/) printf 000; exit 60 ;;
    */api/backstage/health)
        if $auth || $session; then
            if [ -n "${FAKE_HEALTH_BAD:-}" ]; then w "<html>${SECRET}</html>"; else
            w "{\"protocol\":\"backstage/2\",\"version\":\"0123456789abcdef0123456789abcdef01234567\",\"catalogVersion\":\"2026-10-04.1\",\"catalog\":{\"note\":\"${SECRET}\"},\"trial\":{\"available\":true,\"limits\":{\"question\":200}},\"password\":\"${SECRET}\"}"; fi
            printf 200
        else w "unauthorized ${SECRET}"; printf 401; fi ;;
    */backstage/) if $auth || $session; then w "<html>${SECRET}</html>"; printf 200; else w unauthorized; printf 401; fi ;;
    */api/auth/password) if $mint; then printf 'HTTP/1.1 303 See Other\r\nSet-Cookie: __Host-backstage_session=fake; Path=/; Secure\r\n\r\n' > "$heads"; printf 'cookie' > "$jar"; printf 303; else printf 405; fi ;;
    */DEPLOYED_SHA) w 0123456789abcdef0123456789abcdef01234567; printf 200 ;;
    *) w "<html>page ${SECRET}</html>"; printf 200 ;;
esac
EOF
# The scanner double, in public-scan.sh's output format: flags lines containing SCAN_TERM
# (default PRIVATE-TERM, which the capture never contains), exit 1 on hits.
cat > "${STUB}/scan.sh" <<'EOF'
#!/usr/bin/env bash
tree="$1"; shift
hits="$(cd "$tree" && grep -n -e "${SCAN_TERM:-PRIVATE-TERM}" -- "$@" 2>/dev/null || true)"
[ -z "$hits" ] || printf '%s\n' "$hits"
if [ -z "$hits" ]; then echo "VERDICT public-scan OK files=$# hits=0"; exit 0; fi
echo "VERDICT public-scan HITS files=$# hits=$(printf '%s\n' "$hits" | grep -c .)"; exit 1
EOF
chmod +x "${STUB}/ssh" "${STUB}/curl" "${STUB}/scan.sh"
export TMPDIR="${STUB}/tmp"; mkdir -p "$TMPDIR"
staging_left() { find "$TMPDIR" -maxdepth 1 -name 'jevnotjev-capture.*' | head -1; }
: > "${STUB}/key"
CFG="${STUB}/curl-config"; printf 'user = "tester:s3cretpass"\n' > "$CFG"; chmod 600 "$CFG"
export JEVNOTJEV_SSH_KEY="${STUB}/key" JEVNOTJEV_SERVER_HOST=192.0.2.1 FAKE_REPO="$REPO_ROOT"
capture() { PATH="${STUB}:${PATH}" bash "$CAPTURE" "$@"; }
H=jevnotjev.breakoutwithai.com
json() { bun -e 'const [f,...p]=process.argv.slice(1);let v=JSON.parse(await Bun.file(f).text());for(const k of p)v=v?.[k];console.log(JSON.stringify(v))' "$@"; }

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
for f in nginx.json neighbours.txt http/a.example.com_.txt "http/${H}_backstage_.txt" "http/${H}_api_backstage_health@session.txt" \
         "http/${H}_little-shop_.txt" "http/${H}_DEPLOYED_SHA.txt"; do
    [[ -f "${OUT}/${f}" ]] && ok "wrote ${f}" || nope "missing ${f}"
done
for f in nginx-T.txt sites-enabled.txt backstage-snippet.conf; do
    [[ ! -e "${OUT}/${f}" ]] && ok "no raw ${f} is written" || nope "raw ${f} written"
done

echo "[T1] (a) a secret anywhere on the host never reaches the capture"
leaks="$(grep -rl -e "$SECRET" -e 's3cretpass' "$OUT" 2>/dev/null)"
[[ -z "$leaks" ]] && ok "the synthetic secret (header, set, comment, multiline, single-quoted, health field, page body) and the curl config are absent" \
    || nope "leaked into: ${leaks}"
[[ "$out" != *"$SECRET"* && "$out" != *s3cretpass* ]] && ok "the console output carries no secret" || nope "console leaked: ${out}"

echo "[T1] (b) every allowlisted fact is present and correct"
[[ "$(json "${OUT}/nginx.json" user)" == '"www-data"' ]] && ok "nginx user www-data" || nope "user: $(json "${OUT}/nginx.json" user)"
[[ "$(json "${OUT}/nginx.json" servers)" == '[{"serverNames":["a.example.com","www.a.example.com"],"listen":[443]},{"serverNames":["jevnotjev.breakoutwithai.com"],"listen":[80]}]' ]] \
    && ok "nginx servers: names and listen ports per server block" || nope "servers: $(json "${OUT}/nginx.json" servers)"
want_sha="$(shasum -a 256 "${REPO_ROOT}/.deploy/backstage-nginx.conf" | awk '{print $1}')"
[[ "$(json "${OUT}/nginx.json" snippet)" == "{\"auth\":\"session\",\"sha256\":\"${want_sha}\"}" ]] \
    && ok "snippet: auth session and the sha256 of the installed (repo) snippet" || nope "snippet: $(json "${OUT}/nginx.json" snippet)"
if rg -q 'extract_auth=no|if\(auth==="session"\)' "$CAPTURE"; then nope "capture rewrites session auth after extraction"; else ok "capture passes session auth directly to extraction"; fi
[[ "$(sed '1,/^---$/d' "${OUT}/http/${H}_api_backstage_health@session.txt")" == '{"version":"0123456789abcdef0123456789abcdef01234567","protocol":"backstage/2","catalogVersion":"2026-10-04.1","trial":{"available":true}}' ]] \
    && ok "health: only version, protocol, catalogVersion, trial.available" || nope "health: $(cat "${OUT}/http/${H}_api_backstage_health@session.txt")"
[[ "$(sed '1,/^---$/d' "${OUT}/http/${H}_DEPLOYED_SHA.txt")" == 0123456789abcdef0123456789abcdef01234567 ]] \
    && ok "DEPLOYED_SHA: the 40-hex value" || nope "DEPLOYED_SHA: $(cat "${OUT}/http/${H}_DEPLOYED_SHA.txt")"
[[ -z "$(sed '1,/^---$/d' "${OUT}/http/${H}_little-shop_.txt")" && -z "$(sed '1,/^---$/d' "${OUT}/http/${H}_backstage_.txt")" ]] \
    && ok "page routes keep their status only, no body" || nope "a page body was kept"
[[ "$(cat "${OUT}/neighbours.txt")" == a.example.com ]] && ok "neighbours: the co-tenant names only" || nope "neighbours: $(cat "${OUT}/neighbours.txt")"
grep 'a.example.com' "${FAKE_STATE}/curl.log" | grep -q -- '--config' \
    && nope "a co-tenant probe carried the private curl config" || ok "co-tenant probes never carry the private curl config"
grep '/api/auth/password' "${FAKE_STATE}/curl.log" | grep -q -- '--config' \
    && ok "session mint uses the private curl config" || nope "mint without --config"
grep '/api/backstage/health' "${FAKE_STATE}/curl.log" | grep -q -- '-b' \
    && ok "authenticated health read sends the minted jar" || nope "auth read without jar"
[[ -z "$(staging_left)" ]] && ok "no staging directory is left after a capture" || nope "staging left: $(staging_left)"

echo "[T1] fixture-curl.sh replays the capture"
REPLAY="$(mktemp -d)"; cp "${REPO_ROOT}/.deploy/tests/fixture-curl.sh" "${REPLAY}/curl"; chmod +x "${REPLAY}/curl"
code="$(FIXTURE_DIRS="$OUT" PATH="${REPLAY}:${PATH}" curl -q -sS -o /dev/null -w '%{http_code}' https://a.example.com/ 2>/dev/null)"; rrc=$?
[[ "$code" == 000 && $rrc -eq 60 ]] && ok "co-tenant replay: 000, curl exit 60 (as captured)" || nope "replay a.example.com: '${code}' rc=${rrc}"
code="$(FIXTURE_DIRS="$OUT" PATH="${REPLAY}:${PATH}" curl -q -sS -o /dev/null -w '%{http_code}' "https://${H}/backstage/" 2>/dev/null)"
[[ "$code" == 401 ]] && ok "anonymous /backstage/ replays 401" || nope "replay /backstage/: '${code}'"
code="$(FIXTURE_DIRS="$OUT" PATH="${REPLAY}:${PATH}" curl -q -sS -o /dev/null -w '%{http_code}' -b /nonexistent "https://${H}/api/backstage/health" 2>/dev/null)"
[[ "$code" == 401 ]] && ok "missing cookie jar remains anonymous" || nope "missing cookie jar selected session fixture"
printf 'foreign-cookie\n' > "${REPLAY}/foreign.jar"
code="$(FIXTURE_DIRS="$OUT" PATH="${REPLAY}:${PATH}" curl -q -sS -o /dev/null -w '%{http_code}' -b "${REPLAY}/foreign.jar" "https://${H}/api/backstage/health" 2>/dev/null)"
[[ "$code" == 401 ]] && ok "foreign cookie jar remains anonymous" || nope "foreign cookie jar selected session fixture"
printf '#HttpOnly_jevnotjev.breakoutwithai.com\tTRUE\t/\tTRUE\t0\t__Host-backstage_session\tfake-session\n' > "${REPLAY}/session.jar"
body="$(FIXTURE_DIRS="$OUT" PATH="${REPLAY}:${PATH}" curl -q -sS -b "${REPLAY}/session.jar" "https://${H}/api/backstage/health" 2>/dev/null)"
[[ "$body" == *'"version":"0123456789abcdef0123456789abcdef01234567"'* ]] && ok "authenticated health replays its version" || nope "replay health: '${body}'"
rm -rf "$REPLAY"

echo "[T1] (c) input that does not parse fails the capture; nothing raw is emitted"
out="$(FAKE_NGINX_BAD=1 BACKSTAGE_CURL_CONFIG="$CFG" capture --scan "${STUB}/scan.sh" --out "${STUB}/o1" 2>&1)"; rc=$?
[[ $rc -ne 0 && ! -e "${STUB}/o1" && -z "$(staging_left)" && "$out" != *"$SECRET"* ]] \
    && ok "unbalanced nginx -T: capture fails, nothing kept, the error echoes no input" || nope "bad nginx: rc=${rc}; ${out}"
out="$(FAKE_HEALTH_BAD=1 BACKSTAGE_CURL_CONFIG="$CFG" capture --scan "${STUB}/scan.sh" --out "${STUB}/o2" 2>&1)"; rc=$?
[[ $rc -ne 0 && ! -e "${STUB}/o2" && "$out" != *"$SECRET"* ]] \
    && ok "a 200 health body that is not the health shape fails the capture" || nope "bad health: rc=${rc}; ${out}"

echo "[T1] refusals"
out="$(BACKSTAGE_CURL_CONFIG="$CFG" capture --out "${STUB}/o3" 2>&1)"; rc=$?
[[ $rc -eq 2 && ! -e "${STUB}/o3" ]] && ok "without --scan: exit 2, nothing written" || nope "no --scan: rc=${rc}"
out="$(BACKSTAGE_CURL_CONFIG= capture --scan "${STUB}/scan.sh" --out "${STUB}/o4" 2>&1)"; rc=$?
[[ $rc -ne 0 && ! -e "${STUB}/o4" && "$out" == *BACKSTAGE_CURL_CONFIG* ]] && ok "without BACKSTAGE_CURL_CONFIG: refused by name, nothing written" || nope "no config: rc=${rc}; ${out}"
: > "${FAKE_STATE}/ssh.log"
out="$(BACKSTAGE_CURL_CONFIG="$CFG" capture --scan "${STUB}/scan.sh" --out "$OUT" 2>&1)"; rc=$?
[[ $rc -ne 0 && ! -s "${FAKE_STATE}/ssh.log" && -f "${OUT}/nginx.json" ]] && ok "an existing capture is never overwritten" || nope "overwrite: rc=${rc}"
mkdir -p "${STUB}/o5"
out="$(BACKSTAGE_CURL_CONFIG="$CFG" capture --scan "${STUB}/scan.sh" --out "${STUB}/o5" 2>&1)"; rc=$?
[[ $rc -ne 0 && -d "${STUB}/o5" && -z "$(ls -A "${STUB}/o5")" ]] && ok "an existing destination, even empty, is refused and left alone" || nope "empty dest: rc=${rc}"

echo "[T1] the scanner must succeed, be clean and cover every file"
out="$(SCAN_TERM=a.example.com BACKSTAGE_CURL_CONFIG="$CFG" capture --scan "${STUB}/scan.sh" --out "${STUB}/o6" 2>&1)"; rc=$?
[[ $rc -ne 0 && ! -e "${STUB}/o6" && -z "$(staging_left)" && "$out" != *"a.example.com_"* ]] \
    && ok "a scan hit fails the capture: nothing published, the hit is not printed" || nope "scan hit: rc=${rc}; ${out}"
cat > "${STUB}/scan-crash.sh" <<'EOF'
#!/usr/bin/env bash
echo "VERDICT public-scan OK files=0 hits=0"; exit 2
EOF
out="$(BACKSTAGE_CURL_CONFIG="$CFG" capture --scan "${STUB}/scan-crash.sh" --out "${STUB}/o7" 2>&1)"; rc=$?
[[ $rc -ne 0 && ! -e "${STUB}/o7" ]] && ok "a scanner exiting 2 with an OK line is a failure" || nope "scanner rc 2: rc=${rc}; ${out}"
cat > "${STUB}/scan-short.sh" <<'EOF'
#!/usr/bin/env bash
echo "VERDICT public-scan OK files=1 hits=0"; exit 0
EOF
out="$(BACKSTAGE_CURL_CONFIG="$CFG" capture --scan "${STUB}/scan-short.sh" --out "${STUB}/o8" 2>&1)"; rc=$?
[[ $rc -ne 0 && ! -e "${STUB}/o8" ]] && ok "a verdict covering fewer files than captured is a failure" || nope "short verdict: rc=${rc}; ${out}"

echo "[T1] an interrupted capture leaves nothing behind"
rm -f "${FAKE_STATE}/slow"
FAKE_SLOW=1 BACKSTAGE_CURL_CONFIG="$CFG" PATH="${STUB}:${PATH}" bash "$CAPTURE" --scan "${STUB}/scan.sh" --out "${STUB}/o9" >/dev/null 2>&1 &
pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [[ -e "${FAKE_STATE}/slow" ]] && break; sleep 0.5; done
kill -TERM "$pid" 2>/dev/null; wait "$pid"; rc=$?
[[ $rc -ne 0 && ! -e "${STUB}/o9" && -z "$(staging_left)" ]] && ok "TERM mid-capture: exit ${rc}, no destination, no staging" \
    || nope "interrupted: rc=${rc}, dest $( [[ -e "${STUB}/o9" ]] && echo yes || echo no), staging '$(staging_left)'"

rm -rf "$STUB"
echo "[T1] passed=${pass} failed=${fail}"
[[ "$fail" -eq 0 ]]
