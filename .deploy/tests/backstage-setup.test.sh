#!/usr/bin/env bash
#
# [T1] backstage-setup.sh: the one-time Backstage setup (docs/backstage-deploy.md steps 1-4)
# is idempotent, preserves the TLS vhost, validates before every reload, restores on failure,
# and never touches the funded-trial secret file.
#
# Sources the REAL setup script (it only runs main when executed) and replaces `remote` with a
# fake box: each command string the script builds is logged, its absolute host paths are
# rewritten into a fixture directory, and it runs locally with stub uname/id/useradd/ss/
# systemctl/nginx first on PATH. `curl` (neighbour probes) is a shell function. No ssh, no
# network, no host. Bash 3.2 compatible.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
REPO_ROOT="$(pwd)"
SETUP=".deploy/backstage-setup.sh"

pass=0; fail=0
ok()   { echo "  ok   - $1"; pass=$((pass+1)); }
nope() { echo "  FAIL - $1"; fail=$((fail+1)); }

export JEVNOTJEV_SERVER_HOST=192.0.2.1
KEYDIR="$(mktemp -d)"; : > "${KEYDIR}/key"
export JEVNOTJEV_SSH_KEY="${KEYDIR}/key"
# A private curl config, as the operator creates it. The password must never reach a remote
# command, a curl argument or any output.
TEST_PASSWORD="pw-NEVER-LOGGED-7f3a"
CURLCFG="${KEYDIR}/backstage-curl"
( umask 077; printf 'user = "tester:%s"\n' "$TEST_PASSWORD" > "$CURLCFG" )
export BACKSTAGE_CURL_CONFIG="$CURLCFG"

echo "[T1] backstage one-time setup"

if [[ ! -f "$SETUP" ]]; then
    nope "missing ${SETUP}"
    rm -rf "$KEYDIR"
    echo "[T1] passed=${pass} failed=${fail}"; exit 1
fi

# shellcheck source=/dev/null
source "$SETUP"

INCLUDE_LINE="include /etc/nginx/snippets/jevnotjev-backstage.conf;"

# The vhost as certbot leaves it: the HTTPS block (listen 443 added at its end) and a separate
# HTTP redirect block.
certbot_vhost() {
    cat <<'EOF'
server {
    server_name jevnotjev.breakoutwithai.com;
    root /var/www/jevnotjev;
    location / {
        try_files $uri $uri/ =404;
    }

    listen [::]:443 ssl ipv6only=on; # managed by Certbot
    listen 443 ssl; # managed by Certbot
    ssl_certificate /etc/letsencrypt/live/jevnotjev.breakoutwithai.com/fullchain.pem; # managed by Certbot
}
server {
    if ($host = jevnotjev.breakoutwithai.com) {
        return 301 https://$host$request_uri;
    } # managed by Certbot
    listen 80;
    listen [::]:80;
    server_name jevnotjev.breakoutwithai.com;
    return 404; # managed by Certbot
}
EOF
}

# ------------------------------------------------------------------ fake box
STUB=""
make_stubs() {
    STUB="$(mktemp -d)"
    cat > "${STUB}/uname" <<'EOF'
#!/usr/bin/env bash
echo x86_64
EOF
    cat > "${STUB}/id" <<'EOF'
#!/usr/bin/env bash
[ -f "${FAKE_BOX}/state/user" ]
EOF
    cat > "${STUB}/useradd" <<'EOF'
#!/usr/bin/env bash
touch "${FAKE_BOX}/state/user"
EOF
    cat > "${STUB}/ss" <<'EOF'
#!/usr/bin/env bash
[ -f "${FAKE_BOX}/state/ss_broken" ] && exit 127
[ -f "${FAKE_BOX}/state/port_used" ] && echo 'LISTEN 0 511 127.0.0.1:3456 0.0.0.0:*'
exit 0
EOF
    cat > "${STUB}/sha256sum" <<'EOF'
#!/usr/bin/env bash
shasum -a 256 "$@"
EOF
    cat > "${STUB}/systemctl" <<'EOF'
#!/usr/bin/env bash
s="${FAKE_BOX}/state"
case "$1" in
    # Real systemctl prints the state; enabled-runtime also exits 0 but is not persistent.
    is-enabled) if [ -f "$s/enabled_runtime" ]; then echo enabled-runtime
                elif [ -f "$s/enabled" ]; then echo enabled; else echo disabled; exit 1; fi ;;
    is-active)  [ -f "$s/active" ] ;;
    enable)     rm -f "$s/enabled_runtime"; touch "$s/enabled" ;;
    daemon-reload) touch "$s/daemon-reloaded" ;;
    reload)     [ "$2" = nginx ] && echo reload >> "$s/reloads" ;;
    *) exit 1 ;;
esac
EOF
    # stat: metadata the box records next to the path (owner, group, mode, size), since the
    # fixture files are owned by the test user, not root.
    cat > "${STUB}/stat" <<'EOF'
#!/usr/bin/env bash
for p in "$@"; do last="$p"; done
[ -f "${last}.statmeta" ] && [ -e "$last" ] && { cat "${last}.statmeta"; exit 0; }
exit 1
EOF
    cat > "${STUB}/nginx" <<'EOF'
#!/usr/bin/env bash
v="${FAKE_BOX}/etc/nginx/sites-available/jevnotjev.breakoutwithai.com"
if [ "$1" = -t ]; then
    if [ -f "${FAKE_BOX}/state/nginx_t_fail" ] && grep -q 'jevnotjev-backstage.conf' "$v"; then
        echo 'nginx: [emerg] test failure' >&2; exit 1
    fi
    echo 'nginx: configuration file test is successful' >&2; exit 0
