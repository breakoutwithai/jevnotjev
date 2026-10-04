#!/usr/bin/env bash
#
# ship.sh - the one deploy entrypoint for every jevnotjev module.
#
# A dispatcher only. Each module keeps its own release, verify and rollback logic:
#   static     .deploy/deploy.sh             (site/ release swap; vhost + TLS via provision.sh)
#   backstage  .deploy/backstage-deploy.sh   (paired API + browser release; setup via backstage-setup.sh)
#
# Rules:
#   - `--module all` (the default) runs static first, then backstage. A static failure stops
#     before backstage. A backstage failure never touches the verified static release.
#   - The exit code is the first failing module's own exit code (0 when all passed). Nothing
#     runs after a module that could replace its status.
#   - `--dry-run` is passed to every module script; `--status` is read-only.
#
# Bash 3.2 compatible.
set -uo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
    cat <<'EOF'
Usage: .deploy/ship.sh [--module static|backstage|all] [ACTION] [--dry-run]

  --module static|backstage|all   module to act on (default: all = static, then backstage)
  --dry-run                       print what would happen; every module script runs with --dry-run
  ACTION (one, default deploy):
    (none)                        deploy: static via deploy.sh, backstage via backstage-deploy.sh
    --status                      read-only: served SHA, current release, verified marker,
                                  service state, setup present (per module)
    --setup                       one-time setup: static = provision.sh (vhost + TLS),
                                  backstage = backstage-setup.sh (user, unit, nginx include)
    --rollback [SHA]              per module, never with all:
                                  static: previous verified release (no SHA)
                                  backstage: --rollback <full 40-char verified SHA>
  -h, --help                      this text

Go live:  --status, --setup --dry-run, --setup, --dry-run, then the deploy itself.
EOF
}

usage_error() { echo "ship.sh: $1" >&2; usage >&2; exit 2; }

MODULE="all"
ACTION=""
DRY_RUN=false
ROLLBACK_SHA=""

set_action() {
    [[ -z "$ACTION" ]] || usage_error "choose one action; got --${ACTION} and --$1"
    ACTION="$1"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --module)
            [[ $# -ge 2 ]] || usage_error "--module needs static, backstage or all"
            MODULE="$2"; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        --status) set_action status; shift ;;
        --setup) set_action setup; shift ;;
        --rollback)
            set_action rollback
            if [[ $# -ge 2 && "$2" != --* ]]; then ROLLBACK_SHA="$2"; shift 2; else shift; fi ;;
        -h|--help) usage; exit 0 ;;
        *) usage_error "unknown argument: $1" ;;
    esac
done
ACTION="${ACTION:-deploy}"

case "$MODULE" in
    static|backstage|all) ;;
    *) usage_error "unknown module '${MODULE}'" ;;
esac

if [[ "$ACTION" == rollback ]]; then
    [[ "$MODULE" != all ]] || usage_error "--rollback is per module: add --module static or --module backstage"
    if [[ "$MODULE" == static && -n "$ROLLBACK_SHA" ]]; then
        usage_error "static --rollback takes no SHA: it selects the previous verified release"
    fi
    if [[ "$MODULE" == backstage && ! "$ROLLBACK_SHA" =~ ^[a-f0-9]{40}$ ]]; then
        usage_error "backstage --rollback needs the full 40-character SHA of a verified release"
    fi
fi

