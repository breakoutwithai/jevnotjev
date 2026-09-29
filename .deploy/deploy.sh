#!/usr/bin/env bash
#
# deploy.sh - ship the committed `site/` folder to jevnotjev.breakoutwithai.com.
#
# Static site: no build, no process manager, no port, no secrets. nginx serves the release
# directory straight from disk. Forked from lakelife's `.deploy/deploy.sh` for the same host.
#
# DESIGN CONSTRAINTS:
#   1. SHIP ONLY WHAT MAIN HAS. Branch guard + HEAD == origin/main + clean tracked tree.
#   2. SHIP ONLY TRACKED FILES UNDER site/. The payload is `git archive HEAD:site`, checked
#      against `git ls-files site/` before anything remote is created.
#   3. TOUCH NOTHING SHARED. This script never edits or reloads nginx; the vhost is installed
#      once by provision.sh. A deploy is a new release directory plus a symlink swap.
#   4. PROVE EVERY NEIGHBOUR SURVIVED. The server_names in /etc/nginx/sites-enabled are read at
#      run time and each is probed (pinned to the box IP) before and after. Any status change
#      fails the deploy and the EXIT trap restores the previous release.
#   5. VERIFY THE SERVED SHA, not the HTTP status. A 200 can come from the old release.
#
# Usage:
#   ./.deploy/deploy.sh                        full deploy
#   ./.deploy/deploy.sh --dry-run              show what would happen, change nothing
#   ./.deploy/deploy.sh --rollback             on-box swap to the previous good release
#   ./.deploy/deploy.sh --rollback --dry-run   show what --rollback would do
set -euo pipefail

# BASH 3.2 IS A REQUIREMENT: on a stock Mac /usr/bin/env bash is /bin/bash 3.2.57.

cd "$(dirname "${BASH_SOURCE[0]}")/.."
source .deploy/config.sh
source .deploy/lib.sh

DRY_RUN=false
ROLLBACK=false
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        --rollback) ROLLBACK=true ;;
        # An unknown flag must never mean "proceed with a real deploy".
        *) echo "usage: ./.deploy/deploy.sh [--dry-run] [--rollback]" >&2; exit 2 ;;
    esac
done

# Deploy lock. mkdir is atomic on every POSIX filesystem; flock is used where it exists.
LOCK_FILE="${TMPDIR:-/tmp}/jevnotjev-deploy.lock"
exec 9>"$LOCK_FILE"
if command -v flock >/dev/null 2>&1; then
    flock -n 9 || { echo "another deploy is in progress (lock: ${LOCK_FILE})" >&2; exit 2; }
else
    if ! mkdir "${LOCK_FILE}.d" 2>/dev/null; then
        echo "another deploy is in progress (lock: ${LOCK_FILE}.d)" >&2; exit 2
    fi
fi
trap 'rmdir "${LOCK_FILE}.d" 2>/dev/null' EXIT

run() {
    if $DRY_RUN; then echo "  ${YELLOW}[dry-run]${NC} $*"; else eval "$@"; fi
}

# ------------------------------------------------------------------ preflight
log_info "Checking preconditions..."

git rev-parse --git-dir >/dev/null 2>&1 || fail "Not in a git repository"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
SHA="$(git rev-parse HEAD)"
SHORT_SHA="$(git rev-parse --short HEAD)"
log_info "Branch ${BRANCH} at ${SHORT_SHA}"

# Override deliberately with DEPLOY_ALLOW_BRANCH=<name>; the commit must still be pushed.
readonly ALLOWED_BRANCH="${DEPLOY_ALLOW_BRANCH:-main}"

# A DETACHED HEAD whose SHA is exactly origin/main satisfies the guard's intent - "ship only
# what main has" - more strictly than a branch name can. A clean throwaway worktree pinned to
# origin/main (the mandated deploy procedure) is always detached, and `--abbrev-ref` returns
# the literal "HEAD" for it, so resolve identity by commit before comparing names.
if [[ "$BRANCH" == "HEAD" ]]; then
    git fetch origin main --no-tags >/dev/null 2>&1 || true
    detached_main_sha="$(git rev-parse origin/main 2>/dev/null || true)"
    if [[ -n "$detached_main_sha" && "$SHA" == "$detached_main_sha" ]]; then
        log_info "Detached HEAD at origin/main (${SHORT_SHA}) - treating as '${ALLOWED_BRANCH}'."
        BRANCH="$ALLOWED_BRANCH"
    fi
fi

if [[ "$BRANCH" != "$ALLOWED_BRANCH" ]]; then
    fail "Refusing to deploy from '${BRANCH}'. Production deploys run from '${ALLOWED_BRANCH}'.
  Deploy from a clean worktree pinned to the remote:
      git fetch origin main --no-tags
      git worktree add --detach <dir> origin/main
      <dir>/.deploy/deploy.sh
  If this is deliberate: DEPLOY_ALLOW_BRANCH=${BRANCH} ./.deploy/deploy.sh"
