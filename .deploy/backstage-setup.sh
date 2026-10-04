#!/usr/bin/env bash
#
# backstage-setup.sh - ONE-TIME Backstage setup on the shared host, idempotent.
# Encodes docs/backstage-deploy.md "One-time setup" steps 1-4; step 5 is the deploy itself.
#
#   1. probe: Linux x86_64, /usr/local/bin/bun runs, port 3456 free (or held by our own service),
#      the vhost is installed and enabled as a link, and what is already configured
#   2. service user jevnotjev-backstage (system, no login) if absent; unit installed if absent,
#      daemon-reload, enable. Never started here: no release exists yet.
#   3. snippet installed if absent; the include inserted ONLY if absent, inside the domain's
#      HTTPS server block, after a timestamped backup of the installed vhost. The vhost is never
#      replaced by the repo template (certbot owns its TLS lines, see provision.sh).
#   4. nginx -t before the reload, `systemctl reload nginx` never restart, co-tenants probed
#      before and after. nginx -t failure: restore, no reload. Changed co-tenant: restore,
#      nginx -t, reload again.
#
# Installs only what is absent. An installed unit or snippet that differs from the repo is
# reported and left alone. The funded-trial secret file is outside this script's scope.
#
# Usage:
#   ./.deploy/backstage-setup.sh --dry-run   read-only probes, print planned commands + vhost diff
#   ./.deploy/backstage-setup.sh             apply what is absent
# Bash 3.2 compatible. Sourcing this file defines functions only; the tests drive them.

SETUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SETUP_DIR}/config.sh"
# shellcheck source=/dev/null
source "${SETUP_DIR}/lib.sh"
# shellcheck source=/dev/null
source "${SETUP_DIR}/backstage-lib.sh"

readonly BS_SERVICE="jevnotjev-backstage"
readonly BS_USER="jevnotjev-backstage"
readonly BS_UNIT_SRC="${SETUP_DIR}/backstage.service"
readonly BS_SNIPPET_SRC="${SETUP_DIR}/backstage-nginx.conf"
readonly BS_UNIT="/etc/systemd/system/${BS_SERVICE}.service"
readonly BS_SNIPPET="/etc/nginx/snippets/jevnotjev-backstage.conf"
readonly BS_INCLUDE="include ${BS_SNIPPET};"
readonly BS_BUN="/usr/local/bin/bun"
readonly BS_PORT="3456"
readonly BS_BACKUP_DIR="/var/backups/jevnotjev-backstage"
# Same lock backstage-deploy.sh takes, so a setup and a deploy never overlap.
readonly BS_LOCK="/var/lock/jevnotjev-backstage-deploy"

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
    remote "U='${BS_UNIT}' S='${BS_SNIPPET}' I='${BS_INCLUDE}' V='${VHOST_AVAILABLE}' E='${VHOST_ENABLED}' B='${BS_BUN}' P='${BS_PORT}' N='${BS_USER}'
