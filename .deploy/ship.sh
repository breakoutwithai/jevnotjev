#!/usr/bin/env bash
#
# ship.sh - the one deploy entrypoint for every jevnotjev module.
#
# Each module keeps its own release, verify and rollback logic:
#   static     .deploy/deploy.sh             (site/ release swap; vhost + TLS via provision.sh)
#   backstage  .deploy/backstage-deploy.sh   (paired API + browser release; setup via backstage-setup.sh)
#
# ship.sh adds what no single module can see: the whole stack against origin/main.
#   - `ship.sh` with no flags is THE deploy: every module at origin/main. A module already serving
#     origin/main from a verified release is skipped ("up to date"); the rest deploy, static
#     first. After all succeed every module must serve origin/main, and the stack is recorded as
#     an annotated CalVer tag (vYYYY.MM.DD.N) plus a GitHub release.
#   - `--status` compares each module's served SHA with origin/main and reports drift.
#   - `--module X` deploys one module and refuses while another module is STALE or UNKNOWN,
#     unless --allow-drift. Agents use the default.
#   - A static failure stops before backstage. A backstage failure never touches the verified
#     static release. A failed tag or GitHub release never rolls a verified deploy back.
#   - `--dry-run` prints the plan and passes --dry-run to every module script it would run.
#
# Exit codes: 0 ok, 1 preflight or post-deploy check failed, 2 usage, 3 --status found a STALE
# or UNKNOWN module, 4 partial deploy refused, 5 deploy verified but the release record failed;
# a failing module script's own exit code is passed through unchanged.
#
# Bash 3.2 compatible.
set -uo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() {
    cat <<'EOF'
Usage: .deploy/ship.sh [--module static|backstage|all] [ACTION] [--dry-run]

  (no flags)                      THE deploy: every module at origin/main. Modules already serving
                                  origin/main (verified) are skipped; then the stack is tagged
                                  vYYYY.MM.DD.N and published as a GitHub release.
  --module static|backstage|all   module to act on (default: all = static, then backstage)
  --dry-run                       print the plan, drift and the tag it would create; every module
                                  script runs with --dry-run; no tag, push or gh call
  --allow-drift                   with --module: deploy one module even though another is STALE
  --no-release                    deploy without the tag and GitHub release (local testing only)
  ACTION (one, default deploy):
    (none)                        deploy: static via deploy.sh, backstage via backstage-deploy.sh
    --status                      read-only, per module: served SHA, main, drift, release tag,
                                  current release, verified marker, service state, setup present.
                                  Exits 3 when any module is STALE or UNKNOWN.
    --setup                       one-time setup: static = provision.sh (vhost + TLS),
                                  backstage = backstage-setup.sh (user, unit, nginx include)
    --rollback [SHA]              per module, never with all:
                                  static: previous verified release (no SHA)
                                  backstage: --rollback <full 40-char verified SHA>
  -h, --help                      this text

Exit: 0 ok, 1 preflight/post-check failed, 2 usage, 3 status drift, 4 partial deploy refused,
      5 deployed but tag/release failed (recovery command printed); else the module's own code.
Go live:  --status, --setup --dry-run, --setup, --dry-run, then the deploy itself.
EOF
}

usage_error() { echo "ship.sh: $1" >&2; usage >&2; exit 2; }

MODULE="all"
ACTION=""
DRY_RUN=false
ALLOW_DRIFT=false
NO_RELEASE=false
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
        --allow-drift) ALLOW_DRIFT=true; shift ;;
        --no-release) NO_RELEASE=true; shift ;;
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

cd "${DEPLOY_DIR}/.." || exit 1

ALL_MODULES=(static backstage)
MODULES=(static backstage)
[[ "$MODULE" == all ]] || MODULES=("$MODULE")

