#!/usr/bin/env bash
#
# provision.sh - ONE-TIME vhost + TLS setup for jevnotjev.breakoutwithai.com on a shared host.
#
# Installs ONLY this domain's vhost and ONLY this domain's certificate:
#   1. copy .deploy/nginx-jevnotjev.conf to sites-available/<domain>, symlink into sites-enabled
#   2. nginx -t; on failure remove both files again and stop; on success `systemctl reload nginx`
#      (reload, NEVER restart: a restart drops live connections for every co-tenant)
#   3. certbot --nginx -d <domain> --non-interactive: issues its OWN cert. Never --expand a cert
#      that serves another site.
#   4. every co-tenant server_name is probed before and after; any status change removes our
#      sites-enabled link again, reloads, and fails.
#
# Idempotent: an installed vhost is never overwritten (certbot has rewritten it by then), and an
# existing cert is not re-issued. Host packages (nginx, certbot) are NOT installed here; the host
# was built by lakelife's provision.sh.
#
# Env:
#   CERTBOT_EMAIL   REQUIRED when a certificate must be issued. No default: the address the
#                   host's ACME account uses is not recorded anywhere this repo can read.
#
# Usage:
#   CERTBOT_EMAIL=you@example.com ./.deploy/provision.sh
#   ./.deploy/provision.sh --dry-run
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
source .deploy/config.sh
source .deploy/lib.sh

DRY_RUN=false
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        *) echo "usage: ./.deploy/provision.sh [--dry-run]" >&2; exit 2 ;;
    esac
done

run() {
    if $DRY_RUN; then echo "  ${YELLOW}[dry-run]${NC} $*"; else eval "$@"; fi
}

# ------------------------------------------------------------------ preflight
[[ -f "$VHOST_SRC" ]] || fail "Missing ${VHOST_SRC}"
grep -Eq "^[[:space:]]*server_name[[:space:]]+${DOMAIN};" "$VHOST_SRC" \
    || fail "${VHOST_SRC} does not declare server_name ${DOMAIN}; refusing to install it under that name."

[[ -f "$SSH_KEY" ]] || fail "SSH key not found: ${SSH_KEY}"
remote 'echo ok' >/dev/null 2>&1 \
    || fail "Cannot SSH to ${SERVER}. Check user, key and IP, then stop. Do NOT power-cycle, rebuild, or password-reset."
log_success "SSH works"

resolved="$( (dig +short "$DOMAIN" 2>/dev/null || true) | tail -1)"
[[ "$resolved" == "$SERVER_HOST" ]] \
    || fail "DNS ${DOMAIN} resolves to '${resolved:-<nothing>}', not ${SERVER_HOST}. certbot HTTP-01 would fail; fix DNS first."
log_success "DNS ${DOMAIN} -> ${resolved}"

vhost_state="$(remote "[ -e '${VHOST_AVAILABLE}' ] && echo INSTALLED || echo ABSENT" 2>/dev/null | tr -d '[:space:]')"
cert_state="$(remote "[ -d '/etc/letsencrypt/live/${DOMAIN}' ] && echo PRESENT || echo ABSENT" 2>/dev/null | tr -d '[:space:]')"
case "$vhost_state" in INSTALLED|ABSENT) : ;; *) fail "Could not probe ${VHOST_AVAILABLE} (got '${vhost_state}')." ;; esac
case "$cert_state"  in PRESENT|ABSENT)   : ;; *) fail "Could not probe the certificate (got '${cert_state}')." ;; esac
log_info "vhost: ${vhost_state}   cert: ${cert_state}"

if [[ "$cert_state" == "ABSENT" && -z "${CERTBOT_EMAIL:-}" ]]; then
    if $DRY_RUN; then
        log_warn "CERTBOT_EMAIL is not set. A real run would REFUSE here: a certificate must be issued and needs an ACME contact."
    else
        fail "CERTBOT_EMAIL is not set and ${DOMAIN} has no certificate. Set CERTBOT_EMAIL=<address> and re-run."
    fi
fi

# Co-tenant baseline, read from the box.
neighbours=()
while IFS= read -r n; do
    [[ -n "$n" ]] && neighbours+=("$n")