fi

DRY_RUN_STR="false"; $DRY_RUN && DRY_RUN_STR="true"
verify_head_is_remote_main "$SHA" "$BRANCH" "$ALLOWED_BRANCH" "$DRY_RUN_STR" \
    || fail "Refusing to deploy: origin/main could not be verified against HEAD. See the error above."

# TRACKED modifications only: the payload comes from `git archive HEAD`, so an untracked file
# cannot ship, but a modified tracked file means the tree you tested is not what ships.
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    if $DRY_RUN; then
        log_warn "Uncommitted tracked changes present (dry-run, not blocking)."
    else
        fail "Uncommitted tracked changes present. Commit or stash first: the payload is HEAD, not the working tree."
    fi
fi

command -v tar  >/dev/null || fail "tar not installed"
command -v curl >/dev/null || fail "curl not installed"
[[ -f "$SSH_KEY" ]] || { $DRY_RUN && log_warn "SSH key not found: ${SSH_KEY} (dry-run, not blocking)" || fail "SSH key not found: ${SSH_KEY}"; }

if ! $DRY_RUN; then
    remote 'echo ok' >/dev/null 2>&1 \
        || fail "Cannot SSH to ${SERVER}. Run ./.deploy/preflight.sh. Do NOT power-cycle, rebuild, or reset credentials to recover."
    path_state="$(deploy_path_state "$DEPLOY_PATH" "$RELEASES_ROOT")" \
        || fail "${DEPLOY_PATH} on the box is ${path_state}, not ABSENT or a symlink into ${RELEASES_ROOT}. Refusing to swap over something this script did not create."
    log_info "${DEPLOY_PATH}: ${path_state}"
fi
log_success "Preconditions OK"

# ---------------------------------------------------------------- --rollback
if $ROLLBACK; then
    log_info "Rollback requested: selecting the newest release other than the active one..."
    if $DRY_RUN; then
        log_info "[dry-run] would: list ${RELEASES_ROOT}, pick the newest release with a DEPLOYED_SHA marker (excluding the active one), swap ${DEPLOY_PATH}, verify the served SHA."
        exit 0
    fi

    active_release="$(basename "$(live_release "$DEPLOY_PATH")" 2>/dev/null || true)"
    [[ -n "$active_release" ]] || fail "Cannot determine the active release on ${DEPLOY_PATH}. Refusing to guess a rollback target."

    candidate_releases=()
    while IFS= read -r rel_name; do
        [[ -n "$rel_name" ]] && candidate_releases+=("$rel_name")
    done < <(remote "ls -1dt ${RELEASES_ROOT}/*/ 2>/dev/null | xargs -n1 basename" 2>/dev/null)
    [[ "${#candidate_releases[@]}" -gt 0 ]] || fail "No releases found under ${RELEASES_ROOT}."

    has_marker() { release_is_verified "${RELEASES_ROOT}/${1}"; }
    target_release_name="$(select_rollback_target "$active_release" has_marker "${candidate_releases[@]}")" \
        || fail "No other release under ${RELEASES_ROOT} was verified by a completed deploy. Refusing to roll back to an unverifiable target."

    target_release_dir="${RELEASES_ROOT}/${target_release_name}"
    target_sha="$(remote "cat ${target_release_dir}/DEPLOYED_SHA 2>/dev/null || true" 2>/dev/null | tr -d '[:space:]')"
    log_info "Rolling back ${DEPLOY_PATH} from ${active_release} to ${target_release_name} (${target_sha:0:7})..."

    activate_release "$target_release_dir" "$DEPLOY_PATH" \
        || fail "Rollback swap failed. Check ${DEPLOY_PATH} by hand."

    served="$(curl -sS --fail --max-time 15 ${CURL_PIN} "${HEALTH_URL}/DEPLOYED_SHA" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ -n "$target_sha" && "$served" == "$target_sha" ]]; then
        log_success "Rolled back to ${target_release_name}, serving ${served:0:7} (verified)"
    else
        fail "Rollback swap ran but the site serves '${served:-<none>}', expected '${target_sha:-<none>}'. Investigate immediately."
    fi
    exit 0
fi

