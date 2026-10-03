#!/usr/bin/env bash
# Paired Backstage release promotion. One-time service/nginx setup is separate.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source .deploy/config.sh
source .deploy/lib.sh
source .deploy/backstage-lib.sh
DRY_RUN=false
ROLLBACK_SHA=""
while [[ $# -gt 0 ]]; do
 case "$1" in
  --dry-run) DRY_RUN=true; shift ;;
  --rollback) [[ $# -ge 2 ]] || fail "--rollback requires a verified full SHA"; ROLLBACK_SHA="$2"; shift 2 ;;
  *) fail "Usage: .deploy/backstage-deploy.sh [--dry-run] [--rollback SHA]" ;;
 esac
done
SHA="$(git rev-parse HEAD)"
ROOT=/var/www/jevnotjev-backstage-releases
CURRENT=/var/www/jevnotjev-backstage-current
SERVICE=jevnotjev-backstage
if [[ -n "$ROLLBACK_SHA" ]]; then
 [[ "$ROLLBACK_SHA" =~ ^[a-f0-9]{40}$ ]] || fail "Invalid rollback SHA"
 SHA="$ROLLBACK_SHA"
fi
if $DRY_RUN; then
 log_info "Would require clean HEAD == fresh origin/main and a merged issue-linked PR; build locally, validate/package artifacts, verify configured service and scoped nginx proxy."
 log_info "Would promote ${ROOT}/${SHA}, restart ONLY ${SERVICE}, verify both version endpoints and neighbours; rollback the pair on failure."
 [[ -z "$ROLLBACK_SHA" ]] || log_info "Rollback requires ${ROOT}/${SHA}/.verified and restores that complete pair."
 exit 0
fi
LOCK="${TMPDIR:-/tmp}/jevnotjev-backstage-deploy.lock.d"
mkdir "$LOCK" 2>/dev/null || fail "Backstage deploy already running"
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT
if [[ -z "$ROLLBACK_SHA" ]]; then
 [[ -z "$(git status --porcelain --untracked-files=no)" ]] || fail "Tracked changes present"
 backstage_clean_sources || fail "Dirty or untracked shippable sources present; refusing to build"
 git fetch origin main --no-tags
 [[ "$SHA" == "$(git rev-parse origin/main)" ]] || fail "HEAD is not fresh origin/main"
 # A merged PR and issue link are required even when main contains the SHA.
 PR_JSON="$(gh api "repos/breakoutwithai/jevnotjev/commits/${SHA}/pulls")"
 printf '%s' "$PR_JSON" | bun -e 'const p=await Bun.stdin.json();if(!Array.isArray(p)||!p.some(x=>x.merged_at&&x.base?.ref==="main"&&/#67\b/.test(x.body??"")))process.exit(1)' || fail "No merged main PR linked to #67 for HEAD"
 bun scripts/backstage-build.ts
 bun .deploy/backstage-package.ts dist/backstage "$SHA"
fi
remote "test -f /etc/systemd/system/${SERVICE}.service && test -f /etc/nginx/snippets/jevnotjev-backstage.conf && grep -q 'include /etc/nginx/snippets/jevnotjev-backstage.conf;' '${VHOST_AVAILABLE}'" || fail "One-time reviewed setup is missing; see docs/backstage-deploy.md"
remote "mkdir /var/lock/jevnotjev-backstage-deploy" || fail "Another host deploy is active; inspect the existing lock before retrying"
trap 'remote "rmdir /var/lock/jevnotjev-backstage-deploy" || true; rmdir "$LOCK" 2>/dev/null || true' EXIT
neighbours=()
while IFS= read -r n; do [[ -z "$n" ]] || neighbours+=("$n"); done < <(list_neighbours "$DOMAIN")
[[ ${#neighbours[@]} -gt 0 ]] || fail "Cannot enumerate neighbours"
before="$(probe_neighbours "$SERVER_HOST" "${neighbours[@]}")"
previous="$(backstage_previous_release "$CURRENT")" || fail "Cannot verify current Backstage release; refusing to assume first install"
if [[ -n "$previous" ]]; then
 [[ "$previous" =~ ^/var/www/jevnotjev-backstage-releases/[a-f0-9]{40}$ ]] || fail "Foreign current release"
 remote "test -f '${previous}/.verified'" || fail "Previous release is unverified"
fi
release="${ROOT}/${SHA}"
if [[ -n "$ROLLBACK_SHA" ]]; then
 remote "test -f '${release}/.verified'" || fail "Rollback target is not verified"
else
 remote "test ! -e '${release}' && mkdir -p '${release}'" || fail "Release already exists or cannot be created"
 archive_sha="$(shasum -a 256 dist/backstage.tar.gz | awk '{print $1}')"
 remote "cat > '${release}/payload.tar.gz'" < dist/backstage.tar.gz
 remote "cd '${release}' && printf '%s\n' '${archive_sha}  payload.tar.gz' | sha256sum -c - && tar -xzf payload.tar.gz --no-same-owner && rm payload.tar.gz"
 remote "printf '%s\n' 'BACKSTAGE_VERSION=${SHA}' 'BACKSTAGE_ORIGIN=${HEALTH_URL}' 'BACKSTAGE_STATIC_ROOT=${CURRENT}/site' 'PORT=3456' > '${release}/runtime.env'; chmod -R a+rX '${release}'"
fi
activated=false
restore(){
 local rc="$?"
 if [[ "$rc" -ne 0 ]] && $activated; then
  if [[ -n "$previous" ]]; then
   activate_release "$previous" "$CURRENT" && remote "systemctl restart '${SERVICE}'" || log_error "PAIR ROLLBACK FAILED: inspect ${CURRENT} and ${SERVICE}"
   sleep 1
   curl -fsS --max-time 10 ${CURL_PIN} "${HEALTH_URL}/api/backstage/health" | bun -e 'const r=await Bun.stdin.json();if(r.version!==process.argv[1])process.exit(1)' "${previous##*/}" || log_error "Rollback version did not verify; inspect service immediately"
  else
   remote "systemctl stop '${SERVICE}'" || log_error "Could not stop failed initial service"
  fi
 fi
 remote "rmdir /var/lock/jevnotjev-backstage-deploy" || log_error "Remote lock remains; inspect before retrying"
 rmdir "$LOCK" 2>/dev/null || true
 exit "$rc"
}
trap restore EXIT
activated=true
activate_release "$release" "$CURRENT"
remote "systemctl restart '${SERVICE}'"
# Version endpoint and served page asset each prove the newly promoted pair.
healthy=false
for attempt in 1 2 3 4 5; do
 if curl -fsS --max-time 10 ${CURL_PIN} "${HEALTH_URL}/api/backstage/health" | bun -e 'const r=await Bun.stdin.json();if(r.version!==process.argv[1]||r.protocol!=="backstage/1")process.exit(1)' "$SHA"; then healthy=true; break; fi
 sleep 1
done
$healthy || fail "New API version did not verify"
# Compare actual served bundle bytes to the immutable on-box artifact for rollback as well.
expected="$(remote "sha256sum '${release}/site/backstage/app.js'" | awk '{print $1}')"
actual="$(curl -fsS --max-time 10 ${CURL_PIN} "${HEALTH_URL}/backstage/app.js" | shasum -a 256 | awk '{print $1}')"
[[ -n "$expected" && "$expected" == "$actual" ]] || fail "Served browser bundle differs"
curl -fsS --max-time 10 ${CURL_PIN} "${HEALTH_URL}/backstage/" >/dev/null
remote "systemctl is-active --quiet '${SERVICE}'"
after="$(probe_neighbours "$SERVER_HOST" "${neighbours[@]}")"
neighbour_status_changes "$before" "$after" || fail "Neighbour changed"
remote "printf '%s\n' 'sha=${SHA}' 'issue=67' 'utc=$(date -u +%FT%TZ)' 'actor=$(id -un)' > '${release}/.verified'"
log_success "Backstage pair ${SHA} verified. Previous: ${previous:-none}. No nginx reload or other service restart."