# ------------------------------------------------------------------ module paths (defined once)
# The repository paths whose changes alter what a module serves. Shared deploy plumbing counts
# for both. Drift is a served SHA behind origin/main AND a change under these paths.
SHARED_PATHS=(.deploy/lib.sh .deploy/config.sh)
module_paths() {
    case "$1" in
        static) printf '%s\n' site/ ':(exclude)site/backstage/' "${SHARED_PATHS[@]}" ;;
        backstage) printf '%s\n' site/backstage/ src/backstage/ scripts/backstage-build.ts '.deploy/backstage*' "${SHARED_PATHS[@]}" ;;
    esac
}

# ------------------------------------------------------------------ live state (read-only)
# Per-module state lives in ST_<module>_<key>: served, probe, current, verified, protocol,
# catalogVersion, class (none|STALE|UNKNOWN), drift (the printed text).
setv() { printf -v "ST_$1_$2" '%s' "$3"; }
getv() { local n="ST_$1_$2"; printf '%s' "${!n:-}"; }
probe_value() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -1; }

load_config() {
    # shellcheck source=/dev/null
    source "${DEPLOY_DIR}/config.sh"
    # shellcheck source=/dev/null
    source "${DEPLOY_DIR}/backstage-lib.sh"
}

# Fetch origin/main and the release tags. Sets MAIN_SHA (empty when unresolvable). Returns 1
# when the main fetch failed; MAIN_SHA then holds the local origin/main ref, if any.
MAIN_SHA=""
refresh_main() {
    local fetched=0
    git fetch --quiet --no-tags origin main >/dev/null 2>&1 || fetched=1
    git fetch --quiet --no-tags origin 'refs/tags/v*:refs/tags/v*' >/dev/null 2>&1 || true
    MAIN_SHA="$(git rev-parse --verify -q 'origin/main^{commit}' 2>/dev/null || true)"
    return "$fetched"
}