# ------------------------------------------------------------------ manifest
# The manifest is `git ls-files site/` and nothing else. The payload is `git archive HEAD:site`;
# the two lists must be identical or something other than the tracked site would ship.
MANIFEST="$(git ls-files -- "${SITE_DIR}/" | sed "s|^${SITE_DIR}/||" | LC_ALL=C sort)"
[[ -n "$MANIFEST" ]] || fail "git ls-files ${SITE_DIR}/ is empty - nothing to ship."
printf '%s\n' "$MANIFEST" | grep -qx 'index.html' || fail "${SITE_DIR}/index.html is not tracked - refusing to ship a site with no index."
ARCHIVE_LIST="$(git archive --format=tar "HEAD:${SITE_DIR}" | tar -tf - | grep -v '/$' | LC_ALL=C sort)"
[[ "$MANIFEST" == "$ARCHIVE_LIST" ]] || fail "git archive HEAD:${SITE_DIR} does not match git ls-files ${SITE_DIR}/ (tracked-but-uncommitted file?). Commit first."
MANIFEST_COUNT="$(printf '%s\n' "$MANIFEST" | wc -l | tr -d ' ')"
log_success "Manifest: ${MANIFEST_COUNT} tracked file(s) under ${SITE_DIR}/"
printf '%s\n' "$MANIFEST" | sed 's/^/    /'

# ---------------------------------------------------------- neighbour baseline
# Enumerate co-tenants from the box itself, never from a doc. Probed BEFORE anything changes.
NEIGHBOURS=()
NEIGHBOURS_BEFORE=""
if $DRY_RUN; then
    echo "  ${YELLOW}[dry-run]${NC} remote 'cat /etc/nginx/sites-enabled/*' | parse_server_names ${DOMAIN}, then curl each pinned to ${SERVER_HOST}"
else
    while IFS= read -r n; do
        [[ -n "$n" ]] && NEIGHBOURS+=("$n")
    done < <(list_neighbours "$DOMAIN")
    [[ "${#NEIGHBOURS[@]}" -gt 0 ]] \
        || fail "Could not enumerate any co-tenant server_name from /etc/nginx/sites-enabled. This host is shared; refusing to deploy blind."
    log_info "Co-tenants (from sites-enabled): ${NEIGHBOURS[*]}"
    NEIGHBOURS_BEFORE="$(probe_neighbours "$SERVER_HOST" "${NEIGHBOURS[@]}")"
    printf '%s\n' "$NEIGHBOURS_BEFORE" | sed 's/^/    before: /'
fi

# ---------------------------------------------------------------------- ship
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-${SHORT_SHA}"
RELEASE_DIR="${RELEASES_ROOT}/${RELEASE_ID}"

log_info "Shipping to ${SERVER}:${RELEASE_DIR}..."
run "remote 'mkdir -p ${RELEASE_DIR}'"
if $DRY_RUN; then
    echo "  ${YELLOW}[dry-run]${NC} git archive --format=tar HEAD:${SITE_DIR} | remote 'tar -x --no-same-owner -C ${RELEASE_DIR}'"
else
    git archive --format=tar "HEAD:${SITE_DIR}" | remote "tar -x --no-same-owner -C ${RELEASE_DIR}" \
        || fail "Upload into ${RELEASE_DIR} failed. Nothing has been activated."
fi
# The SHA stamp lives in the release root so /DEPLOYED_SHA proves WHICH release is served.
run "remote \"printf '%s\\n' '${SHA}' > ${RELEASE_DIR}/DEPLOYED_SHA && chmod -R a+rX ${RELEASE_DIR}\""

if ! $DRY_RUN; then
    shipped_count="$(remote "find ${RELEASE_DIR} -type f ! -name DEPLOYED_SHA | wc -l" 2>/dev/null | tr -d '[:space:]')"
    [[ "$shipped_count" == "$MANIFEST_COUNT" ]] \
        || fail "Release holds ${shipped_count:-?} file(s), manifest has ${MANIFEST_COUNT}. Nothing has been activated."
    log_success "Release staged: ${shipped_count} file(s) + DEPLOYED_SHA"
fi

# ------------------------------------------------------------------ activate
# Capture what is served BEFORE the swap: it is the rollback target.
PREVIOUS_RELEASE=""
PREVIOUS_SHA=""
if ! $DRY_RUN; then
    PREVIOUS_RELEASE="$(live_release "$DEPLOY_PATH")"
    # OURS means a live release exists; an empty answer is a dropped connection, not a first deploy.
    [[ "$path_state" == "OURS" && -z "$PREVIOUS_RELEASE" ]] \
        && fail "${DEPLOY_PATH} is live but its release could not be read. Nothing has been activated."
    [[ -n "$PREVIOUS_RELEASE" ]] && PREVIOUS_SHA="$(remote "cat ${PREVIOUS_RELEASE}/DEPLOYED_SHA 2>/dev/null || true" 2>/dev/null | tr -d '[:space:]')"
fi
ACTIVATED=false