echo \"arch=\$(uname -m)\"
if [ ! -x \"\$B\" ]; then echo bun=absent; elif v=\$(\"\$B\" --version 2>/dev/null) && [ -n \"\$v\" ]; then echo \"bun=\$v\"; else echo bun=broken; fi
if id -u \"\$N\" >/dev/null 2>&1; then echo user=present; else echo user=absent; fi
if ! l=\$(ss -Hltn \"sport = :\$P\" 2>/dev/null); then echo port=unknown; elif [ -n \"\$l\" ]; then echo port=used; else echo port=free; fi
if [ -f \"\$U\" ]; then echo \"unit=\$(sha256sum \"\$U\" | cut -d' ' -f1)\"; else echo unit=absent; fi
if [ -f \"\$S\" ]; then echo \"snippet=\$(sha256sum \"\$S\" | cut -d' ' -f1)\"; else echo snippet=absent; fi
if [ -f \"\$V\" ]; then echo vhost=present; else echo vhost=absent; fi
if [ -L \"\$E\" ] && [ \"\$(readlink \"\$E\")\" = \"\$V\" ]; then echo vhost_link=yes; else echo vhost_link=no; fi
if sed 's/#.*//' \"\$V\" 2>/dev/null | grep -qF \"\$I\"; then echo include=present; else echo include=absent; fi
if [ \"\$(systemctl is-enabled \"\$N\" 2>/dev/null)\" = enabled ]; then echo enabled=yes; else echo enabled=no; fi
if systemctl is-active --quiet \"\$N\" 2>/dev/null; then echo active=yes; else echo active=no; fi"
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

    PLAN_USER=false; PLAN_UNIT=false; PLAN_ENABLE=false; PLAN_SNIPPET=false; PLAN_INCLUDE=false
    [[ "$(probe_get "$probe" user)" == present ]] || PLAN_USER=true
    v="$(probe_get "$probe" unit)"
    if [[ "$v" == absent ]]; then
        PLAN_UNIT=true
    elif [[ "$v" != "$(local_sha "$BS_UNIT_SRC")" ]]; then
        log_error "Installed ${BS_UNIT} differs from .deploy/backstage.service. Not overwriting; review the difference by hand."; return 1
    fi
    [[ "$(probe_get "$probe" enabled)" == yes ]] || PLAN_ENABLE=true
    v="$(probe_get "$probe" snippet)"
    if [[ "$v" == absent ]]; then
        PLAN_SNIPPET=true
    elif [[ "$v" != "$(local_sha "$BS_SNIPPET_SRC")" ]]; then
        log_error "Installed ${BS_SNIPPET} differs from .deploy/backstage-nginx.conf. Not overwriting; review the difference by hand."; return 1
    fi
    [[ "$(probe_get "$probe" include)" == present ]] || PLAN_INCLUDE=true
    return 0
}

plan_is_empty() { ! $PLAN_USER && ! $PLAN_UNIT && ! $PLAN_ENABLE && ! $PLAN_SNIPPET && ! $PLAN_INCLUDE; }

# print_plan - the remote commands a real run issues, in order.
print_plan() {
    local p="  ${YELLOW}[plan]${NC}"
    $PLAN_USER   && echo "$p useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ${BS_USER}"
    $PLAN_UNIT   && echo "$p cat > ${BS_UNIT}.tmp < .deploy/backstage.service, mv into place, systemctl daemon-reload"
    $PLAN_ENABLE && echo "$p systemctl enable ${BS_SERVICE}   (not started: no release yet)"
    if $PLAN_SNIPPET || $PLAN_INCLUDE; then
        echo "$p probe every co-tenant in /etc/nginx/sites-enabled (baseline)"
        echo "$p cp -p ${VHOST_AVAILABLE} ${BS_BACKUP_DIR}/${DOMAIN}.<UTC>"
        $PLAN_SNIPPET && echo "$p cat > ${BS_SNIPPET}.tmp < .deploy/backstage-nginx.conf, mv into place"
        $PLAN_INCLUDE && echo "$p insert '${BS_INCLUDE}' into the HTTPS server block of ${VHOST_AVAILABLE}"
        echo "$p nginx -t   (failure: restore the backup, no reload)"
        echo "$p systemctl reload nginx   (never restart)"
        echo "$p re-probe co-tenants   (changed: restore the backup, nginx -t, systemctl reload nginx)"
    fi
    return 0
}

# restore_nginx - put the saved vhost back and remove a snippet this run created. Reloads only
# when this run already reloaded, and only after the restored config passes nginx -t.
restore_nginx() {
    local backup="$1" snippet_new="$2" reloaded="$3"
    log_warn "Restoring ${VHOST_AVAILABLE} from ${backup}"
    if ! remote "cp -p '${backup}' '${VHOST_AVAILABLE}'"; then
        # Keep the snippet the live vhost may still include; nginx stays as last validated.
        log_error "RESTORE FAILED: copy ${backup} over ${VHOST_AVAILABLE} by hand, then nginx -t and reload."
        BS_PENDING_BACKUP=""
        return 1
    fi
    BS_PENDING_BACKUP=""
    if $snippet_new; then
        remote "rm -f '${BS_SNIPPET}'" || log_error "Could not remove ${BS_SNIPPET}."
    fi
    if remote "nginx -t" 2>&1; then
        if $reloaded; then
            remote "systemctl reload nginx" || log_error "Reload after restore FAILED. Inspect nginx now."
        fi
    else
        log_error "The restored config fails nginx -t. Inspect nginx now; nothing was reloaded."
    fi
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
    BS_PENDING_BACKUP="$backup"; BS_RELOADED=false

    if $PLAN_SNIPPET; then
        remote "mkdir -p '$(dirname "$BS_SNIPPET")' && cat > '${BS_SNIPPET}.tmp' && chmod 0644 '${BS_SNIPPET}.tmp' && mv '${BS_SNIPPET}.tmp' '${BS_SNIPPET}'" < "$BS_SNIPPET_SRC" \
            || { log_error "Could not install ${BS_SNIPPET}."; restore_nginx "$backup" true false; return 1; }
    fi
    if $PLAN_INCLUDE; then
        newvhost="$(remote "cat '${VHOST_AVAILABLE}'" | insert_include "$BS_INCLUDE" "$DOMAIN")" \
            || { log_error "No unique HTTPS server block in ${VHOST_AVAILABLE}; add the include by hand."; restore_nginx "$backup" "$PLAN_SNIPPET" false; return 1; }
        printf '%s\n' "$newvhost" | remote "cat > '${VHOST_AVAILABLE}.backstage-new' && chmod 0644 '${VHOST_AVAILABLE}.backstage-new' && mv '${VHOST_AVAILABLE}.backstage-new' '${VHOST_AVAILABLE}'" \
            || { log_error "Could not write ${VHOST_AVAILABLE}."; restore_nginx "$backup" "$PLAN_SNIPPET" false; return 1; }
    fi

    if ! remote "nginx -t" 2>&1; then
        log_error "nginx -t failed with the Backstage include. Restoring; nginx was NOT reloaded."
        restore_nginx "$backup" "$PLAN_SNIPPET" false
        return 1
    fi
    # Set BEFORE the reload: an interruption mid-reload must still trigger a restoring reload.
    BS_RELOADED=true
    remote "systemctl reload nginx" \
        || { log_error "nginx -t passed but the reload failed."; restore_nginx "$backup" "$PLAN_SNIPPET" true; return 1; }
    log_success "nginx validated and reloaded"

    after="$(backstage_probe_neighbours "$SERVER_HOST" "${neighbours[@]}")" || after=""
    printf '%s\n' "$after" | sed '/^$/d; s/^/    after:  /'
    if ! changed="$(neighbour_status_changes "$before" "$after")"; then
        printf '%s\n' "$changed" | sed 's/^/    CHANGED: /' >&2
        log_error "A co-tenant's status changed after the reload. Restoring the vhost."
        restore_nginx "$backup" "$PLAN_SNIPPET" true
        return 1
    fi
    BS_PENDING_BACKUP=""
    log_success "All ${#neighbours[@]} co-tenant(s) unchanged"
    return 0
}

# setup_on_exit - EXIT trap while the lock is held. An interruption between the vhost backup and
# the co-tenant check leaves BS_PENDING_BACKUP set: restore it before releasing the lock, so an
# unvalidated include never survives to make the next run report "already complete".
BS_PENDING_BACKUP=""
BS_RELOADED=false
setup_on_exit() {
    if [[ -n "$BS_PENDING_BACKUP" ]]; then
        log_error "Interrupted mid nginx change; restoring the vhost."
        restore_nginx "$BS_PENDING_BACKUP" "$PLAN_SNIPPET" "$BS_RELOADED"
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
    if ! $PLAN_INCLUDE; then
        remote "cat '${VHOST_AVAILABLE}'" | include_placed "$BS_INCLUDE" "$DOMAIN" \
            || { log_error "The Backstage include is in ${VHOST_AVAILABLE} but not exactly once inside the HTTPS server block for ${DOMAIN}. Inspect by hand; nothing changed."; return 1; }
    fi
    if plan_is_empty; then
        log_success "Backstage setup already complete (user, unit enabled, snippet, include). No changes."
        return 0
    fi

    print_plan
    # Validate the vhost edit before ANY change, so an unusable vhost never leaves a half setup.
    if $PLAN_INCLUDE; then
        current="$(remote "cat '${VHOST_AVAILABLE}'")" || { log_error "Could not read ${VHOST_AVAILABLE}."; return 1; }
        printf '%s\n' "$current" | insert_include "$BS_INCLUDE" "$DOMAIN" >/dev/null \
            || { log_error "${VHOST_AVAILABLE} has no single HTTPS server block for ${DOMAIN}; refusing, nothing changed."; return 1; }
    fi
    if $dry_run; then
        if $PLAN_INCLUDE; then
            echo "  vhost diff (${VHOST_AVAILABLE}):"
            diff -u <(printf '%s\n' "$current") <(printf '%s\n' "$current" | insert_include "$BS_INCLUDE" "$DOMAIN") \
                | sed '1,2d; s/^/    /'
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
