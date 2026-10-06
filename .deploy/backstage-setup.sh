#!/usr/bin/env bash
#
# backstage-setup.sh - ONE-TIME Backstage setup on the shared host, idempotent.
# Encodes docs/backstage-deploy.md "One-time setup" steps 1-4; step 5 is the deploy itself.
#
#   1. probe: Linux x86_64, /usr/local/bin/bun runs, port 3456 free (or held by our own service),
#      the vhost is installed and enabled as a link, and what is already configured
#   2. service user jevnotjev-backstage (system, no login) if absent; namespace journal
#      config and unit installed if absent, daemon-reload, enable. Never started here: no release exists yet.
#   3. snippet installed if absent, or UPDATED (after its own backup) when it differs from the
#      repo copy; the include inserted ONLY if absent, inside the domain's HTTPS server block,
#      after a timestamped backup of the installed vhost. The vhost is never replaced by the repo
#      template (certbot owns its TLS lines, see provision.sh).
#   4. nginx -t before the reload, `systemctl reload nginx` never restart, co-tenants probed
#      before and after. nginx -t failure: restore, no reload. Changed co-tenant: restore,
#      nginx -t, reload again.
#   5. The selected Basic or session gate is verified after the reload. Otherwise: restore.
#
# A Basic snippet requires the operator's existing htpasswd. A session snippet requires nginx's
# auth_request module, auth.env and operators.json. A running release must be sign-in capable. Setup never
# creates credentials or secrets.
# An installed unit or namespace journal config that differs from the repo is reported and left alone. The funded-trial
# secret file is outside this script's scope.
#
# Usage:
#   ./.deploy/backstage-setup.sh --dry-run   read-only probes, print planned commands + vhost diff
#   ./.deploy/backstage-setup.sh             apply what is absent or outdated (needs BACKSTAGE_CURL_CONFIG)
# Bash 3.2 compatible. Sourcing this file defines functions only; the tests drive them.

SETUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SETUP_DIR}/config.sh"
# shellcheck source=/dev/null
source "${SETUP_DIR}/lib.sh"
# shellcheck source=/dev/null
source "${SETUP_DIR}/backstage-lib.sh"
# shellcheck source=/dev/null
source "${SETUP_DIR}/verify-lib.sh"

readonly BS_SERVICE="jevnotjev-backstage"
readonly BS_USER="jevnotjev-backstage"
readonly BS_UNIT_SRC="${SETUP_DIR}/backstage.service"
readonly BS_JOURNAL_SRC="${SETUP_DIR}/journald@jevnotjev-backstage.conf"
BS_SNIPPET_SRC="${SETUP_DIR}/backstage-nginx.conf"
readonly BS_UNIT="/etc/systemd/system/${BS_SERVICE}.service"
readonly BS_JOURNAL="/etc/systemd/journald@jevnotjev-backstage.conf"
readonly BS_SNIPPET="/etc/nginx/snippets/jevnotjev-backstage.conf"
readonly BS_INCLUDE="include ${BS_SNIPPET};"
readonly BS_BUN="/usr/local/bin/bun"
readonly BS_PORT="3456"
readonly BS_BACKUP_DIR="/var/backups/jevnotjev-backstage"
# Same lock backstage-deploy.sh takes, so a setup and a deploy never overlap.
readonly BS_LOCK="/var/lock/jevnotjev-backstage-deploy"
# Basic Auth credentials: created by the operator on the host, never by this script.
readonly BS_HTPASSWD_DIR="/etc/jevnotjev-backstage"
readonly BS_HTPASSWD="${BS_HTPASSWD_DIR}/htpasswd"
readonly BS_HTPASSWD_TOOL="/usr/bin/htpasswd"
readonly BS_AUTH_ENV="/etc/jevnotjev-backstage/auth.env"
readonly BS_OPERATORS="/var/lib/jevnotjev-backstage/operators.json"
readonly BS_CURRENT="/var/www/jevnotjev-backstage-current"

