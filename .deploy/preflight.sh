#!/usr/bin/env bash
#
# preflight.sh - READ-ONLY audit of the deploy host for jevnotjev. Mutates nothing.
#
# Answers, from the box itself:
#   - is DEPLOY_PATH absent or already OUR symlink? (anything else is a BLOCKER: the first
#     swap would replace something this project did not create)
#   - is RELEASES_ROOT absent or ours?
#   - is the vhost installed, and does a cert exist for the domain?
#   - does the domain resolve to this host?
#   - which co-tenants does nginx serve right now, and what does each return?
#
# Usage: ./.deploy/preflight.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
source .deploy/config.sh
source .deploy/lib.sh

echo
log_info "Pre-flight audit of ${SERVER_HOST} for ${DOMAIN} (read-only)"
echo

[[ -f "$SSH_KEY" ]] || fail "SSH key not found: ${SSH_KEY}"
remote 'echo ok' >/dev/null 2>&1 \
    || fail "Cannot SSH to ${SERVER}. Check user, key and IP, then stop. Do NOT power-cycle, rebuild, or reset credentials to recover."
log_success "SSH works: $(remote 'hostname' 2>/dev/null)"

blockers=0
blocker() { log_error "BLOCKER: $1"; blockers=$((blockers+1)); }

echo
echo "================ SERVED PATH ================"
if state="$(deploy_path_state "$DEPLOY_PATH" "$RELEASES_ROOT")"; then
    log_success "${DEPLOY_PATH}: ${state}"
else
    blocker "${DEPLOY_PATH} is ${state} - not ABSENT and not a symlink into ${RELEASES_ROOT}. Refusing to plan a swap over it."
fi

rr="$(remote "if [ -d '${RELEASES_ROOT}' ]; then echo \"DIR \$(ls -1 '${RELEASES_ROOT}' | wc -l)\"; elif [ -e '${RELEASES_ROOT}' ]; then echo FOREIGN; else echo ABSENT; fi" 2>/dev/null | tr -s '[:space:]' ' ' | sed 's/ $//')"
case "$rr" in
    ABSENT)  log_success "${RELEASES_ROOT}: ABSENT (first deploy creates it)" ;;
    DIR*)    log_info "${RELEASES_ROOT}: exists, ${rr#DIR } release(s)" ;;
    *)       blocker "${RELEASES_ROOT} is '${rr:-<unknown>}', not a directory we can use" ;;
esac

echo
echo "================ VHOST + TLS ================"
remote "
[ -e '${VHOST_AVAILABLE}' ] && echo 'VHOST sites-available: INSTALLED' || echo 'VHOST sites-available: absent (run provision.sh)'
[ -L '${VHOST_ENABLED}' ] && echo 'VHOST sites-enabled:   ENABLED' || echo 'VHOST sites-enabled:   absent'
[ -d '/etc/letsencrypt/live/${DOMAIN}' ] && echo 'CERT ${DOMAIN}: PRESENT' || echo 'CERT ${DOMAIN}: absent (provision.sh issues it)'
echo '--- nginx -t ---'; nginx -t 2>&1
"

resolved="$( (dig +short "$DOMAIN" 2>/dev/null || true) | tail -1)"
if [[ "$resolved" == "$SERVER_HOST" ]]; then
    log_success "DNS ${DOMAIN} -> ${resolved}"
else
    blocker "DNS ${DOMAIN} resolves to '${resolved:-<nothing>}', not ${SERVER_HOST}. certbot HTTP-01 would fail."
fi

echo
echo "================ CO-TENANTS (from sites-enabled) ================"
neighbours=()
while IFS= read -r n; do
    [[ -n "$n" ]] && neighbours+=("$n")
done < <(list_neighbours "$DOMAIN")
if [[ "${#neighbours[@]}" -eq 0 ]]; then
    blocker "No co-tenant server_name could be read from /etc/nginx/sites-enabled. deploy.sh refuses to run blind."
else
    probe_neighbours "$SERVER_HOST" "${neighbours[@]}" | sed 's/^/    /'
fi

echo
if [[ "$blockers" -gt 0 ]]; then
    log_error "Pre-flight failed with ${blockers} blocking condition(s)."
    exit 1
fi
log_success "Pre-flight passed with no blocking conditions."