read_static() {
    local probe served
    setv static served none; setv static probe ""
    probe="$(remote "D='${DEPLOY_PATH}' V='${VHOST_AVAILABLE}' E='${VHOST_ENABLED}' C='/etc/letsencrypt/live/${DOMAIN}'
L=\$(readlink \"\$D\" 2>/dev/null || true)
echo \"release=\${L:-none}\"
if [ -n \"\$L\" ]; then echo \"marker=\$(cat \"\$L/DEPLOYED_SHA\" 2>/dev/null)\"; fi
if [ -n \"\$L\" ] && [ -f \"\$L/.verified\" ]; then echo verified=yes; else echo verified=no; fi
echo \"service=nginx \$(systemctl is-active nginx 2>/dev/null || true)\"
if [ -f \"\$V\" ] && [ \"\$(readlink \"\$E\" 2>/dev/null)\" = \"\$V\" ] && [ -d \"\$C\" ]; then echo setup=yes; else echo setup=no; fi")" || return 1
    served="$(curl -sS --fail --max-time 15 ${CURL_PIN} "${HEALTH_URL}/DEPLOYED_SHA" 2>/dev/null | tr -d '[:space:]' || true)"
    setv static probe "$probe"
    setv static served "${served:-none}"
    setv static current "$(probe_value "$probe" release)"
    setv static verified "$(probe_value "$probe" verified)"
}

read_backstage() {
    local probe health fields auth
    setv backstage served none; setv backstage probe ""
    probe="$(remote "C='/var/www/jevnotjev-backstage-current' U='/etc/systemd/system/jevnotjev-backstage.service' S='/etc/nginx/snippets/jevnotjev-backstage.conf' V='${VHOST_AVAILABLE}'
L=\$(readlink \"\$C\" 2>/dev/null || true)
echo \"release=\${L:-none}\"
if [ -n \"\$L\" ] && [ -f \"\$L/.verified\" ]; then echo verified=yes; else echo verified=no; fi
echo \"service=\$(systemctl is-active jevnotjev-backstage 2>/dev/null || true), \$(systemctl is-enabled jevnotjev-backstage 2>/dev/null || true)\"
if [ -f \"\$U\" ] && [ -f \"\$S\" ] && sed 's/#.*//' \"\$V\" 2>/dev/null | grep -qF \"include \$S;\"; then echo setup=yes; else echo setup=no; fi")" || return 1
    # Effective auth of the installed snippet; unreadable or unrecognised is unknown, never no.
    # With the gate on, no Backstage probe is sent without the private curl config.
    auth="$(backstage_auth_state)" || auth=unknown
    probe="${probe}
auth=${auth}"
    setv backstage probe "$probe"
    setv backstage current "$(probe_value "$probe" release)"
    setv backstage verified "$(probe_value "$probe" verified)"
    if ! backstage_require_curl_config "$auth"; then
        setv backstage served unknown
        return 1
    fi
    health="$(backstage_curl -sS --fail --max-time 15 ${CURL_PIN} "${HEALTH_URL}/api/backstage/health" 2>/dev/null || true)"
    # Top-level release fields only; the body also nests a catalog that is not the release.
    fields="$(printf '%s' "$health" | bun -e 'const r=await Bun.stdin.json();for(const k of ["version","protocol","catalogVersion"]){const v=r?.[k];if(typeof v==="string"&&!/[\r\n]/.test(v))console.log(k+"="+v)}' 2>/dev/null || true)"
    setv backstage probe "$probe"
    setv backstage served "$(probe_value "$fields" version)"
    [[ -n "$(getv backstage served)" ]] || setv backstage served none
    setv backstage protocol "$(probe_value "$fields" protocol)"
    setv backstage catalogVersion "$(probe_value "$fields" catalogVersion)"
    setv backstage current "$(probe_value "$probe" release)"
    setv backstage verified "$(probe_value "$probe" verified)"
}

read_state() {
    case "$1" in
        static) read_static ;;
        backstage) read_backstage ;;
    esac
}

# Sets class and drift for one module from its served SHA and MAIN_SHA.
compute_drift() {
    local m="$1" served changed n total list p paths=()
    served="$(getv "$m" served)"
    if [[ -z "$MAIN_SHA" ]]; then
        setv "$m" class UNKNOWN; setv "$m" drift "UNKNOWN (origin/main could not be resolved)"; return
    fi
    if [[ ! "$served" =~ ^[0-9a-f]{40}$ ]] || ! git cat-file -e "${served}^{commit}" 2>/dev/null; then
        setv "$m" class UNKNOWN; setv "$m" drift "UNKNOWN (served '${served}' is not a known commit)"; return
    fi
    if [[ "$served" == "$MAIN_SHA" ]]; then
        setv "$m" class none; setv "$m" drift none; return
    fi
    while IFS= read -r p; do paths+=("$p"); done < <(module_paths "$m")
    changed="$(git diff --name-only "$served" "$MAIN_SHA" -- "${paths[@]}")"
    if [[ -z "$changed" ]]; then
        setv "$m" class none; setv "$m" drift "none (sha differs, no module changes)"; return
    fi
    n="$(git rev-list --count "${served}..${MAIN_SHA}")"
    total="$(printf '%s\n' "$changed" | wc -l | tr -d ' ')"
    list="$(printf '%s\n' "$changed" | head -10 | paste -sd ',' - | sed 's/,/, /g')"
    [[ "$total" -le 10 ]] || list="${list}, +$((total - 10)) more"
    setv "$m" class STALE; setv "$m" drift "STALE (${n} commits behind; changed: ${list})"
}

# The newest release tag pointing at a commit, if any.
release_tag_at() {
    git tag --points-at "$1" -l 'v[0-9]*' 2>/dev/null | sort | tail -1
}

row() { printf '  %-9s %s\n' "$1" "$2"; }

print_status() {
    local m="$1" probe served key value tag
    probe="$(getv "$m" probe)"; served="$(getv "$m" served)"
    echo "$m"
    row served "$served"
    row main "${MAIN_SHA:-unknown}"
    row drift "$(getv "$m" drift)"
    if [[ "$served" =~ ^[0-9a-f]{40}$ ]]; then
        tag="$(release_tag_at "$served")"
        [[ -z "$tag" ]] || row release "$tag"
    fi
    for key in release marker verified service setup auth; do
        value="$(probe_value "$probe" "$key")"
        [[ -n "$value" ]] || continue
        [[ "$key" != release ]] || key=current
        row "$key" "$value"
    done
}

run_status() {
    load_config
    [[ -f "$SSH_KEY" ]] || { log_error "SSH key not found: ${SSH_KEY}"; return 1; }
    remote 'echo ok' >/dev/null 2>&1 || { log_error "Cannot SSH to ${SERVER}. Check user, key and IP, then stop."; return 1; }
    refresh_main || log_warn "Could not fetch origin/main; comparing against the local origin/main ref."
    local rc=0 drifted=0 m
    for m in "${MODULES[@]}"; do
        if read_state "$m"; then
            compute_drift "$m"
            print_status "$m"
            [[ "$(getv "$m" class)" == none ]] || drifted=1
        else
            # A partial read (e.g. auth refused the health probe) still shows what was read.
            if [[ -n "$(getv "$m" probe)" ]]; then compute_drift "$m"; print_status "$m"; fi
            log_error "${m} status probe failed"; rc=1
        fi
    done
    [[ "$rc" -eq 0 ]] || return 1
    [[ "$drifted" -eq 0 ]] || return 3
    return 0
}

if [[ "$ACTION" == status ]]; then
    run_status
    exit $?
fi

# ------------------------------------------------------------------ release record
yaml_quote() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '"%s"' "$s"; }
# A plain token is emitted bare; anything else is quoted.
yaml_value() {
    if [[ "$1" =~ ^[A-Za-z0-9._/+-]+$ ]]; then printf '%s' "$1"; else yaml_quote "$1"; fi
}

# "#N title" per first-parent commit in the range: squash subjects ending "(#N)" and
# "Merge pull request #N from ..." (title = first body line).
pr_lines() {
    local h subj body n re_squash='\(#([0-9]+)\)$' re_merge='^Merge pull request #([0-9]+) from'
    git log --first-parent --format='%H' "$@" | while IFS= read -r h; do
        subj="$(git log -1 --format=%s "$h")"
        if [[ "$subj" =~ $re_squash ]]; then
            printf '#%s %s\n' "${BASH_REMATCH[1]}" "${subj% (#*)}"
        elif [[ "$subj" =~ $re_merge ]]; then
            n="${BASH_REMATCH[1]}"
            body="$(git log -1 --format=%b "$h" | sed -n '/[^[:space:]]/{p;q;}')"
            printf '#%s %s\n' "$n" "${body:-$subj}"
        fi
    done
}

# vYYYY.MM.DD.N, UTC date, N = 1 + count of existing tags for that date (skipping any taken N).
next_version() {
    local d n
    d="$(date -u +%Y.%m.%d)"
    n="$(git tag -l "v${d}.*" | grep -Ec "^v${d//./\\.}\\.[0-9]+$" || true)"
    n=$((n + 1))
    while git rev-parse -q --verify "refs/tags/v${d}.${n}" >/dev/null 2>&1; do n=$((n + 1)); done
    printf 'v%s.%s\n' "$d" "$n"
}

previous_tag() {
    git describe --tags --abbrev=0 --match 'v[0-9]*' "$1" 2>/dev/null || true
}

release_yaml() {
    local version="$1" sha="$2" prev="$3" line prs
    if [[ -n "$prev" ]]; then prs="$(pr_lines "${prev}..${sha}")"; else prs="$(pr_lines "$sha")"; fi
    printf 'version: %s\n' "$version"
    printf 'sha: %s\n' "$sha"
    printf 'utc: %s\n' "$(yaml_quote "$(date -u +%Y-%m-%dT%H:%M:%SZ)")"
    printf 'actor: %s\n' "$(yaml_quote "$(git config user.name 2>/dev/null || echo unknown)")"
    printf 'previous_tag: %s\n' "$(yaml_value "${prev:-none}")"
    printf 'modules:\n'
    printf '  static:\n'
    printf '    served_sha: %s\n' "$(yaml_value "$(getv static served)")"
    printf '    release_dir: %s\n' "$(yaml_value "$(getv static current)")"
    printf '  backstage:\n'
    printf '    version: %s\n' "$(yaml_value "$(getv backstage served)")"
    printf '    protocol: %s\n' "$(yaml_value "$(getv backstage protocol)")"
    printf '    catalogVersion: %s\n' "$(yaml_value "$(getv backstage catalogVersion)")"
    printf '    release_dir: %s\n' "$(yaml_value "$(getv backstage current)")"
    if [[ -z "$prs" ]]; then
        printf 'prs: []\n'
    else
        printf 'prs:\n'
        while IFS= read -r line; do printf '  - %s\n' "$(yaml_quote "$line")"; done <<< "$prs"
    fi
}

release_notes() {
    local version="$1" sha="$2" prev="$3" yaml="$4"
    printf 'Full-stack release `%s` at `%s`.\n\n' "$version" "$sha"
    printf '| Module | Serving | Release dir |\n|---|---|---|\n'
    printf '| static | `%s` | `%s` |\n' "$(getv static served)" "$(getv static current)"
    printf '| backstage | `%s` (%s, catalog %s) | `%s` |\n' "$(getv backstage served)" \
        "$(getv backstage protocol)" "$(getv backstage catalogVersion)" "$(getv backstage current)"
    printf '\nPrevious release: %s\n\n## Pull requests\n\n' "${prev:-none}"
    printf '%s\n' "$yaml" | sed -n 's/^  - "\(.*\)"$/- \1/p' | sed 's/\\"/"/g; s/\\\\/\\/g'
    printf '\n## Metadata\n\n```yaml\n%s\n```\n' "$yaml"
}

# Tag S, push only that tag, publish the GitHub release. Returns 5 on any failure, after
# printing the exact command that finishes the job. Never touches the deployed modules.
release_record() {
    local sha="$MAIN_SHA" existing version prev dir yaml msgfile notes gh_cmd
    existing="$(release_tag_at "$sha")"
    if [[ -n "$existing" ]]; then
        echo "release: ${existing} already tags ${sha}; not tagging"
        return 0
    fi
    version="$(next_version)"
    prev="$(previous_tag "$sha")"
    dir="${TMPDIR:-/tmp}/jevnotjev-release-${version}"
    mkdir -p "$dir" || { log_error "Cannot create ${dir}"; return 5; }
    msgfile="${dir}/tag-message.txt"; notes="${dir}/notes.md"
    yaml="$(release_yaml "$version" "$sha" "$prev")"
    printf 'Release %s\n\n%s\n' "$version" "$yaml" > "$msgfile"
    release_notes "$version" "$sha" "$prev" "$yaml" > "$notes"
    gh_cmd="gh release create ${version} --verify-tag --title ${version} --notes-file ${notes}"
    if ! git tag -a "$version" "$sha" --cleanup=verbatim -F "$msgfile"; then
        log_error "Deploy verified and live; creating tag ${version} failed. Finish with:"
        echo "  git tag -a ${version} ${sha} --cleanup=verbatim -F ${msgfile} && git push origin refs/tags/${version} && ${gh_cmd}" >&2
        return 5
    fi
    echo "release: tagged ${version} on ${sha} (previous: ${prev:-none})"
    if ! git push origin "refs/tags/${version}"; then
        log_error "Deploy verified and live; pushing tag ${version} failed. Finish with:"
        echo "  git push origin refs/tags/${version} && ${gh_cmd}" >&2
        return 5
    fi
    if ! gh release create "$version" --verify-tag --title "$version" --notes-file "$notes"; then
        log_error "Deploy verified and live; tag ${version} pushed; the GitHub release failed. Finish with:"
        echo "  ${gh_cmd}" >&2
        return 5
    fi
    echo "release: published ${version}"
}

# ------------------------------------------------------------------ deploy preflight + plan
PLAN=" "
if [[ "$ACTION" == deploy ]]; then
    load_config
    if ! refresh_main; then
        if $DRY_RUN; then log_warn "Could not fetch origin/main (dry-run, not blocking)."
        else log_error "Could not fetch origin/main; refusing to deploy."; exit 1; fi
    fi
    HEAD_SHA="$(git rev-parse HEAD 2>/dev/null || true)"
    if [[ -z "$MAIN_SHA" || "$HEAD_SHA" != "$MAIN_SHA" ]]; then
        msg="HEAD (${HEAD_SHA:-none}) is not origin/main (${MAIN_SHA:-unresolved}). Deploy from a clean worktree at origin/main."
        if $DRY_RUN; then log_warn "${msg} (dry-run, not blocking)"; else log_error "$msg"; exit 1; fi
    fi
    for m in "${ALL_MODULES[@]}"; do
        read_state "$m" || log_warn "${m}: live state could not be read"
        compute_drift "$m"
    done

    # A partial deploy must not leave another module behind main.
    if [[ "$MODULE" != all ]]; then
        for other in "${ALL_MODULES[@]}"; do
            [[ "$other" != "$MODULE" ]] || continue
            class="$(getv "$other" class)"
            [[ "$class" == STALE || "$class" == UNKNOWN ]] || continue
            drift="$(getv "$other" drift)"
            if $ALLOW_DRIFT; then
                log_warn "--allow-drift: leaving ${other} at drift ${drift}"
            elif $DRY_RUN; then
                log_warn "would refuse without --allow-drift (exit 4): ${other} drift ${drift}"
            else
                log_error "Refusing --module ${MODULE}: ${other} drift ${drift}"
                echo "  Deploy the whole stack instead:   .deploy/ship.sh" >&2
                echo "  Leave ${other} behind on purpose: .deploy/ship.sh --module ${MODULE} --allow-drift" >&2
                exit 4
            fi
        done
    fi

    echo "Plan against origin/main ${MAIN_SHA:-unresolved}$($DRY_RUN && echo ' (dry-run)'):"
    for m in "${MODULES[@]}"; do
        served="$(getv "$m" served)"
        if [[ -n "$MAIN_SHA" && "$served" == "$MAIN_SHA" && "$(getv "$m" verified)" == yes ]]; then
            row "$m" "up to date (serving ${served:0:7}, verified)"
        else
            row "$m" "deploy (served ${served:0:7}; drift $(getv "$m" drift))"
            PLAN="${PLAN}${m} "
        fi
    done
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

RESULTS=""
FINAL_RC=0
for m in "${MODULES[@]}"; do
    if [[ "$FINAL_RC" -ne 0 ]]; then
        RESULTS="${RESULTS}  ${m}    SKIPPED (an earlier module failed)
"
        continue
    fi
    if [[ "$ACTION" == deploy && "$PLAN" != *" ${m} "* ]]; then
        RESULTS="${RESULTS}  ${m}    up to date
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

summary() {
    echo
    echo "ship.sh ${ACTION}$($DRY_RUN && echo ' (dry-run)'):"
    printf '%s' "$RESULTS"
}

if [[ "$ACTION" != deploy || "$FINAL_RC" -ne 0 ]]; then
    summary
    exit "$FINAL_RC"
fi

if $DRY_RUN; then
    summary
    if [[ "$MODULE" == all && "$NO_RELEASE" == false && -n "$MAIN_SHA" ]]; then
        existing="$(release_tag_at "$MAIN_SHA")"
        if [[ -n "$existing" ]]; then
            echo "release: ${existing} already tags ${MAIN_SHA}; would not tag"
        else
            v="$(next_version)"
            echo "release: would create tag ${v} on ${MAIN_SHA} (previous: $(previous_tag "$MAIN_SHA" | sed 's/^$/none/')), push refs/tags/${v}, gh release create ${v} --verify-tag"
        fi
    fi
    exit 0
fi

# Every deployed module must now serve origin/main; for the full stack, every module.
post_ok=true
for m in "${MODULES[@]}"; do
    read_state "$m" || true
    served="$(getv "$m" served)"
    if [[ "$served" != "$MAIN_SHA" ]]; then
        log_error "${m} is not serving origin/main after the deploy: served ${served}, main ${MAIN_SHA}"
        post_ok=false
    fi
done
summary
$post_ok || exit 1

if [[ "$MODULE" == all && "$NO_RELEASE" == false ]]; then
    release_record || exit 5
fi
exit 0