# insert_include - pure. vhost text on stdin, include line as $1. Prints the vhost with the
# include added once, at server level, right after the first `listen ...443` line of the ONLY
# server block that listens on 443, and only when that block's server_name includes $2.
# Returns 3 when there is not exactly one such block, 4 when it serves another domain.
# Fails closed on nginx syntax it does not model (quoted braces): the block count is then wrong.
insert_include() {
    awk -v inc="$1" -v dom="$2" '
        { line[NR] = $0; c = $0; sub(/#.*/, "", c) }
        depth == 0 && c ~ /^[[:space:]]*server[[:space:]]*(\{|$)/ { blk++ }
        depth == 1 && c ~ /^[[:space:]]*listen[[:space:]]+([^;]*:)?443([^0-9]|$)/ && !(blk in at) { at[blk] = NR; n++ }
        depth == 1 && c ~ /^[[:space:]]*server_name[[:space:]]/ {
            s = c; sub(/;.*$/, "", s); k = split(s, f, /[[:space:]]+/)
            for (j = 1; j <= k; j++) if (f[j] == dom) named[blk] = 1
        }
        { o = gsub(/\{/, "{", c); x = gsub(/\}/, "}", c); depth += o - x; if (depth < 0) bad = 1 }
        END {
            if (n != 1 || depth != 0 || bad) exit 3
            for (b in at) { target = at[b]; tb = b }
            if (!(tb in named)) exit 4
            ind = line[target]; sub(/[^[:space:]].*$/, "", ind)
            for (i = 1; i <= NR; i++) { print line[i]; if (i == target) print ind inc }
        }'
}

# include_placed - pure. vhost on stdin. True only when the include directive ($1) appears
# exactly once, uncommented, at server level of the single 443 block whose server_name has $2.
include_placed() {
    awk -v inc="$1" -v dom="$2" '
        { c = $0; sub(/#.*/, "", c) }
        depth == 0 && c ~ /^[[:space:]]*server[[:space:]]*(\{|$)/ { blk++ }
        depth == 1 && c ~ /^[[:space:]]*listen[[:space:]]+([^;]*:)?443([^0-9]|$)/ { https[blk] = 1 }
        depth == 1 && c ~ /^[[:space:]]*server_name[[:space:]]/ {
            s = c; sub(/;.*$/, "", s); k = split(s, f, /[[:space:]]+/)
            for (j = 1; j <= k; j++) if (f[j] == dom) named[blk] = 1
        }
        { t = c; gsub(/^[[:space:]]+|[[:space:]]+$/, "", t) }
        t == inc { total++; if (depth == 1) { at = blk; good++ } }
        { o = gsub(/\{/, "{", c); x = gsub(/\}/, "}", c); depth += o - x }
        END { exit !(total == 1 && good == 1 && (at in https) && (at in named)) }'
}

# setup_probe - ONE read-only remote command; prints key=value lines.
setup_probe() {
    remote "U='${BS_UNIT}' J='${BS_JOURNAL}' S='${BS_SNIPPET}' I='${BS_INCLUDE}' V='${VHOST_AVAILABLE}' E='${VHOST_ENABLED}' B='${BS_BUN}' P='${BS_PORT}' N='${BS_USER}' A='${BS_AUTH_ENV}' O='${BS_OPERATORS}' C='${BS_CURRENT}'
echo \"arch=\$(uname -m)\"
if [ ! -x \"\$B\" ]; then echo bun=absent; elif v=\$(\"\$B\" --version 2>/dev/null) && [ -n \"\$v\" ]; then echo \"bun=\$v\"; else echo bun=broken; fi
if id -u \"\$N\" >/dev/null 2>&1; then echo user=present; else echo user=absent; fi
if ! l=\$(ss -Hltn \"sport = :\$P\" 2>/dev/null); then echo port=unknown; elif [ -n \"\$l\" ]; then echo port=used; else echo port=free; fi
if [ -f \"\$U\" ]; then echo \"unit=\$(sha256sum \"\$U\" | cut -d' ' -f1)\"; else echo unit=absent; fi
if [ -f \"\$J\" ]; then echo \"journald=\$(sha256sum \"\$J\" | cut -d' ' -f1)\"; else echo journald=absent; fi
if [ -f \"\$S\" ]; then echo \"snippet=\$(sha256sum \"\$S\" | cut -d' ' -f1)\"; else echo snippet=absent; fi
if [ -f \"\$V\" ]; then echo vhost=present; else echo vhost=absent; fi
if [ -L \"\$E\" ] && [ \"\$(readlink \"\$E\")\" = \"\$V\" ]; then echo vhost_link=yes; else echo vhost_link=no; fi
if sed 's/#.*//' \"\$V\" 2>/dev/null | grep -qF \"\$I\"; then echo include=present; else echo include=absent; fi
if [ \"\$(systemctl is-enabled \"\$N\" 2>/dev/null)\" = enabled ]; then echo enabled=yes; else echo enabled=no; fi
if systemctl is-active --quiet \"\$N\" 2>/dev/null; then echo active=yes; else echo active=no; fi
if systemctl is-active --quiet \"\$N\" 2>/dev/null && [ -L \"\$C\" ] && [ -d \"\$C\" ]; then echo release=running; else echo release=none; fi
H='${BS_HTPASSWD}' D='${BS_HTPASSWD_DIR}' T='${BS_HTPASSWD_TOOL}'
if [ -x \"\$T\" ]; then echo ht_tool=htpasswd; else echo ht_tool=openssl; fi
g=unknown
if dump=\$(nginx -T 2>/dev/null); then
    u=\$(printf '%s\n' \"\$dump\" | awk '{ sub(/#.*/, \"\") } \$1 == \"user\" { sub(/;.*/, \"\"); print (\$3 != \"\" ? \$3 : \$2) }' | sort -u)
    if [ -n \"\$u\" ] && [ \"\$(printf '%s\n' \"\$u\" | wc -l)\" -eq 1 ]; then g=\"\$u\"; fi
fi
echo \"nginx_group=\$g\"
if [ -L \"\$H\" ]; then echo htpasswd=symlink; elif [ ! -e \"\$H\" ]; then echo htpasswd=absent; elif [ ! -f \"\$H\" ]; then echo htpasswd=notfile
elif m=\$(stat -c '%U %G %a %s' \"\$H\" 2>/dev/null); then echo \"htpasswd=\$(printf '%s' \"\$m\" | tr ' ' ':')\"; else echo htpasswd=unknown; fi
if [ -L \"\$D\" ]; then echo htpasswd_dir=symlink; elif [ ! -d \"\$D\" ]; then echo htpasswd_dir=absent
elif m=\$(stat -c '%U %G %a %s' \"\$D\" 2>/dev/null); then echo \"htpasswd_dir=\$(printf '%s' \"\$m\" | tr ' ' ':')\"; else echo htpasswd_dir=unknown; fi
if nginx -V 2>&1 | grep -q -- '--with-http_auth_request_module'; then echo auth_request=yes; else echo auth_request=no; fi
if systemctl is-active --quiet \"\$N\" 2>/dev/null && [ -L \"\$C\" ] && [ -d \"\$C\" ]; then
    payload=\$(curl -sS --max-time 5 -w '\\n%{http_code}' http://127.0.0.1:3456/api/auth/session 2>/dev/null) || payload=unknown
    code=\$(printf '%s\\n' \"\$payload\" | tail -1)
    if [ \"\$code\" = 401 ] && printf '%s\\n' \"\$payload\" | grep -Eq '\"signIn\"[[:space:]]*:[[:space:]]*\"ready\"'; then echo session_check=ready; else echo session_check=unready; fi
else echo session_check=skipped; fi
for spec in auth_env:\"\$A\" operators:\"\$O\"; do
    kind=\${spec%%:*}; file=\${spec#*:}
    if [ -L \"\$file\" ]; then echo \"\$kind=symlink\"
    elif [ ! -e \"\$file\" ]; then echo \"\$kind=absent\"
    elif [ ! -f \"\$file\" ]; then echo \"\$kind=notfile\"
    elif m=\$(stat -c '%U %G %a %s' \"\$file\" 2>/dev/null); then echo \"\$kind=\$(printf '%s' \"\$m\" | tr ' ' ':')\"
    else echo \"\$kind=unknown\"; fi
done
if [ -f \"\$A\" ] && [ ! -L \"\$A\" ]; then
    echo \"auth_secret=\$(grep -Ec '^BACKSTAGE_SESSION_SECRET=.{32,}$' \"\$A\" 2>/dev/null || true)\"
    echo \"auth_trust_proxy=\$(grep -c '^BACKSTAGE_TRUST_PROXY=loopback$' \"\$A\" 2>/dev/null || true)\"
else echo auth_secret=0; echo auth_trust_proxy=0; fi"
}

session_ready() {
    local probe="$1" kind value owner group mode size release
    release="$(probe_get "$probe" release)"
    for kind in auth_request session_check auth_env operators; do
        value="$(probe_get "$probe" "$kind")"
        case "$kind" in
            auth_request) [[ "$value" == yes ]] || { log_error "Session precondition auth_request failed: nginx needs --with-http_auth_request_module. Refusing; nothing changed."; return 1; } ;;
            session_check)
                if [[ "$release" == running && "$value" != ready ]]; then
                    log_error "Session precondition release failed: /api/auth/session must return 401 with \"signIn\":\"ready\" on loopback. Deploy the sign-in-capable release, then run operator step 5: install -m 0644 .deploy/journald@jevnotjev-backstage.conf /etc/systemd/journald@jevnotjev-backstage.conf && install -m 0644 .deploy/backstage.service /etc/systemd/system/jevnotjev-backstage.service && systemctl daemon-reload && systemctl restart jevnotjev-backstage. Refusing; nothing changed."
                    return 1
                fi ;;
            auth_env|operators)
                [[ "$kind" != operators || "$release" == running ]] || continue
                IFS=: read -r owner group mode size <<< "$value"
                if [[ "$kind" == auth_env ]]; then
                    if [[ "$owner" != root || "$mode" != 600 || ! "$size" =~ ^[0-9]+$ ]]; then
                        log_error "Session precondition auth_env failed: ${BS_AUTH_ENV} must be a regular, non-symlink root-owned mode 0600 file. Create it in an interactive root session with BACKSTAGE_SESSION_SECRET from openssl rand -hex 32, Google client ID and secret, and BACKSTAGE_TRUST_PROXY=loopback. Refusing; nothing changed."
                        return 1
                    fi
                    if [[ "$(probe_get "$probe" auth_secret)" != 1 || "$(probe_get "$probe" auth_trust_proxy)" != 1 ]]; then
                        log_error "Session precondition auth_env failed: ${BS_AUTH_ENV} must set BACKSTAGE_SESSION_SECRET to 32+ characters and BACKSTAGE_TRUST_PROXY=loopback. Run operator step 2: write /etc/jevnotjev-backstage/auth.env in an interactive root session, root-owned mode 0600, with BACKSTAGE_SESSION_SECRET from openssl rand -hex 32, BACKSTAGE_GOOGLE_CLIENT_ID, BACKSTAGE_GOOGLE_CLIENT_SECRET, and BACKSTAGE_TRUST_PROXY=loopback. Refusing; nothing changed."
                        return 1
                    fi
                elif [[ "$owner" != "$BS_USER" || "$mode" != 600 || ! "$size" =~ ^[0-9]+$ || "$size" -eq 0 ]]; then
                    log_error "Session precondition operators failed: ${BS_OPERATORS} must be a regular, non-empty, non-symlink ${BS_USER}-owned mode 0600 file. Run: install -o jevnotjev-backstage -g jevnotjev-backstage -m 0600 operators.json /var/lib/jevnotjev-backstage/operators.json. Refusing; nothing changed."
                    return 1
                fi ;;
        esac
    done
}

# htpasswd_command - the exact command the operator runs ON THE HOST, as root, to create the
# credentials file. The password is typed at the tool's prompt: never an argument, env or log.
# $1 = htpasswd|openssl (what the host has), $2 = nginx worker group.
htpasswd_command() {
    local make
    if [[ "$1" == htpasswd ]]; then
        make="htpasswd -B -c ${BS_HTPASSWD} tester"
    else
        make="h=\$(openssl passwd -apr1) && (umask 027; printf 'tester:%s\\n' \"\$h\" > ${BS_HTPASSWD})"
    fi
    printf '    install -d -o root -g %s -m 0750 %s && %s && chown root:%s %s && chmod 0640 %s\n' \
        "$2" "$BS_HTPASSWD_DIR" "$make" "$2" "$BS_HTPASSWD" "$BS_HTPASSWD"
}

# htpasswd_ready - from the probe: the credentials file nginx will read is in place and private.
# Logs the reason and the operator command, and returns 1, otherwise.
htpasswd_ready() {
    local probe="$1" group tool ht dir owner g mode size problem=""
    group="$(probe_get "$probe" nginx_group)"
    if [[ "$group" == unknown || ! "$group" =~ ^[a-z_][a-z0-9_-]*$ ]]; then
        log_error "Cannot determine nginx's worker group from the effective config (nginx -T: no single 'user' directive, or nginx -T failed). Refusing; nothing changed."
        return 1
    fi
    tool="$(probe_get "$probe" ht_tool)"
    ht="$(probe_get "$probe" htpasswd)"
    dir="$(probe_get "$probe" htpasswd_dir)"
    case "$ht" in
        absent|"") problem="${BS_HTPASSWD} is absent." ;;
        symlink|notfile|unknown) problem="${BS_HTPASSWD} is not a readable regular file (${ht})." ;;
        *)
            IFS=: read -r owner g mode size <<< "$ht"
            if [[ ! "$size" =~ ^[0-9]+$ || "$size" -eq 0 ]]; then problem="${BS_HTPASSWD} is empty."
            elif [[ "$owner" != root ]]; then problem="${BS_HTPASSWD} is owned by '${owner}'; required owner root."
            elif [[ "$g" != "$group" ]]; then problem="${BS_HTPASSWD} has group '${g}'; nginx workers run as group '${group}' (nginx -T), required root:${group}."
            elif [[ "$mode" != 640 ]]; then problem="${BS_HTPASSWD} is mode 0${mode}; required 0640."
            fi ;;
    esac
    if [[ -z "$problem" ]]; then
        case "$dir" in
            ""|absent|symlink|unknown) problem="${BS_HTPASSWD_DIR} is not a directory (${dir:-unknown})." ;;
            *)
                IFS=: read -r owner g mode size <<< "$dir"
                if [[ "$owner" != root ]]; then problem="${BS_HTPASSWD_DIR} is owned by '${owner}'; required owner root."
                elif [[ ! "$mode" =~ ^[0-7]{3,4}$ ]] || (( 8#$mode & ~8#750 )); then problem="${BS_HTPASSWD_DIR} is mode 0${mode}; required 0750 or tighter."
                elif [[ "$g" != "$group" ]] || ! (( 8#$mode & 8#010 )); then problem="${BS_HTPASSWD_DIR} (root:${g} 0${mode}) is not traversable by nginx group '${group}'; required root:${group} 0750 or 0710."
                fi ;;
        esac
    fi
    [[ -z "$problem" ]] && return 0
    log_error "Basic Auth credentials not ready: ${problem}"
    log_error "No nginx change was made. Create or fix the file on ${SERVER} as root (ssh -t), typing the password at the prompt; replace 'tester' with the login name:"
    htpasswd_command "${tool:-openssl}" "$group" >&2
    return 1
}

probe_get() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -1; }
local_sha() { shasum -a 256 "$1" | awk '{print $1}'; }

# setup_plan - decide what is absent from a probe. Sets PLAN_* globals. Logs the reason and
# returns 1 on any refusal; a refusal happens before any change.
setup_plan() {
    local probe="$1" v
    v="$(probe_get "$probe" arch)"
    [[ "$v" == "x86_64" ]] || { log_error "Host architecture is '${v:-unknown}', expected x86_64."; return 1; }
    v="$(probe_get "$probe" bun)"
    [[ -n "$v" && "$v" != absent && "$v" != broken ]] || { log_error "${BS_BUN} is '${v:-unknown}' on the host; Backstage needs it."; return 1; }
    log_info "Host: x86_64, bun ${v}"
    [[ "$(probe_get "$probe" vhost)" == present ]] \
        || { log_error "${VHOST_AVAILABLE} is not installed. Run ./.deploy/ship.sh --setup --module static first."; return 1; }
    [[ "$(probe_get "$probe" vhost_link)" == yes ]] \
        || { log_error "${VHOST_ENABLED} is not a link to ${VHOST_AVAILABLE}; editing sites-available would change nothing served. Inspect by hand."; return 1; }
    v="$(probe_get "$probe" port)"
    [[ "$v" == free || "$v" == used ]] || { log_error "Could not inspect port ${BS_PORT} on the host (ss failed)."; return 1; }
    if [[ "$v" == used && "$(probe_get "$probe" active)" != yes ]]; then
        log_error "Port ${BS_PORT} is in use and ${BS_SERVICE} is not running: another process holds it."; return 1
    fi
    PLAN_GATE="$(backstage_snippet_auth < "$BS_SNIPPET_SRC")" || return 1
    PLAN_RELEASE="$(probe_get "$probe" release)"
    case "$PLAN_GATE" in
        yes) htpasswd_ready "$probe" || return 1 ;;
        session) session_ready "$probe" || return 1 ;;
        *) log_error "Repo snippet gate is '${PLAN_GATE}'; refusing setup."; return 1 ;;
    esac

    PLAN_USER=false; PLAN_JOURNAL=false; PLAN_UNIT=false; PLAN_ENABLE=false; PLAN_SNIPPET=false; PLAN_SNIPPET_UPDATE=false; PLAN_INCLUDE=false
    [[ "$(probe_get "$probe" user)" == present ]] || PLAN_USER=true
    v="$(probe_get "$probe" unit)"
    if [[ "$v" == absent ]]; then
        PLAN_UNIT=true
    elif [[ "$v" != "$(local_sha "$BS_UNIT_SRC")" ]]; then
        log_error "Installed ${BS_UNIT} differs from .deploy/backstage.service. Install it by hand: install -m 0644 .deploy/journald@jevnotjev-backstage.conf /etc/systemd/journald@jevnotjev-backstage.conf && install -m 0644 .deploy/backstage.service /etc/systemd/system/jevnotjev-backstage.service && systemctl daemon-reload && systemctl restart jevnotjev-backstage"; return 1
    fi
    v="$(probe_get "$probe" journald)"
    if [[ -z "$v" || "$v" == absent ]]; then
        PLAN_JOURNAL=true
    elif [[ "$v" != "$(local_sha "$BS_JOURNAL_SRC")" ]]; then
        log_error "Installed ${BS_JOURNAL} differs from .deploy/journald@jevnotjev-backstage.conf. Install it by hand: install -m 0644 .deploy/journald@jevnotjev-backstage.conf /etc/systemd/journald@jevnotjev-backstage.conf && install -m 0644 .deploy/backstage.service /etc/systemd/system/jevnotjev-backstage.service && systemctl daemon-reload && systemctl restart jevnotjev-backstage"; return 1
    fi
    [[ "$(probe_get "$probe" enabled)" == yes ]] || PLAN_ENABLE=true
    v="$(probe_get "$probe" snippet)"
    if [[ "$v" == absent ]]; then
        PLAN_SNIPPET=true
    elif [[ "$v" != "$(local_sha "$BS_SNIPPET_SRC")" ]]; then
        # Same guarded path as the include: backup, nginx -t, reload, co-tenants, auth check.
        log_info "Installed ${BS_SNIPPET} differs from .deploy/backstage-nginx.conf; it will be updated."
        PLAN_SNIPPET=true; PLAN_SNIPPET_UPDATE=true
    fi
    [[ "$(probe_get "$probe" include)" == present ]] || PLAN_INCLUDE=true
    return 0
}

plan_is_empty() { ! $PLAN_USER && ! $PLAN_JOURNAL && ! $PLAN_UNIT && ! $PLAN_ENABLE && ! $PLAN_SNIPPET && ! $PLAN_INCLUDE; }

# print_plan - the remote commands a real run issues, in order.
print_plan() {
    local p="  ${YELLOW}[plan]${NC}"
    $PLAN_USER   && echo "$p useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ${BS_USER}"
    $PLAN_JOURNAL && echo "$p cat > ${BS_JOURNAL}.tmp < .deploy/journald@jevnotjev-backstage.conf, mv into place"
    $PLAN_UNIT   && echo "$p cat > ${BS_UNIT}.tmp < .deploy/backstage.service, mv into place, systemctl daemon-reload"
    $PLAN_ENABLE && echo "$p systemctl enable ${BS_SERVICE}   (not started: no release yet)"
    if $PLAN_SNIPPET || $PLAN_INCLUDE; then
        echo "$p probe every co-tenant in /etc/nginx/sites-enabled (baseline)"
        echo "$p cp -p ${VHOST_AVAILABLE} ${BS_BACKUP_DIR}/${DOMAIN}.<UTC>"
        $PLAN_SNIPPET_UPDATE && echo "$p cp -p ${BS_SNIPPET} ${BS_BACKUP_DIR}/jevnotjev-backstage.conf.<UTC>   (installed snippet differs: update)"
        $PLAN_SNIPPET && echo "$p cat > ${BS_SNIPPET}.tmp < .deploy/backstage-nginx.conf, mv into place"
        $PLAN_INCLUDE && echo "$p insert '${BS_INCLUDE}' into the HTTPS server block of ${VHOST_AVAILABLE}"
        echo "$p nginx -t   (failure: restore the backup, no reload)"
        echo "$p systemctl reload nginx   (never restart)"
        echo "$p re-probe co-tenants   (changed: restore the backup, nginx -t, systemctl reload nginx)"
        if [[ "$PLAN_GATE" == session ]]; then
            echo "$p session preconditions: nginx --with-http_auth_request_module; loopback /api/auth/session 401; ${BS_AUTH_ENV} root 0600; ${BS_OPERATORS} ${BS_USER} 0600, non-empty"
            echo "$p session S2: anon redirect, API 401 without Basic challenge, sign-in form, tampered cookie refused, minted session accepted   (else: restore)"
        else
            echo "$p GET /backstage/ and /api/backstage/health: 401 without credentials; with BACKSTAGE_CURL_CONFIG 200 (release running) or 502 (none)   (else: restore)"
        fi
    fi
    return 0
}

# restore_nginx - put the saved vhost back and undo this run's snippet change ($2: none, remove
# for a snippet this run created, or the path of the saved previous snippet). Reloads only
# when this run already reloaded, and only after BOTH files are restored and the restored config
# passes nginx -t. A failed copy returns 1 at once with BS_PENDING_BACKUP still set, so the EXIT
# trap retries, and nothing is reloaded over a half-restored config.
restore_nginx() {
    local backup="$1" snippet_undo="$2" reloaded="$3"
    log_warn "Restoring ${VHOST_AVAILABLE} from ${backup}"
    if ! remote "cp -p '${backup}' '${VHOST_AVAILABLE}'"; then
        log_error "RESTORE FAILED: copy ${backup} over ${VHOST_AVAILABLE} by hand, then nginx -t and reload. Nothing was reloaded."
        return 1
    fi
    case "$snippet_undo" in
        none) ;;
        remove)
            remote "rm -f '${BS_SNIPPET}'" \
                || { log_error "RESTORE FAILED: remove ${BS_SNIPPET} by hand, then nginx -t and reload. Nothing was reloaded."; return 1; } ;;
        *)
            remote "cp -p '${snippet_undo}' '${BS_SNIPPET}'" \
                || { log_error "RESTORE FAILED: copy ${snippet_undo} over ${BS_SNIPPET} by hand, then nginx -t and reload. Nothing was reloaded."; return 1; } ;;
    esac
    BS_PENDING_BACKUP=""
    if ! remote "nginx -t" 2>&1; then
        log_error "The restored config fails nginx -t. Inspect nginx now; nothing was reloaded."
        return 1
    fi
    if $reloaded; then
        remote "systemctl reload nginx" || { log_error "Reload after restore FAILED. Inspect nginx now."; return 1; }
    fi
    return 0
}

# apply_nginx - steps 3-4. Returns non-zero after restoring on any failure.
apply_nginx() {
    local names before after changed stamp backup newvhost n
    local -a neighbours=()
    names="$(backstage_list_neighbours "$DOMAIN")" || { log_error "Cannot enumerate co-tenants; refusing to change nginx blind."; return 1; }
    while IFS= read -r n; do [[ -z "$n" ]] || neighbours+=("$n"); done <<< "$names"
    # Our own static site shares the vhost being edited: its status must not change either.
    neighbours+=("$DOMAIN")
    before="$(backstage_probe_neighbours "$SERVER_HOST" "${neighbours[@]}")" \
        || { log_error "Co-tenant baseline includes a failed probe; refusing to change nginx."; return 1; }
    printf '%s\n' "$before" | sed '/^$/d; s/^/    before: /'

    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    backup="${BS_BACKUP_DIR}/${DOMAIN}.${stamp}"
    remote "mkdir -p '${BS_BACKUP_DIR}' && chmod 0700 '${BS_BACKUP_DIR}' && cp -p '${VHOST_AVAILABLE}' '${backup}'" \
        || { log_error "Could not back up ${VHOST_AVAILABLE}; nginx unchanged."; return 1; }
    log_success "Backup: ${backup}"
    BS_PENDING_BACKUP="$backup"; BS_RELOADED=false; BS_SNIPPET_UNDO=none

    if $PLAN_SNIPPET_UPDATE; then
        local sbackup="${BS_BACKUP_DIR}/jevnotjev-backstage.conf.${stamp}"
        remote "cp -p '${BS_SNIPPET}' '${sbackup}'" \
            || { log_error "Could not back up ${BS_SNIPPET}; nginx unchanged."; restore_nginx "$backup" none false; return 1; }
        log_success "Snippet backup: ${sbackup}"
        BS_SNIPPET_UNDO="$sbackup"
    elif $PLAN_SNIPPET; then
        BS_SNIPPET_UNDO=remove
    fi
    if $PLAN_SNIPPET; then
        remote "mkdir -p '$(dirname "$BS_SNIPPET")' && cat > '${BS_SNIPPET}.tmp' && chmod 0644 '${BS_SNIPPET}.tmp' && mv '${BS_SNIPPET}.tmp' '${BS_SNIPPET}'" < "$BS_SNIPPET_SRC" \
            || { log_error "Could not install ${BS_SNIPPET}."; restore_nginx "$backup" "$BS_SNIPPET_UNDO" false; return 1; }
    fi
    if $PLAN_INCLUDE; then
        newvhost="$(remote "cat '${VHOST_AVAILABLE}'" | insert_include "$BS_INCLUDE" "$DOMAIN")" \
            || { log_error "No unique HTTPS server block in ${VHOST_AVAILABLE}; add the include by hand."; restore_nginx "$backup" "$BS_SNIPPET_UNDO" false; return 1; }
        printf '%s\n' "$newvhost" | remote "cat > '${VHOST_AVAILABLE}.backstage-new' && chmod 0644 '${VHOST_AVAILABLE}.backstage-new' && mv '${VHOST_AVAILABLE}.backstage-new' '${VHOST_AVAILABLE}'" \
            || { log_error "Could not write ${VHOST_AVAILABLE}."; restore_nginx "$backup" "$BS_SNIPPET_UNDO" false; return 1; }
    fi

    if ! remote "nginx -t" 2>&1; then
        log_error "nginx -t failed with the Backstage include. Restoring; nginx was NOT reloaded."
        restore_nginx "$backup" "$BS_SNIPPET_UNDO" false
        return 1
    fi
    # Set BEFORE the reload: an interruption mid-reload must still trigger a restoring reload.
    BS_RELOADED=true
    remote "systemctl reload nginx" \
        || { log_error "nginx -t passed but the reload failed."; restore_nginx "$backup" "$BS_SNIPPET_UNDO" true; return 1; }
    log_success "nginx validated and reloaded"

    after="$(backstage_probe_neighbours "$SERVER_HOST" "${neighbours[@]}")" || after=""
    printf '%s\n' "$after" | sed '/^$/d; s/^/    after:  /'
    if ! changed="$(neighbour_status_changes "$before" "$after")"; then
        printf '%s\n' "$changed" | sed 's/^/    CHANGED: /' >&2
        log_error "A co-tenant's status changed after the reload. Restoring the vhost."
        restore_nginx "$backup" "$BS_SNIPPET_UNDO" true
        return 1
    fi
    log_success "All ${#neighbours[@]} co-tenant(s) unchanged"
    if ! verify_auth_gate "$PLAN_GATE"; then
        log_error "The ${PLAN_GATE} gate did not verify. Restoring the vhost and snippet."
        restore_nginx "$backup" "$BS_SNIPPET_UNDO" true
        return 1
    fi
    BS_PENDING_BACKUP=""
    return 0
}

# verify_auth_gate - step 5. Probes pinned to the host just changed; every transfer must complete
# (curl exit 0) as well as return the expected status. Without credentials both Backstage routes
# must answer 401 (auth runs before the proxy, so even with no release). With
# BACKSTAGE_CURL_CONFIG the answer must prove the request got PAST auth to the upstream: 200 from
# a running release, or 502 (nginx could not connect) only while no release runs. 403/500 are
# what nginx's auth handler itself returns for a missing or unreadable htpasswd: never accepted.
# The credentials stay in the curl config file (backstage_curl).
verify_auth_gate() {
    if [[ "$1" == session ]]; then
        export BACKSTAGE_GATE=session
        local release=yes
        if [[ "$PLAN_RELEASE" == none ]]; then release=none; fi
        backstage_session_reset || return 1
        verify_live "" "" no "$release" backstage yes session
        return $?
    fi
    local path code rc want state good=true err
    state="$(remote "if systemctl is-active --quiet '${BS_SERVICE}'; then echo active; else echo inactive; fi")" || state=""
    case "$state" in
        active) want=200 ;;
        inactive) want=502 ;;
        *) log_error "Could not read whether ${BS_SERVICE} is running; cannot judge the authenticated probe."; return 1 ;;
    esac
    err="$(mktemp)" || return 1
    for path in /backstage/ /api/backstage/health; do
        rc=0; code="$(curl -q -sS -o /dev/null -w '%{http_code}' --max-time 10 ${CURL_PIN} "${HEALTH_URL}${path}" 2>"$err")" || rc=$?
        if [[ "$rc" -eq 0 && "$code" == 401 ]]; then
            log_success "unauthenticated GET ${path}: 401"
        else
            log_error "unauthenticated GET ${path}: ${code:-none} (curl exit ${rc}: $(head -c 200 "$err")), expected 401 before the proxy."; good=false
        fi
        rc=0; code="$(backstage_curl -sS -o /dev/null -w '%{http_code}' --max-time 10 ${CURL_PIN} "${HEALTH_URL}${path}" 2>"$err")" || rc=$?
        if [[ "$rc" -eq 0 && "$code" == "$want" ]]; then
            log_success "authenticated GET ${path}: ${code} (reached the upstream; ${BS_SERVICE} ${state})"
        else
            log_error "authenticated GET ${path} with BACKSTAGE_CURL_CONFIG: ${code:-none} (curl exit ${rc}: $(head -c 200 "$err")), expected ${want} with ${BS_SERVICE} ${state}. 401: credentials do not match ${BS_HTPASSWD}; 403/500: nginx cannot use ${BS_HTPASSWD}."; good=false
        fi
    done
    rm -f "$err"
    $good
}

# setup_on_exit - EXIT trap while the lock is held. An interruption between the vhost backup and
# the auth check leaves BS_PENDING_BACKUP set: restore it before releasing the lock, so an
# unvalidated include never survives to make the next run report "already complete".
BS_PENDING_BACKUP=""
BS_RELOADED=false
BS_SNIPPET_UNDO=none
setup_on_exit() {
    if [[ -n "$BS_PENDING_BACKUP" ]]; then
        log_error "Interrupted mid nginx change; restoring the vhost."
        restore_nginx "$BS_PENDING_BACKUP" "$BS_SNIPPET_UNDO" "$BS_RELOADED"
    fi
    remote "rmdir '${BS_LOCK}'" || log_error "Could not release ${BS_LOCK}; inspect it before retrying."
}

setup_main() {
    local dry_run=false arg probe current
    for arg in "$@"; do
        case "$arg" in
            --dry-run) dry_run=true ;;
            *) echo "usage: ./.deploy/backstage-setup.sh [--dry-run]" >&2; return 2 ;;
        esac
    done

    [[ -f "$SSH_KEY" ]] || { log_error "SSH key not found: ${SSH_KEY}"; return 1; }
    remote 'echo ok' >/dev/null 2>&1 \
        || { log_error "Cannot SSH to ${SERVER}. Check user, key and IP, then stop. Do NOT power-cycle, rebuild, or reset credentials."; return 1; }

    probe="$(setup_probe)" || { log_error "Read-only probe failed; nothing changed."; return 1; }
    setup_plan "$probe" || { log_error "Refusing setup; nothing changed."; return 1; }
    if [[ "$PLAN_GATE" == session && "$PLAN_RELEASE" == none ]]; then
        echo 'note: operators.json must exist before the first deploy'
    fi
    if ! $PLAN_INCLUDE; then
        remote "cat '${VHOST_AVAILABLE}'" | include_placed "$BS_INCLUDE" "$DOMAIN" \
            || { log_error "The Backstage include is in ${VHOST_AVAILABLE} but not exactly once inside the HTTPS server block for ${DOMAIN}. Inspect by hand; nothing changed."; return 1; }
    fi
    if plan_is_empty; then
        log_success "Backstage setup already complete (user, namespace journal, unit enabled, snippet, include). No changes."
        return 0
    fi

    print_plan
    # Validate the vhost edit before ANY change, so an unusable vhost never leaves a half setup.
    if $PLAN_INCLUDE; then
        current="$(remote "cat '${VHOST_AVAILABLE}'")" || { log_error "Could not read ${VHOST_AVAILABLE}."; return 1; }
        printf '%s\n' "$current" | insert_include "$BS_INCLUDE" "$DOMAIN" >/dev/null \
            || { log_error "${VHOST_AVAILABLE} has no single HTTPS server block for ${DOMAIN}; refusing, nothing changed."; return 1; }
    fi
    # Step 5 verifies the gate with the operator's credentials, so a real nginx change needs them.
    if $PLAN_SNIPPET || $PLAN_INCLUDE; then
        if ! backstage_require_curl_config "$PLAN_GATE"; then
            if $dry_run; then
                log_warn "BACKSTAGE_CURL_CONFIG is not usable; the real run will refuse until it is set (docs/backstage-deploy.md)."
            else
                log_error "Refusing setup; nothing changed."; return 1
            fi
        fi
    fi
    if $dry_run; then
        if $PLAN_INCLUDE; then
            echo "  vhost diff (${VHOST_AVAILABLE}):"
            diff -u <(printf '%s\n' "$current") <(printf '%s\n' "$current" | insert_include "$BS_INCLUDE" "$DOMAIN") \
                | sed '1,2d; s/^/    /'
        fi
        if $PLAN_SNIPPET_UPDATE; then
            echo "  snippet diff (${BS_SNIPPET}):"
            diff -u <(remote "cat '${BS_SNIPPET}'") "$BS_SNIPPET_SRC" | sed '1,2d; s/^/    /'
        fi
        log_info "Dry run complete. Nothing was changed."
        return 0
    fi

    remote "mkdir '${BS_LOCK}'" || { log_error "Another Backstage setup or deploy holds ${BS_LOCK}; inspect it before retrying."; return 1; }
    trap setup_on_exit EXIT
    trap 'exit 130' INT TERM HUP
    # Re-plan under the lock: the host may have changed since the first probe.
    probe="$(setup_probe)" || { log_error "Probe under the lock failed; nothing changed."; return 1; }
    setup_plan "$probe" || { log_error "Refusing setup; nothing changed."; return 1; }

    if $PLAN_USER; then
        remote "useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin '${BS_USER}'" \
            || { log_error "Could not create user ${BS_USER}."; return 1; }
        log_success "User ${BS_USER} created"
    fi
    if $PLAN_JOURNAL; then
        remote "cat > '${BS_JOURNAL}.tmp' && chmod 0644 '${BS_JOURNAL}.tmp' && mv '${BS_JOURNAL}.tmp' '${BS_JOURNAL}'" < "$BS_JOURNAL_SRC" \
            || { log_error "Could not install ${BS_JOURNAL}."; return 1; }
        log_success "Namespace journal ${BS_JOURNAL} installed"
    fi
    if $PLAN_UNIT; then
        remote "cat > '${BS_UNIT}.tmp' && chmod 0644 '${BS_UNIT}.tmp' && mv '${BS_UNIT}.tmp' '${BS_UNIT}'" < "$BS_UNIT_SRC" \
            || { log_error "Could not install ${BS_UNIT}."; return 1; }
        remote "systemctl daemon-reload" || { log_error "systemctl daemon-reload failed."; return 1; }
        log_success "Unit ${BS_UNIT} installed"
    fi
    if $PLAN_ENABLE; then
        remote "systemctl enable '${BS_SERVICE}'" || { log_error "systemctl enable ${BS_SERVICE} failed."; return 1; }
        log_success "${BS_SERVICE} enabled (it starts with the first release)"
    fi
    if $PLAN_SNIPPET || $PLAN_INCLUDE; then
        apply_nginx || return 1
    fi

    probe="$(setup_probe)" || { log_error "Final probe failed; inspect the host."; return 1; }
    { setup_plan "$probe" && plan_is_empty \
        && remote "cat '${VHOST_AVAILABLE}'" | include_placed "$BS_INCLUDE" "$DOMAIN"; } \
        || { log_error "Setup ran but the host is not fully configured; inspect it."; return 1; }
    log_success "Backstage setup complete. Next: ./.deploy/ship.sh --module backstage --dry-run"
    return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    set -uo pipefail
    setup_main "$@"
    exit $?
fi