done < <(list_neighbours "$DOMAIN")
[[ "${#neighbours[@]}" -gt 0 ]] || fail "Could not enumerate co-tenants from /etc/nginx/sites-enabled. Refusing to change nginx blind."
log_info "Co-tenants: ${neighbours[*]}"
before="$(probe_neighbours "$SERVER_HOST" "${neighbours[@]}")"
printf '%s\n' "$before" | sed 's/^/    before: /'

# Put nginx back exactly as it was before this script touched it.
undo_vhost() {
    log_warn "Removing ${VHOST_ENABLED} and reloading nginx to restore the previous config..."
    remote "rm -f '${VHOST_ENABLED}' && nginx -t && systemctl reload nginx" \
        || log_error "Undo FAILED. Check nginx on the box by hand: nginx -t; ls -la /etc/nginx/sites-enabled/"
}

# --------------------------------------------------------------- 1. vhost
if [[ "$vhost_state" == "INSTALLED" ]]; then
    log_info "Stage 1/2: ${VHOST_AVAILABLE} already installed - NOT overwriting (certbot rewrites the live file)."
else
    log_info "Stage 1/2: installing ${VHOST_AVAILABLE}"
    if $DRY_RUN; then
        echo "  ${YELLOW}[dry-run]${NC} remote 'cat > ${VHOST_AVAILABLE}.tmp' < ${VHOST_SRC} && mv into place"
        echo "  ${YELLOW}[dry-run]${NC} remote 'ln -s ${VHOST_AVAILABLE} ${VHOST_ENABLED}'"
        echo "  ${YELLOW}[dry-run]${NC} remote 'nginx -t' (on failure: remove both files, stop)"
        echo "  ${YELLOW}[dry-run]${NC} remote 'systemctl reload nginx'"
    else
        remote "cat > '${VHOST_AVAILABLE}.tmp' && mv '${VHOST_AVAILABLE}.tmp' '${VHOST_AVAILABLE}'" < "$VHOST_SRC" \
            || fail "Could not write ${VHOST_AVAILABLE}."
        remote "[ -e '${VHOST_ENABLED}' ] || ln -s '${VHOST_AVAILABLE}' '${VHOST_ENABLED}'" \
            || fail "Could not enable ${VHOST_ENABLED}."
        if ! remote 'nginx -t' 2>&1; then
            remote "rm -f '${VHOST_ENABLED}' '${VHOST_AVAILABLE}'" || true
            fail "nginx -t failed with the new vhost. Both files removed; nginx was NOT reloaded."
        fi
        remote 'systemctl reload nginx' || fail "nginx -t passed but reload failed. Check the box."
        log_success "vhost installed and nginx reloaded"
    fi
fi

# --------------------------------------------------------------- 2. certificate
if [[ "$cert_state" == "PRESENT" ]]; then
    log_info "Stage 2/2: certificate for ${DOMAIN} already present - not re-issuing."
else
    certbot_cmd="certbot --nginx -d ${DOMAIN} --non-interactive --agree-tos -m '${CERTBOT_EMAIL:-<CERTBOT_EMAIL>}' --redirect --keep-until-expiring"
    log_info "Stage 2/2: issuing a certificate for ${DOMAIN} only"
    run "remote \"${certbot_cmd}\"" || { $DRY_RUN || undo_vhost; fail "certbot failed. Our vhost was disabled again."; }
    run "remote 'nginx -t'"
fi

# --------------------------------------------------------------- verify
if $DRY_RUN; then
    echo "  ${YELLOW}[dry-run]${NC} re-probe every co-tenant; any status change -> remove ${VHOST_ENABLED}, reload, fail"
    echo; log_info "Dry run complete. Nothing was changed."
    exit 0
fi

after="$(probe_neighbours "$SERVER_HOST" "${neighbours[@]}")"
printf '%s\n' "$after" | sed 's/^/    after:  /'
if ! changed="$(neighbour_status_changes "$before" "$after")"; then
    printf '%s\n' "$changed" | sed 's/^/    CHANGED: /' >&2
    undo_vhost
    fail "A co-tenant's status changed after installing ${DOMAIN}. Our vhost was disabled again."
fi
log_success "All ${#neighbours[@]} co-tenant(s) unchanged"

code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 ${CURL_PIN} "${HEALTH_URL}/" 2>/dev/null || true)"
log_info "${HEALTH_URL}/ -> ${code:-000} (404 is expected until the first ./.deploy/deploy.sh)"
log_success "Provisioned ${DOMAIN}. Next: deploy from a clean worktree at origin/main."