# Any exit after the swap restores the previous release. rc is PASSED in: by the time the
# callee runs, $? is the status of the trap's own cleanup command, not the script's.
deploy_rollback_release() {
    local rc="$1"
    $ACTIVATED || return "$rc"
    rollback_release "$rc" "$PREVIOUS_RELEASE" "$PREVIOUS_SHA" "$DEPLOY_PATH" "$RELEASE_DIR"
}
trap 'rc=$?; rmdir "${LOCK_FILE}.d" 2>/dev/null; deploy_rollback_release "$rc"; exit $rc' EXIT

log_info "Activating ${RELEASE_ID} (atomic swap)..."
# Set BEFORE the swap is issued: a dropped connection after the remote mv must not disarm the trap.
$DRY_RUN || ACTIVATED=true
run "activate_release '${RELEASE_DIR}' '${DEPLOY_PATH}'"

# -------------------------------------------------------------------- verify
if $DRY_RUN; then
    echo "  ${YELLOW}[dry-run]${NC} curl ${CURL_PIN} ${HEALTH_URL}/DEPLOYED_SHA == ${SHA}; every manifest path -> 200; neighbours unchanged; prune to ${KEEP_RELEASES}"
    echo; log_info "Dry run complete. Nothing was changed."; exit 0
fi

echo
log_info "Verifying..."

# 1. The served SHA, pinned to the mutated box.
served="$(curl -sS --max-time 15 ${CURL_PIN} "${HEALTH_URL}/DEPLOYED_SHA" 2>/dev/null | tr -d '[:space:]' || true)"
if [[ "$served" != "$SHA" ]]; then
    log_error "Served SHA '${served:-<none>}' != deployed '${SHA}'"
    log_error "If this is the first deploy, run ./.deploy/provision.sh first (vhost + TLS)."
    exit 1
fi
log_success "Serving ${SHORT_SHA} (SHA matches)"

# 2. Every shipped path, derived from the manifest, plus the root.
pages_ok=true
for path in / $(printf '%s\n' "$MANIFEST" | sed 's|^|/|'); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 ${CURL_PIN} "${HEALTH_URL}${path}" 2>/dev/null || true)"; code="${code:-000}"
    if [[ "$code" == "200" ]]; then
        log_success "${path} -> 200"
    else
        log_error "${path} -> ${code}"
        pages_ok=false
    fi
done
$pages_ok || fail "Marker matches but a shipped path is not served. Rolling back."

# 3. Every co-tenant answers exactly as it did before.
log_info "Confirming co-tenants are unchanged..."
NEIGHBOURS_AFTER="$(probe_neighbours "$SERVER_HOST" "${NEIGHBOURS[@]}")"
printf '%s\n' "$NEIGHBOURS_AFTER" | sed 's/^/    after:  /'
if ! changed="$(neighbour_status_changes "$NEIGHBOURS_BEFORE" "$NEIGHBOURS_AFTER")"; then
    printf '%s\n' "$changed" | sed 's/^/    CHANGED: /' >&2
    fail "A co-tenant's status changed during this deploy. Rolling back."
fi
log_success "All ${#NEIGHBOURS[@]} co-tenant(s) unchanged"
# Only a release that passed every check above becomes a --rollback target (.verified is a
# dotfile, so the vhost's dotfile deny keeps it off the web).
remote "touch ${RELEASE_DIR}/.verified" \
    || log_warn "Could not mark ${RELEASE_ID} verified; --rollback will not select it."

# Verified on every axis. Only now is it safe to prune around this release.
log_info "Pruning old releases (keeping ${KEEP_RELEASES}, protecting active + previous)..."
all_releases=()
while IFS= read -r rel_name; do
    [[ -n "$rel_name" ]] && all_releases+=("$rel_name")
done < <(remote "ls -1dt ${RELEASES_ROOT}/*/ 2>/dev/null | xargs -n1 basename" 2>/dev/null)
PREVIOUS_RELEASE_NAME=""
[[ -n "$PREVIOUS_RELEASE" ]] && PREVIOUS_RELEASE_NAME="$(basename "$PREVIOUS_RELEASE")"
to_delete=()
if [[ "${#all_releases[@]}" -gt 0 ]]; then
    while IFS= read -r rel_name; do
        [[ -n "$rel_name" ]] && to_delete+=("$rel_name")
    done < <(prune_release_list "$KEEP_RELEASES" "$RELEASE_ID" "$PREVIOUS_RELEASE_NAME" "${all_releases[@]}")
fi
if [[ "${#to_delete[@]}" -gt 0 ]]; then
    for d in "${to_delete[@]}"; do
        remote "rm -rf '${RELEASES_ROOT}/${d}'"
    done
    log_success "Pruned ${#to_delete[@]} release(s)"
else
    log_info "Nothing to prune"
fi

echo
log_success "Deployed ${SHORT_SHA} to ${HEALTH_URL}"