fi
exit 1
EOF
    chmod +x "${STUB}"/*
}

# configured=yes builds a host where setup already ran.
make_box() {
    local configured="$1"
    BOX="$(mktemp -d)"
    RLOG="${BOX}/remote.log"; : > "$RLOG"
    mkdir -p "${BOX}/etc/nginx/sites-available" "${BOX}/etc/nginx/sites-enabled" "${BOX}/etc/nginx/snippets" \
             "${BOX}/etc/systemd/system" "${BOX}/usr/local/bin" "${BOX}/usr/bin" "${BOX}/var/lock" "${BOX}/var/backups" "${BOX}/state" \
             "${BOX}/etc/jevnotjev-backstage"
    printf '#!/usr/bin/env bash\necho 1.3.0\n' > "${BOX}/usr/local/bin/bun"; chmod +x "${BOX}/usr/local/bin/bun"
    printf 'user www-data;\nworker_processes auto;\n' > "${BOX}/etc/nginx/nginx.conf"
    # apache2-utils present; the operator-created htpasswd is in place with the required metadata.
    printf '#!/usr/bin/env bash\nexit 0\n' > "${BOX}/usr/bin/htpasswd"; chmod +x "${BOX}/usr/bin/htpasswd"
    HT="${BOX}/etc/jevnotjev-backstage/htpasswd"
    printf 'tester:$2y$05$hashhashhashhashhashhu\n' > "$HT"
    printf 'root www-data 640 44\n' > "${HT}.statmeta"
    printf 'root www-data 750 4096\n' > "${BOX}/etc/jevnotjev-backstage.statmeta"
    VH="${BOX}/etc/nginx/sites-available/jevnotjev.breakoutwithai.com"
    certbot_vhost > "$VH"
    ln -s "$VH" "${BOX}/etc/nginx/sites-enabled/jevnotjev.breakoutwithai.com"
    printf 'server {\n    listen 443 ssl;\n    server_name a.example.com;\n}\nserver { server_name b.example.org; }\n' \
        > "${BOX}/etc/nginx/sites-enabled/neighbours.conf"
    if [[ "$configured" == yes ]]; then
        touch "${BOX}/state/user" "${BOX}/state/enabled"
        cp "${REPO_ROOT}/.deploy/backstage.service" "${BOX}/etc/systemd/system/jevnotjev-backstage.service"
        cp "${REPO_ROOT}/.deploy/backstage-nginx.conf" "${BOX}/etc/nginx/snippets/jevnotjev-backstage.conf"
        insert_include "$INCLUDE_LINE" jevnotjev.breakoutwithai.com < "$VH" > "${VH}.x" && mv "${VH}.x" "$VH"
    fi
    ORIGINAL_VHOST="$(cat "$VH")"
}
drop_box() { [[ -n "${BOX:-}" && -d "$BOX" ]] && rm -rf "$BOX"; }

fake_remote() {
    local cmd="$*" real
    printf '%s\n---\n' "$cmd" >> "$RLOG"
    # Simulate the operator's session dying at the first `nginx -t` (after the vhost write).
    if [[ -n "${INTERRUPT_AT_NGINX_T:-}" && "$cmd" == "nginx -t" && ! -e "${BOX}/state/interrupted" ]]; then
        touch "${BOX}/state/interrupted"; exit 143
    fi
    # Rewrite host paths into the box, except the include line: that is vhost CONTENT, not a path.
    real="$(printf '%s' "$cmd" | sed -E "s#include /#include@KEEP@#g; s#(^|[[:space:]'\"=])/(etc|var|usr/local|usr/bin)/#\\1${BOX}/\\2/#g; s#include@KEEP@#include /#g")"
    PATH="${STUB}:${PATH}" FAKE_BOX="$BOX" bash -c "$real"
}
remote() { fake_remote "$@"; }

# Neighbour probe: 200 for everyone, unless BREAK_AFTER_RELOAD is set and nginx was reloaded.
# FAIL_NAME fails one co-tenant's probe like a TLS error (curl -w prints 000, exit 60) before and after
# the reload; FAIL_NAME_BEFORE / FAIL_NAME_AFTER fail it on one side of the reload only.
curl() {
    local arg host="" reloaded=false url="" authed=false
    printf 'curl %s\n' "$*" >> "${BOX}/curl.log"
    for arg in "$@"; do
        if [[ "$arg" == https://* ]]; then url="$arg"; host="${arg#https://}"; host="${host%/}"; fi
        [[ "$arg" == --config ]] && authed=true
    done
    [[ -s "${BOX}/state/reloads" ]] && reloaded=true
    # Backstage routes: nginx answers 401 before the proxy whenever the INSTALLED snippet carries
    # auth_basic; with the curl config the request passes auth and reaches the (absent) upstream: 502.
    # UNAUTH_CODE / AUTHED_CODE override what the host answers.
    if [[ "$url" == */backstage/* || "$url" == */api/backstage/* ]]; then
        if $authed; then printf '%s' "${AUTHED_CODE:-502}"; return 0; fi
        if [[ -n "${UNAUTH_CODE:-}" ]]; then printf '%s' "$UNAUTH_CODE"; return 0; fi
        if grep -q 'auth_basic_user_file' "${BOX}/etc/nginx/snippets/jevnotjev-backstage.conf" 2>/dev/null; then
            printf 401
        else
            printf 502
        fi
        return 0
    fi
    if [[ -n "$host" ]] && { [[ "$host" == "${FAIL_NAME:-}" ]] \
        || { [[ "$host" == "${FAIL_NAME_BEFORE:-}" ]] && ! $reloaded; } \
        || { [[ "$host" == "${FAIL_NAME_AFTER:-}" ]] && $reloaded; }; }; then
        # Exit code per side: FAIL_RC_BEFORE / FAIL_RC_AFTER (default 60, TLS name mismatch).
        # HTTP code curl printed before failing: FAIL_HTTP_BEFORE / FAIL_HTTP_AFTER (default 000 = none).
        if $reloaded; then printf '%s' "${FAIL_HTTP_AFTER:-000}"; return "${FAIL_RC_AFTER:-60}"
        else printf '%s' "${FAIL_HTTP_BEFORE:-000}"; return "${FAIL_RC_BEFORE:-60}"; fi
    fi
    # LOCAL failures, not observations: FAIL_LOCAL_RC makes curl exit with that code (127 = not found)
    # and say so on stderr; FAIL_MALFORMED makes it exit 0 with output that is no HTTP status.
    if [[ -n "${FAIL_LOCAL_RC:-}" ]]; then echo "curl: simulated local failure" >&2; return "$FAIL_LOCAL_RC"; fi
    if [[ -n "${FAIL_MALFORMED:-}" ]]; then printf 'garbage'; return 0; fi
    if [[ -n "${BREAK_AFTER_RELOAD:-}" ]] && $reloaded; then printf 502; else printf 200; fi
}

is_mutating() {
    local c="$1"
    c="$(printf '%s' "$c" | sed -E 's#[0-9]?>&[0-9]##g; s#[0-9]?>[[:space:]]*/dev/null##g')"
    printf '%s' "$c" | grep -Eq '>|(^|[^a-z-])(mv|cp|rm|rmdir|ln|mkdir|touch|chmod|chown|tee|useradd|groupadd|install|tar)([[:space:]]|$)|systemctl[[:space:]]+(enable|disable|reload|restart|start|stop|daemon-reload)|nginx[[:space:]]+-s'
}
# Print each logged remote command (one per line) that mutates.
mutating_commands() {
    local line buf=""
    while IFS= read -r line; do
        if [[ "$line" == "---" ]]; then
            is_mutating "$buf" && printf '%s\n' "$buf"
            buf=""
        else
            buf="${buf}${buf:+ }${line}"
        fi
    done < "$RLOG"
}
reloads() { if [[ -f "${BOX}/state/reloads" ]]; then wc -l < "${BOX}/state/reloads" | tr -d ' '; else echo 0; fi; }
box_fingerprint() { (cd "$BOX" && find etc var state -print | LC_ALL=C sort && find etc -type f -exec cat {} + ) | shasum -a 256; }
# Depth-aware check: the include sits at server level inside the block that listens on 443.
include_in_https_block() {
    awk -v inc="$INCLUDE_LINE" '
        { c=$0; sub(/#.*/, "", c) }
        depth == 0 && c ~ /^[[:space:]]*server[[:space:]]*\{/ { blk++ }
        depth == 1 && c ~ /listen[[:space:]]+([^;]*:)?443([^0-9]|$)/ { https[blk]=1 }
        depth == 1 && index(c, inc) { inc_blk[blk]=1; n++ }
        { o=gsub(/\{/, "{", c); x=gsub(/\}/, "}", c); depth += o - x }
        END { for (b in inc_blk) if (!(b in https)) exit 1; exit !(n == 1) }' "$1"
}

make_stubs
SHA40=0123456789abcdef0123456789abcdef01234567

echo
echo "[T1] insert_include (pure)"
got="$(certbot_vhost | insert_include "$INCLUDE_LINE" jevnotjev.breakoutwithai.com)"; rc=$?
tmpf="$(mktemp)"; printf '%s\n' "$got" > "$tmpf"
[[ $rc -eq 0 ]] && include_in_https_block "$tmpf" \
    && ok "the include lands once, at server level, inside the HTTPS (443) block" \
    || nope "insert_include rc=${rc}: ${got}"
[[ "$(printf '%s\n' "$got" | grep -v -F "$INCLUDE_LINE")" == "$(certbot_vhost)" ]] \
    && ok "every other line of the certbot vhost (certificates, redirect block) is unchanged" \
    || nope "insert_include changed other lines"
rm -f "$tmpf"
printf 'server {\n    listen 80;\n}\n' | insert_include "$INCLUDE_LINE" jevnotjev.breakoutwithai.com >/dev/null 2>&1 \
    && nope "a vhost with no HTTPS block was edited" || ok "no HTTPS server block -> refuse (non-zero)"
printf 'server {\n    listen 443 ssl;\n}\nserver {\n    listen 443 ssl;\n}\n' | insert_include "$INCLUDE_LINE" jevnotjev.breakoutwithai.com >/dev/null 2>&1 \
    && nope "a vhost with two HTTPS blocks was edited" || ok "two HTTPS server blocks -> refuse (ambiguous)"
printf 'server {\n    listen 443 ssl;\n    server_name other.example.com;\n}\nserver {\n    listen 80;\n    server_name jevnotjev.breakoutwithai.com;\n}\n' \
    | insert_include "$INCLUDE_LINE" jevnotjev.breakoutwithai.com >/dev/null 2>&1 \
    && nope "the include went into another domain's HTTPS block" || ok "an HTTPS block serving another domain -> refuse"
printf 'server\n{\n    listen 443 ssl;\n    server_name jevnotjev.breakoutwithai.com;\n}\nserver\n{\n    listen 443 ssl;\n    server_name jevnotjev.breakoutwithai.com;\n}\n' \
    | insert_include "$INCLUDE_LINE" jevnotjev.breakoutwithai.com >/dev/null 2>&1 \
    && nope "brace-on-next-line blocks were miscounted" || ok "server with the brace on the next line is still counted (two blocks -> refuse)"
printf 'server {\n    listen 443 ssl;\n    server_name jevnotjev.breakoutwithai.com;\n    return 200 "{";\n}\n' \
    | insert_include "$INCLUDE_LINE" jevnotjev.breakoutwithai.com >/dev/null 2>&1 \
    && nope "an unbalanced (quoted) brace was accepted" || ok "unbalanced brace count (quoted brace) -> refuse"

echo
echo "[T1] fully configured host: no changes"
make_box yes
before_fp="$(box_fingerprint)"
out="$( (setup_main) 2>&1)"; rc=$?
mut="$(mutating_commands)"
[[ $rc -eq 0 && -z "$mut" && "$(box_fingerprint)" == "$before_fp" && "$(reloads)" == 0 ]] \
    && ok "setup on a configured host makes no changes, no reload, exits 0" \
    || nope "configured host: rc=${rc}, reloads $(reloads), mutating: ${mut:-none}; out: ${out}"
drop_box

echo
echo "[T1] unconfigured host: installs steps 1-4"
make_box no
out="$( (setup_main) 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && ok "setup exits 0 on an unconfigured host" || nope "setup rc=${rc}: ${out}"
[[ -f "${BOX}/state/user" ]] && ok "step 1: jevnotjev-backstage service user created" || nope "user not created"
cmp -s "${BOX}/etc/systemd/system/jevnotjev-backstage.service" "${REPO_ROOT}/.deploy/backstage.service" \
    && [[ -f "${BOX}/state/daemon-reloaded" && -f "${BOX}/state/enabled" ]] \
    && ok "step 2: unit installed byte-identical, daemon-reload, enabled" \
    || nope "unit/enable wrong: $(ls "${BOX}/state")"
grep -Eq 'systemctl[[:space:]]+(start|restart)' "$RLOG" \
    && nope "setup started the service before a release exists" \
    || ok "step 2: the service is enabled but never started"
cmp -s "${BOX}/etc/nginx/snippets/jevnotjev-backstage.conf" "${REPO_ROOT}/.deploy/backstage-nginx.conf" \
    && ok "step 3: snippet installed byte-identical" || nope "snippet missing or different"
include_in_https_block "$VH" \
    && ok "step 3: include inserted exactly once, inside the HTTPS server block" \
    || nope "include not in the HTTPS block: $(cat "$VH")"
[[ "$(grep -v -F "$INCLUDE_LINE" "$VH")" == "$ORIGINAL_VHOST" ]] \
    && ok "step 3: every certificate directive and other line is preserved" || nope "vhost lines changed"
backup="$(find "${BOX}/var/backups/jevnotjev-backstage" -type f 2>/dev/null | head -1)"
[[ -n "$backup" && "$(cat "$backup")" == "$ORIGINAL_VHOST" ]] \
    && ok "a timestamped backup of the original vhost was saved ($(basename "${backup:-none}"))" \
    || nope "no backup holding the original vhost"
bk_line="$(grep -n 'var/backups/jevnotjev-backstage' "$RLOG" | grep -E '(^|[^a-z])cp ' | head -1 | cut -d: -f1)"
wr_line="$(grep -n "sites-available/jevnotjev.breakoutwithai.com.backstage-new" "$RLOG" | head -1 | cut -d: -f1)"
[[ -n "$bk_line" && -n "$wr_line" && "$bk_line" -lt "$wr_line" ]] \
    && ok "the backup (log line ${bk_line}) is taken before the vhost is written (line ${wr_line})" \
    || nope "backup '${bk_line:-none}' not before vhost write '${wr_line:-none}'"
t_line="$(grep -n '^nginx -t' "$RLOG" | tail -1 | cut -d: -f1)"
r_line="$(grep -n 'systemctl reload nginx' "$RLOG" | head -1 | cut -d: -f1)"
[[ "$(reloads)" == 1 && -n "$t_line" && -n "$r_line" && "$t_line" -lt "$r_line" ]] \
    && ok "step 4: nginx -t before exactly one reload" || nope "reloads=$(reloads), nginx -t line ${t_line:-none}, reload line ${r_line:-none}"
grep -Eq 'restart nginx|nginx -s' "$RLOG" && nope "nginx was restarted" || ok "step 4: nginx is reloaded, never restarted"

: > "$RLOG"
out="$( (setup_main) 2>&1)"; rc=$?
mut="$(mutating_commands)"
[[ $rc -eq 0 && -z "$mut" && "$(reloads)" == 1 ]] \
    && ok "re-running setup on the host it just configured changes nothing" \
    || nope "re-run: rc=${rc}, mutating: ${mut:-none}"
drop_box

echo
echo "[T1] nginx -t failure"
make_box no
touch "${BOX}/state/nginx_t_fail"
out="$( (setup_main) 2>&1)"; rc=$?
[[ $rc -ne 0 && "$(cat "$VH")" == "$ORIGINAL_VHOST" && "$(reloads)" == 0 && ! -e "${BOX}/etc/nginx/snippets/jevnotjev-backstage.conf" ]] \
    && ok "nginx -t failure restores the backup, removes the new snippet, never reloads, exits non-zero" \
    || nope "nginx -t fail: rc=${rc}, reloads $(reloads), vhost restored? $([[ "$(cat "$VH")" == "$ORIGINAL_VHOST" ]] && echo yes || echo no); out: ${out}"
grep -q 'systemctl reload nginx' "$RLOG" && nope "a reload was issued after nginx -t failed" || ok "no reload command was issued at all"
drop_box

echo
echo "[T1] co-tenant changed after reload"
make_box no
out="$(BREAK_AFTER_RELOAD=1; (setup_main) 2>&1)"; rc=$?
[[ $rc -ne 0 && "$(cat "$VH")" == "$ORIGINAL_VHOST" && "$(reloads)" == 2 ]] \
    && ok "a changed neighbour restores the vhost, validates and reloads again, exits non-zero" \
    || nope "neighbour change: rc=${rc}, reloads $(reloads); out: ${out}"
[[ "$out" == *"CHANGED: a.example.com 200 -> 502"* ]] && ok "the changed neighbour is named with its status change" || nope "changed neighbour not named"
drop_box

echo
echo "[T1] co-tenant failing TLS at baseline and after (static-deploy parity: recorded as 000)"
make_box no
out="$(FAIL_NAME=a.example.com; (setup_main) 2>&1)"; rc=$?
[[ $rc -eq 0 && "$(reloads)" == 1 ]] && include_in_https_block "$VH" \
    && ok "a co-tenant failing identically before and after the reload does not block setup" \
    || nope "000 baseline: rc=${rc}, reloads $(reloads); out: ${out}"
[[ "$out" == *"before: a.example.com 000/60"* && "$out" == *"after:  a.example.com 000/60"* ]] \
    && ok "the failing co-tenant is recorded as 000 on both sides" || nope "000 not recorded: ${out}"
drop_box

echo
echo "[T1] co-tenant 200 at baseline, failing after the reload"
make_box no
out="$(FAIL_NAME_AFTER=a.example.com; (setup_main) 2>&1)"; rc=$?
[[ $rc -ne 0 && "$(cat "$VH")" == "$ORIGINAL_VHOST" && "$(reloads)" == 2 ]] \
    && ok "200 -> 000 restores the vhost, reloads again, exits non-zero" \
    || nope "200->000: rc=${rc}, reloads $(reloads); out: ${out}"
[[ "$out" == *"CHANGED: a.example.com 200 -> 000/60"* ]] && ok "the 200 -> 000 change is named" || nope "200->000 not named: ${out}"
drop_box

echo
echo "[T1] co-tenant failing at baseline, answering after the reload"
make_box no
out="$(FAIL_NAME_BEFORE=a.example.com; (setup_main) 2>&1)"; rc=$?
[[ $rc -ne 0 && "$(cat "$VH")" == "$ORIGINAL_VHOST" && "$(reloads)" == 2 ]] \
    && ok "000 -> 200 is still a status change: restore path fires" \
    || nope "000->200: rc=${rc}, reloads $(reloads); out: ${out}"
drop_box

echo
echo "[T1] co-tenant TLS failure at baseline, connection refused after the reload"
make_box no
out="$(FAIL_NAME=a.example.com FAIL_RC_BEFORE=60 FAIL_RC_AFTER=7; (setup_main) 2>&1)"; rc=$?
[[ $rc -ne 0 && "$(cat "$VH")" == "$ORIGINAL_VHOST" && "$(reloads)" == 2 ]] \
    && ok "000/60 -> 000/7 is a change: vhost restored, nginx reloaded again, exits non-zero" \
    || nope "000/60->000/7: rc=${rc}, reloads $(reloads); out: ${out}"
[[ "$out" == *"CHANGED: a.example.com 000/60 -> 000/7"* ]] && ok "the failure-category change is named" || nope "000/60->000/7 not named: ${out}"
drop_box

echo
echo "[T1] co-tenant HTTP 200 then timeout at baseline, HTTP 502 then timeout after the reload"
make_box no
out="$(FAIL_NAME=a.example.com FAIL_HTTP_BEFORE=200 FAIL_HTTP_AFTER=502 FAIL_RC_BEFORE=28 FAIL_RC_AFTER=28; (setup_main) 2>&1)"; rc=$?
[[ $rc -ne 0 && "$(cat "$VH")" == "$ORIGINAL_VHOST" && "$(reloads)" == 2 ]] \
    && ok "200/28 -> 502/28 is a change: vhost restored, nginx reloaded again, exits non-zero" \
    || nope "200/28->502/28: rc=${rc}, reloads $(reloads); out: ${out}"
[[ "$out" == *"CHANGED: a.example.com 200/28 -> 502/28"* ]] && ok "the HTTP status change behind the timeout is named" || nope "200/28->502/28 not named: ${out}"
drop_box

echo
echo "[T1] local probe failures are not observations"
make_box no
out="$(FAIL_LOCAL_RC=127; (setup_main) 2>&1)"; rc=$?
mut="$(mutating_commands)"
[[ $rc -ne 0 && "$(reloads)" == 0 && "$(cat "$VH")" == "$ORIGINAL_VHOST" && ! -e "${BOX}/etc/nginx/snippets/jevnotjev-backstage.conf" && "$out" == *"simulated local failure"* ]] \
    && ok "curl exit 127 fails the probe, shows curl's stderr, and setup refuses before changing nginx" \
    || nope "curl 127: rc=${rc}, reloads $(reloads), mutating: ${mut:-none}; out: ${out}"
drop_box
make_box no
out="$(FAIL_MALFORMED=1; (setup_main) 2>&1)"; rc=$?
[[ $rc -ne 0 && "$(reloads)" == 0 && "$(cat "$VH")" == "$ORIGINAL_VHOST" && ! -e "${BOX}/etc/nginx/snippets/jevnotjev-backstage.conf" ]] \
    && ok "malformed probe output fails the probe and setup refuses before changing nginx" \
    || nope "malformed: rc=${rc}, reloads $(reloads); out: ${out}"
drop_box

echo
echo "[T1] interrupted between vhost write and validation"
make_box no
out="$(INTERRUPT_AT_NGINX_T=1; (setup_main) 2>&1)"; rc=$?
[[ $rc -ne 0 && "$(cat "$VH")" == "$ORIGINAL_VHOST" && ! -e "${BOX}/etc/nginx/snippets/jevnotjev-backstage.conf" && ! -e "${BOX}/var/lock/jevnotjev-backstage-deploy" ]] \
    && ok "an interruption mid nginx change restores the vhost, removes the snippet and releases the lock" \
    || nope "interrupt: rc=${rc}, vhost restored? $([[ "$(cat "$VH")" == "$ORIGINAL_VHOST" ]] && echo yes || echo no); out: ${out}"
: > "$RLOG"
out="$( (setup_main) 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" != *"already complete"* ]] && include_in_https_block "$VH" \
    && ok "the next run after an interruption completes the setup instead of reporting it done" \
    || nope "post-interrupt run: rc=${rc}; out: ${out}"
drop_box

echo
echo "[T1] refusals before any change"
make_box no
printf '# hand edited\n' >> "${BOX}/etc/systemd/system/jevnotjev-backstage.service"
out="$( (setup_main) 2>&1)"; rc=$?
mut="$(mutating_commands)"
[[ $rc -ne 0 && -z "$mut" && "$out" == *"differs"* ]] \
    && ok "an installed unit that differs from the repo is never overwritten (refuse, zero changes)" \
    || nope "differing unit: rc=${rc}, mutating: ${mut:-none}"
drop_box
make_box no
touch "${BOX}/state/port_used"
out="$( (setup_main) 2>&1)"; rc=$?
mut="$(mutating_commands)"
[[ $rc -ne 0 && -z "$mut" && "$out" == *"3456"* ]] \
    && ok "port 3456 held by something other than the service -> refuse, zero changes" \
    || nope "port used: rc=${rc}, mutating: ${mut:-none}"
drop_box
make_box no
rm "${BOX}/etc/nginx/sites-enabled/jevnotjev.breakoutwithai.com"
cp "$VH" "${BOX}/etc/nginx/sites-enabled/jevnotjev.breakoutwithai.com"
out="$( (setup_main) 2>&1)"; rc=$?
mut="$(mutating_commands)"
[[ $rc -ne 0 && -z "$mut" ]] \
    && ok "sites-enabled entry that is not a link to sites-available -> refuse, zero changes" \
    || nope "non-link enabled vhost: rc=${rc}, mutating: ${mut:-none}"
drop_box
make_box no
touch "${BOX}/state/ss_broken"
out="$( (setup_main) 2>&1)"; rc=$?
mut="$(mutating_commands)"
[[ $rc -ne 0 && -z "$mut" ]] && ok "socket inspection failing (ss exit 127) -> refuse, zero changes" \
    || nope "ss broken: rc=${rc}, mutating: ${mut:-none}"
drop_box
make_box no
printf '#!/usr/bin/env bash\necho 1.3.0\nexit 1\n' > "${BOX}/usr/local/bin/bun"
out="$( (setup_main) 2>&1)"; rc=$?
mut="$(mutating_commands)"
[[ $rc -ne 0 && -z "$mut" ]] && ok "bun that prints a version but exits non-zero -> refuse, zero changes" \
    || nope "broken bun: rc=${rc}, mutating: ${mut:-none}"
drop_box
make_box no
printf 'server {\n    listen 80;\n    server_name jevnotjev.breakoutwithai.com;\n}\n' > "$VH"
out="$( (setup_main) 2>&1)"; rc=$?
mut="$(mutating_commands)"
[[ $rc -ne 0 && -z "$mut" && ! -f "${BOX}/state/user" ]] \
    && ok "a vhost with no HTTPS block refuses before the user or unit is created" \
    || nope "HTTP-only vhost: rc=${rc}, mutating: ${mut:-none}"
drop_box
make_box yes
touch "${BOX}/state/enabled_runtime"
out="$( (setup_main) 2>&1)"; rc=$?
[[ $rc -eq 0 && ! -e "${BOX}/state/enabled_runtime" ]] && grep -q "systemctl enable 'jevnotjev-backstage'" "$RLOG" \
    && ok "runtime-only enablement (enabled-runtime) is converted to persistent enable, exit 0" \
    || nope "enabled-runtime: rc=${rc}: ${out}"
drop_box

echo
echo "[T1] include placement and server_name parsing"
make_box yes
# Move the include from the HTTPS block into the HTTP redirect block.
awk -v inc="    $INCLUDE_LINE" '$0 == inc {next} {print} /listen 80;/ {print inc}' "$VH" > "${VH}.x" && mv "${VH}.x" "$VH"
out="$( (setup_main) 2>&1)"; rc=$?
mut="$(mutating_commands)"
[[ $rc -ne 0 && -z "$mut" && "$out" != *"already complete"* ]] \
    && ok "an include sitting in the HTTP block is not accepted as complete (refuse, zero changes)" \
    || nope "misplaced include: rc=${rc}, mutating: ${mut:-none}; out: ${out}"
drop_box
printf 'server {\n    listen 443 ssl;\n    server_name other.example.com; set $t jevnotjev.breakoutwithai.com;\n}\n' \
    | insert_include "$INCLUDE_LINE" jevnotjev.breakoutwithai.com >/dev/null 2>&1 \
    && nope "a name after server_name's semicolon was taken as served" \
    || ok "only server_name's own arguments count (text after its ';' is ignored)"

echo
echo "[T1] interrupted during the reload"
make_box no
remote() {
    if [[ "$*" == "systemctl reload nginx" && ! -e "${BOX}/state/reload_interrupted" ]]; then
        touch "${BOX}/state/reload_interrupted"; fake_remote "$@"; exit 143
    fi
    fake_remote "$@"
}
out="$( (setup_main) 2>&1)"; rc=$?
remote() { fake_remote "$@"; }
[[ $rc -ne 0 && "$(cat "$VH")" == "$ORIGINAL_VHOST" && "$(reloads)" == 2 ]] \
    && ok "an interruption during the reload restores the vhost AND reloads it again" \
    || nope "reload interrupt: rc=${rc}, reloads $(reloads); out: ${out}"
drop_box
make_box no
sed -i.bak 's|listen 443 ssl; # managed by Certbot|listen 443 ssl; # include /etc/nginx/snippets/jevnotjev-backstage.conf;|' "$VH"; rm -f "${VH}.bak"
ORIGINAL_VHOST="$(cat "$VH")"
out="$( (setup_main) 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && include_in_https_block "$VH" \
    && ok "a commented-out include is not taken as present" \
    || nope "commented include: rc=${rc}; out: ${out}"
drop_box

echo
echo "[T1] --dry-run"
make_box no
before_fp="$(box_fingerprint)"
out="$( (setup_main --dry-run) 2>&1)"; rc=$?
mut="$(mutating_commands)"
[[ $rc -eq 0 && -z "$mut" && "$(box_fingerprint)" == "$before_fp" ]] \
    && ok "--dry-run issues zero mutating remote commands and the box is byte-identical" \
    || nope "dry-run: rc=${rc}, mutating: ${mut:-none}"
[[ "$out" == *"+"*"$INCLUDE_LINE"* && "$out" == *"useradd"* && "$out" == *"systemctl reload nginx"* ]] \
    && ok "--dry-run prints each planned remote command and the vhost diff" \
    || nope "dry-run output incomplete: ${out}"
drop_box

echo
echo "[T1] Basic Auth gate: snippet (A1)"
# Print the body of one location block of the repo snippet.
location_body() {
    awk -v want="$1" '
        { c=$0; sub(/#.*/, "", c) }
        !on && index(c, want) { on=1; depth=0 }
        on { print c; o=gsub(/\{/, "{", c); x=gsub(/\}/, "}", c); depth += o - x; if (depth == 0) exit }' \
        "${REPO_ROOT}/.deploy/backstage-nginx.conf"
}
for loc in "location ^~ /backstage/" "location ^~ /api/backstage/"; do
    body="$(location_body "$loc")"
    [[ "$(printf '%s\n' "$body" | grep -cE '^[[:space:]]*auth_basic "Backstage";$')" == 1 \
        && "$(printf '%s\n' "$body" | grep -cE '^[[:space:]]*auth_basic_user_file /etc/jevnotjev-backstage/htpasswd;$')" == 1 ]] \
        && ok "'${loc}' carries auth_basic \"Backstage\" and the htpasswd file once" \
        || nope "'${loc}' is not gated: ${body}"
done
grep -q 'proxy_set_header X-Backstage-Client-IP $remote_addr;' "${REPO_ROOT}/.deploy/backstage-nginx.conf" \
    && ok "the rest of the snippet is kept (client IP header still overwritten)" || nope "snippet lost its client IP header"

echo
echo "[T1] Basic Auth gate: htpasswd precondition (A2)"
HT_CMD_PATH="/etc/jevnotjev-backstage/htpasswd"
refuses_untouched() {  # $1 label, $2 expected text in output
    local out rc mut
    out="$( (setup_main) 2>&1)"; rc=$?
    mut="$(mutating_commands)"
    [[ $rc -ne 0 && -z "$mut" && "$(reloads)" == 0 && "$(cat "$VH")" == "$ORIGINAL_VHOST" \
        && ! -e "${BOX}/etc/nginx/snippets/jevnotjev-backstage.conf" && "$out" == *"$2"* ]] \
        && ok "$1" || nope "$1: rc=${rc}, mutating: ${mut:-none}; out: ${out}"
}
make_box no
rm -f "$HT" "${HT}.statmeta"
refuses_untouched "missing htpasswd -> refuse before any change, zero nginx changes" "$HT_CMD_PATH"
out="$( (setup_main) 2>&1)"
[[ "$out" == *"htpasswd -B -c ${HT_CMD_PATH}"* && "$out" == *"chown root:www-data ${HT_CMD_PATH}"* && "$out" == *"chmod 0640 ${HT_CMD_PATH}"* ]] \
    && ok "the refusal prints the exact operator command (htpasswd -B, chown root:www-data, chmod 0640)" \
    || nope "operator command missing: ${out}"
drop_box
make_box no
rm -f "$HT" "${HT}.statmeta" "${BOX}/usr/bin/htpasswd"
out="$( (setup_main) 2>&1)"
[[ "$out" == *"openssl passwd -apr1"* && "$out" != *"htpasswd -B"* ]] \
    && ok "without apache2-utils the printed command uses openssl passwd -apr1 (password prompted, never an argument)" \
    || nope "openssl fallback missing: ${out}"
drop_box
make_box no
: > "$HT"; printf 'root www-data 640 0\n' > "${HT}.statmeta"
refuses_untouched "an empty htpasswd -> refuse, zero changes" "$HT_CMD_PATH"
drop_box
make_box no
printf 'root www-data 644 44\n' > "${HT}.statmeta"
refuses_untouched "htpasswd mode 0644 -> refuse, zero changes" "0640"
drop_box
make_box no
printf 'www-data www-data 640 44\n' > "${HT}.statmeta"
refuses_untouched "htpasswd owned by www-data -> refuse, zero changes" "root"
drop_box
make_box no
printf 'root root 640 44\n' > "${HT}.statmeta"
refuses_untouched "htpasswd group root (nginx cannot read it) -> refuse, zero changes" "www-data"
drop_box
make_box no
printf 'root www-data 755 4096\n' > "${BOX}/etc/jevnotjev-backstage.statmeta"
refuses_untouched "htpasswd directory mode 0755 (looser than 0750) -> refuse, zero changes" "0750"
drop_box
make_box no
printf 'user nginx;\n' > "${BOX}/etc/nginx/nginx.conf"
refuses_untouched "nginx worker group read from nginx.conf (nginx), htpasswd group www-data -> refuse" "group 'nginx'"
printf 'root nginx 640 44\n' > "${HT}.statmeta"; printf 'root nginx 710 4096\n' > "${BOX}/etc/jevnotjev-backstage.statmeta"
out="$( (setup_main) 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && ok "htpasswd group matching nginx.conf's worker group, dir 0710 (tighter) -> accepted" \
    || nope "nginx group / 0710 dir: rc=${rc}; out: ${out}"
drop_box

echo
echo "[T1] Basic Auth gate: curl config precondition"
make_box no
out="$( (unset BACKSTAGE_CURL_CONFIG; setup_main) 2>&1)"; rc=$?
mut="$(mutating_commands)"
[[ $rc -ne 0 && -z "$mut" && "$out" == *"BACKSTAGE_CURL_CONFIG"* ]] \
    && ok "setup without BACKSTAGE_CURL_CONFIG refuses before any change and names the variable" \
    || nope "no curl config: rc=${rc}, mutating: ${mut:-none}; out: ${out}"
: > "$RLOG"
out="$( (unset BACKSTAGE_CURL_CONFIG; setup_main --dry-run) 2>&1)"; rc=$?
mut="$(mutating_commands)"
[[ $rc -eq 0 && -z "$mut" && "$out" == *"BACKSTAGE_CURL_CONFIG"* ]] \
    && ok "--dry-run without BACKSTAGE_CURL_CONFIG still plans, warning by name" \
    || nope "dry-run no curl config: rc=${rc}; out: ${out}"
drop_box

echo
echo "[T1] Basic Auth gate: installed snippet update (A2)"
OLD_SNIPPET="$(grep -v 'auth_basic' "${REPO_ROOT}/.deploy/backstage-nginx.conf")"
make_box yes
printf '%s\n' "$OLD_SNIPPET" > "${BOX}/etc/nginx/snippets/jevnotjev-backstage.conf"
out="$( (setup_main) 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && cmp -s "${BOX}/etc/nginx/snippets/jevnotjev-backstage.conf" "${REPO_ROOT}/.deploy/backstage-nginx.conf" \
    && ok "an installed snippet that differs is updated to the repo copy, exit 0" \
    || nope "snippet update: rc=${rc}; out: ${out}"
sbackup="$(find "${BOX}/var/backups/jevnotjev-backstage" -name 'jevnotjev-backstage.conf.*' -type f 2>/dev/null | head -1)"
[[ -n "$sbackup" && "$(cat "$sbackup")" == "$OLD_SNIPPET" ]] \
    && ok "the previous snippet is backed up before the update ($(basename "${sbackup:-none}"))" \
    || nope "no snippet backup holding the old snippet"
t_line="$(grep -n '^nginx -t' "$RLOG" | tail -1 | cut -d: -f1)"
r_line="$(grep -n 'systemctl reload nginx' "$RLOG" | head -1 | cut -d: -f1)"
[[ "$(reloads)" == 1 && -n "$t_line" && -n "$r_line" && "$t_line" -lt "$r_line" ]] \
    && ok "the update runs nginx -t before exactly one reload" || nope "update reloads=$(reloads), -t ${t_line:-none}, reload ${r_line:-none}"
[[ "$out" == *"before: a.example.com"* && "$out" == *"after:  a.example.com"* ]] \
    && ok "co-tenants are probed before and after the update" || nope "no co-tenant compare on update: ${out}"
[[ "$(cat "$VH")" == "$ORIGINAL_VHOST" ]] && ok "the vhost (include already placed) is left as it was" || nope "vhost changed on snippet update"
: > "$RLOG"
out="$( (setup_main) 2>&1)"; rc=$?
mut="$(mutating_commands)"
[[ $rc -eq 0 && -z "$mut" && "$(reloads)" == 1 ]] \
    && ok "re-running after the update is a no-op (identical snippet)" || nope "post-update rerun: rc=${rc}, mutating: ${mut:-none}"
drop_box

echo
echo "[T1] Basic Auth gate: post-setup verification (A4)"
make_box no
out="$( (setup_main) 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" == *"/backstage/"*"401"* && "$out" == *"/api/backstage/health"*"401"* ]] \
    && ok "setup verifies unauthenticated /backstage/ and /api/backstage/health return 401" \
    || nope "verification not reported: rc=${rc}; out: ${out}"
grep -E 'https://jevnotjev\.breakoutwithai\.com/(api/)?backstage/' "${BOX}/curl.log" | grep -q -- '--config' \
    && ok "the authenticated probe uses the curl config file" || nope "no authenticated probe: $(cat "${BOX}/curl.log")"
grep -E 'https://jevnotjev\.breakoutwithai\.com/(api/)?backstage/' "${BOX}/curl.log" | grep -qv -- '--resolve jevnotjev.breakoutwithai.com:443:192.0.2.1' \
    && nope "a Backstage probe is not pinned to the host" || ok "every Backstage probe is pinned to the host just changed"
drop_box
make_box yes
printf '%s\n' "$OLD_SNIPPET" > "${BOX}/etc/nginx/snippets/jevnotjev-backstage.conf"
out="$(UNAUTH_CODE=200; (setup_main) 2>&1)"; rc=$?
[[ $rc -ne 0 && "$(cat "${BOX}/etc/nginx/snippets/jevnotjev-backstage.conf")" == "$OLD_SNIPPET" && "$(cat "$VH")" == "$ORIGINAL_VHOST" && "$(reloads)" == 2 ]] \
    && ok "unauthenticated 200 after the reload -> previous snippet and vhost restored, reloaded again, exit non-zero" \
    || nope "unauth 200 (update): rc=${rc}, reloads $(reloads); out: ${out}"
drop_box
make_box no
out="$(UNAUTH_CODE=502; (setup_main) 2>&1)"; rc=$?
[[ $rc -ne 0 && ! -e "${BOX}/etc/nginx/snippets/jevnotjev-backstage.conf" && "$(cat "$VH")" == "$ORIGINAL_VHOST" && "$(reloads)" == 2 ]] \
    && ok "unauthenticated 502 (auth not ahead of the proxy) on a fresh install -> snippet removed, vhost restored" \
    || nope "unauth 502 (install): rc=${rc}, reloads $(reloads); out: ${out}"
drop_box
make_box no
out="$(AUTHED_CODE=401; (setup_main) 2>&1)"; rc=$?
[[ $rc -ne 0 && ! -e "${BOX}/etc/nginx/snippets/jevnotjev-backstage.conf" && "$(cat "$VH")" == "$ORIGINAL_VHOST" && "$(reloads)" == 2 ]] \
    && ok "authenticated probe still 401 (wrong credentials) -> restore, exit non-zero" \
    || nope "authed 401: rc=${rc}, reloads $(reloads); out: ${out}"
drop_box

echo
echo "[T1] Basic Auth gate: credentials never leave the curl config"
leaks=0
for scenario in yes no; do
    make_box "$scenario"
    [[ "$scenario" == yes ]] && printf '%s\n' "$OLD_SNIPPET" > "${BOX}/etc/nginx/snippets/jevnotjev-backstage.conf"
    out="$( (setup_main) 2>&1)"
    for f in "$RLOG" "${BOX}/curl.log"; do grep -qF "$TEST_PASSWORD" "$f" && leaks=$((leaks+1)); done
    [[ "$out" == *"$TEST_PASSWORD"* ]] && leaks=$((leaks+1))
    grep -qF "tester:" "${BOX}/curl.log" && leaks=$((leaks+1))
    drop_box
done
[[ $leaks -eq 0 ]] && ok "the password is in no remote command, no curl argument and no output (install and update runs)" \
    || nope "credential leaked ${leaks} time(s)"

echo
echo "[T1] secret boundary"
trial_hits=0
for scenario in yes no; do
    make_box "$scenario"
    (setup_main) >/dev/null 2>&1
    # /etc/jevnotjev-backstage also holds the operator's htpasswd, which setup must inspect.
    grep -q 'trial\.env' "$RLOG" && trial_hits=$((trial_hits+1))
    drop_box
done
code_refs="$(grep -c 'trial\.env' "$SETUP")"
[[ $trial_hits -eq 0 && "$code_refs" == 0 ]] \
    && ok "setup never reads, writes or names trial.env (remote log and script source)" \
    || nope "trial.env touched: ${trial_hits} run(s), ${code_refs} reference(s) in ${SETUP}"

rm -rf "$STUB" "$KEYDIR"
echo
echo "[T1] passed=${pass} failed=${fail}"
[[ $fail -eq 0 ]]