# ------------------------------------------------------------------ status (read-only)
status_static() {
    local probe served
    probe="$(remote "D='${DEPLOY_PATH}' V='${VHOST_AVAILABLE}' E='${VHOST_ENABLED}' C='/etc/letsencrypt/live/${DOMAIN}'
L=\$(readlink \"\$D\" 2>/dev/null || true)
echo \"release=\${L:-none}\"
if [ -n \"\$L\" ]; then echo \"marker=\$(cat \"\$L/DEPLOYED_SHA\" 2>/dev/null)\"; fi
if [ -n \"\$L\" ] && [ -f \"\$L/.verified\" ]; then echo verified=yes; else echo verified=no; fi
echo \"service=nginx \$(systemctl is-active nginx 2>/dev/null || true)\"
if [ -f \"\$V\" ] && [ \"\$(readlink \"\$E\" 2>/dev/null)\" = \"\$V\" ] && [ -d \"\$C\" ]; then echo setup=yes; else echo setup=no; fi")" || return 1
    served="$(curl -sS --fail --max-time 15 ${CURL_PIN} "${HEALTH_URL}/DEPLOYED_SHA" 2>/dev/null | tr -d '[:space:]' || true)"
    print_status static "${served:-none}" "$probe"
}

status_backstage() {
    local probe served
    probe="$(remote "C='/var/www/jevnotjev-backstage-current' U='/etc/systemd/system/jevnotjev-backstage.service' S='/etc/nginx/snippets/jevnotjev-backstage.conf' V='${VHOST_AVAILABLE}'
L=\$(readlink \"\$C\" 2>/dev/null || true)
echo \"release=\${L:-none}\"
if [ -n \"\$L\" ] && [ -f \"\$L/.verified\" ]; then echo verified=yes; else echo verified=no; fi
echo \"service=\$(systemctl is-active jevnotjev-backstage 2>/dev/null || true), \$(systemctl is-enabled jevnotjev-backstage 2>/dev/null || true)\"
if [ -f \"\$U\" ] && [ -f \"\$S\" ] && sed 's/#.*//' \"\$V\" 2>/dev/null | grep -qF \"include \$S;\"; then echo setup=yes; else echo setup=no; fi")" || return 1
    served="$(backstage_curl -sS --fail --max-time 15 ${CURL_PIN} "${HEALTH_URL}/api/backstage/health" 2>/dev/null \
        | bun -e 'const r=await Bun.stdin.json();if(typeof r?.version==="string")console.log(r.version)' 2>/dev/null || true)"
    print_status backstage "${served:-none}" "$probe"
}

print_status() {
    local name="$1" served="$2" probe="$3" key value
    echo "${name}"
    printf '  %-9s %s\n' served "$served"
    for key in release marker verified service setup; do
        value="$(printf '%s\n' "$probe" | sed -n "s/^${key}=//p" | head -1)"
        [[ -z "$value" ]] || printf '  %-9s %s\n' "$key" "$value"
    done
}

run_status() {
    # shellcheck source=/dev/null
    source "${DEPLOY_DIR}/config.sh"
    # shellcheck source=/dev/null
    source "${DEPLOY_DIR}/backstage-lib.sh"
    [[ -f "$SSH_KEY" ]] || { log_error "SSH key not found: ${SSH_KEY}"; return 1; }
    remote 'echo ok' >/dev/null 2>&1 || { log_error "Cannot SSH to ${SERVER}. Check user, key and IP, then stop."; return 1; }
    local rc=0
    if [[ "$MODULE" == static || "$MODULE" == all ]]; then status_static || { log_error "static status probe failed"; rc=1; }; fi
    if [[ "$MODULE" == backstage || "$MODULE" == all ]]; then status_backstage || { log_error "backstage status probe failed"; rc=1; }; fi
    return "$rc"
}

if [[ "$ACTION" == status ]]; then
    run_status
    exit $?
fi

# ------------------------------------------------------------------ dispatch
# Per-module script and arguments for this action.
module_script() {
    case "${ACTION}:$1" in
        deploy:static|rollback:static) echo deploy.sh ;;
        deploy:backstage|rollback:backstage) echo backstage-deploy.sh ;;
        setup:static) echo provision.sh ;;
        setup:backstage) echo backstage-setup.sh ;;
    esac
}

MODULES=(static backstage)
[[ "$MODULE" == all ]] || MODULES=("$MODULE")

RESULTS=""
FINAL_RC=0
for m in "${MODULES[@]}"; do
    if [[ "$FINAL_RC" -ne 0 ]]; then
        RESULTS="${RESULTS}  ${m}    SKIPPED (an earlier module failed)
"
        continue
    fi
    script="$(module_script "$m")"
    args=()
    if [[ "$ACTION" == rollback ]]; then
        args+=(--rollback)
        [[ -z "$ROLLBACK_SHA" ]] || args+=("$ROLLBACK_SHA")
    fi
    $DRY_RUN && args+=(--dry-run)
    echo "==> ${m}: .deploy/${script} ${args[*]+"${args[*]}"}"
    bash "${DEPLOY_DIR}/${script}" ${args[@]+"${args[@]}"}
    rc=$?
    if [[ "$rc" -eq 0 ]]; then
        RESULTS="${RESULTS}  ${m}    OK
"
    else
        RESULTS="${RESULTS}  ${m}    FAILED (rc=${rc})
"
        FINAL_RC="$rc"
    fi
done

echo
echo "ship.sh ${ACTION}$($DRY_RUN && echo ' (dry-run)'):"
printf '%s' "$RESULTS"
exit "$FINAL_RC"
