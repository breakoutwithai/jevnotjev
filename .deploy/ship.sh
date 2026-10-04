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
#   - `--verify [SHA]` is the read-only live check (.deploy/verify-lib.sh): spec literals for seams
#     S1 and S2 in docs/DEPLOY.md. It also closes every deploy, setup, rollback and --status.
#
# Exit codes: 0 ok, 1 preflight or post-deploy check failed, 2 usage, 3 --status found a STALE
# or UNKNOWN module, 4 partial deploy refused, 5 deploy verified but the release record failed,
# 6 the live verify failed; a failing module script's own exit code is passed through unchanged.
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
    --verify [SHA]                read-only live check, whole stack: every module serves SHA
                                  (default origin/main), Backstage 401 without and 200 with
                                  BACKSTAGE_CURL_CONFIG, /, /label/, /little-shop/ 200, and a release
                                  tag on origin. Also runs at the end of every deploy, setup,
                                  rollback and --status.
  -h, --help                      this text

Exit: 0 ok, 1 preflight/post-check failed, 2 usage, 3 status drift, 4 partial deploy refused,
      5 deployed but tag/release failed (recovery command printed), 6 live verify failed;
      else the module's own code.
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
VERIFY_SHA=""
MODULE_GIVEN=false

set_action() {
    [[ -z "$ACTION" ]] || usage_error "choose one action; got --${ACTION} and --$1"
    ACTION="$1"
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --module)
            [[ $# -ge 2 ]] || usage_error "--module needs static, backstage or all"
            MODULE="$2"; MODULE_GIVEN=true; shift 2 ;;
        --dry-run) DRY_RUN=true; shift ;;
        --allow-drift) ALLOW_DRIFT=true; shift ;;
        --no-release) NO_RELEASE=true; shift ;;
        --status) set_action status; shift ;;
        --setup) set_action setup; shift ;;
        --rollback)
            set_action rollback
            if [[ $# -ge 2 && "$2" != --* ]]; then ROLLBACK_SHA="$2"; shift 2; else shift; fi ;;
        --verify)
            set_action verify
            if [[ $# -ge 2 && "$2" != --* ]]; then VERIFY_SHA="$2"; shift 2; else shift; fi ;;
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
if [[ "$ACTION" == verify ]]; then
    ! $MODULE_GIVEN || usage_error "--verify checks the whole stack; drop --module"
    ! $DRY_RUN || usage_error "--verify is already read-only; drop --dry-run"
    [[ -z "$VERIFY_SHA" || "$VERIFY_SHA" =~ ^[a-f0-9]{40}$ ]] || usage_error "--verify takes the full 40-character SHA the stack must serve"
fi

cd "${DEPLOY_DIR}/.." || exit 1

ALL_MODULES=(static backstage)
MODULES=(static backstage)
[[ "$MODULE" == all ]] || MODULES=("$MODULE")

# ------------------------------------------------------------------ module paths (defined once)
# The repository paths whose changes alter what a module serves. Shared deploy plumbing counts
# for both. Drift is a served SHA behind origin/main AND a change under these paths.
# Backstage sources are not a hand list: they are the import graph of the entrypoints
# scripts/backstage-build.ts bundles, read from origin/main by .deploy/backstage-deps.ts.
SHARED_PATHS=(.deploy/lib.sh .deploy/config.sh)
BACKSTAGE_FIXED_PATHS=(site/backstage/ scripts/backstage-build.ts '.deploy/backstage*' package.json bun.lock)
BACKSTAGE_DEPS=""
BACKSTAGE_DEPS_RC=""
# Computes BACKSTAGE_DEPS once per run (call it outside a subshell). Returns 1 when the graph
# cannot be built: Backstage drift is then UNKNOWN, never "no changes".
backstage_build_deps() {
    [[ -z "$BACKSTAGE_DEPS_RC" ]] || return "$BACKSTAGE_DEPS_RC"
    BACKSTAGE_DEPS_RC=1
    [[ -n "$MAIN_SHA" ]] || return 1
    local tmp
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/jevnotjev-deps.XXXXXX")" || return 1
    if git archive --format=tar "$MAIN_SHA" -- . ':(exclude)site' ':(exclude)docs' | tar -xf - -C "$tmp" \
        && BACKSTAGE_DEPS="$(bun "${DEPLOY_DIR}/backstage-deps.ts" "$tmp")" && [[ -n "$BACKSTAGE_DEPS" ]]; then
        BACKSTAGE_DEPS_RC=0
    fi
    rm -rf "$tmp"
    return "$BACKSTAGE_DEPS_RC"
}
module_paths() {
    case "$1" in
        static) printf '%s\n' site/ ':(exclude)site/backstage/' "${SHARED_PATHS[@]}" ;;
        backstage) printf '%s\n' "${BACKSTAGE_FIXED_PATHS[@]}" "$BACKSTAGE_DEPS" "${SHARED_PATHS[@]}" ;;
    esac
}

# ------------------------------------------------------------------ live state (read-only)
# Per-module state lives in ST_<module>_<key>: served, probe, current, verified, protocol,
# catalogVersion, class (none|STALE|UNKNOWN), drift (the printed text).
setv() { printf -v "ST_$1_$2" '%s' "$3"; }
getv() { local n="ST_$1_$2"; printf '%s' "${!n:-}"; }
probe_value() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -1; }

CONFIG_LOADED=false
load_config() {
    ! $CONFIG_LOADED || return 0
    CONFIG_LOADED=true
    # shellcheck source=/dev/null
    source "${DEPLOY_DIR}/config.sh"
    # shellcheck source=/dev/null
    source "${DEPLOY_DIR}/backstage-lib.sh"
    # shellcheck source=/dev/null
    source "${DEPLOY_DIR}/verify-lib.sh"
}

# The closing live check (seams S1 and S2, docs/DEPLOY.md). Args as verify_live. Returns 1 on any
# failed assertion; the caller exits 6.
closing_verify() {
    echo
    verify_live "$@" && return 0
    log_error "Live verify failed (see the FAIL lines above)."
    return 1
}
# The Backstage release state for verify: none only when the host has no current release.
backstage_release_state() {
    if [[ "$(getv backstage current)" == none ]]; then echo none; else echo yes; fi
}

# Fetch origin/main and the release tags. Sets MAIN_SHA (empty when unresolvable), FETCH_FAILED
# and TAGS_FETCHED. Returns 1 when the main fetch failed; MAIN_SHA then holds the cached
# origin/main ref, if any, and every drift is UNKNOWN.
MAIN_SHA=""
FETCH_FAILED=false
TAGS_FETCHED=false
refresh_main() {
    FETCH_FAILED=false; TAGS_FETCHED=false
    git fetch --quiet --no-tags origin main >/dev/null 2>&1 || FETCH_FAILED=true
    ! git fetch --quiet --no-tags origin 'refs/tags/v*:refs/tags/v*' >/dev/null 2>&1 || TAGS_FETCHED=true
    MAIN_SHA="$(git rev-parse --verify -q 'origin/main^{commit}' 2>/dev/null || true)"
    ! $FETCH_FAILED
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
    # A failed transfer is never parsed, even when it delivered a complete body first.
    if served="$(curl -sS --fail --max-time 15 ${CURL_PIN} "${HEALTH_URL}/DEPLOYED_SHA" 2>/dev/null)"; then
        served="$(printf '%s' "$served" | tr -d '[:space:]')"
    else
        served=""
    fi
    setv static probe "$probe"
    setv static marker "$(probe_value "$probe" marker)"
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
    # A failed transfer is never parsed, even when it delivered a complete body first.
    health="$(backstage_curl -sS --fail --max-time 15 ${CURL_PIN} "${HEALTH_URL}/api/backstage/health" 2>/dev/null)" || health=""
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

# Sets class and drift for one module from its served SHA and MAIN_SHA. A failed fetch keeps
# the cached comparison for display but makes the module UNKNOWN.
compute_drift() {
    local m="$1"
    compare_served "$m"
    if $FETCH_FAILED; then
        setv "$m" drift "UNKNOWN (origin/main fetch failed; cached comparison: $(getv "$m" drift))"
        setv "$m" class UNKNOWN
    fi
}

unknown() { setv "$1" class UNKNOWN; setv "$1" drift "UNKNOWN ($2)"; }

compare_served() {
    local m="$1" served changed n total list p paths=()
    served="$(getv "$m" served)"
    if [[ -z "$MAIN_SHA" ]]; then unknown "$m" "origin/main could not be resolved"; return; fi
    if [[ ! "$served" =~ ^[0-9a-f]{40}$ ]] || ! git cat-file -e "${served}^{commit}" 2>/dev/null; then
        unknown "$m" "served '${served}' is not a known commit"; return
    fi
    if [[ "$served" == "$MAIN_SHA" ]]; then
        setv "$m" class none; setv "$m" drift none; return
    fi
    if [[ "$m" == backstage ]] && ! backstage_build_deps; then
        unknown "$m" "the Backstage build import graph could not be read"; return
    fi
    while IFS= read -r p; do [[ -z "$p" ]] || paths+=("$p"); done < <(module_paths "$m")
    changed="$(git diff --name-only "$served" "$MAIN_SHA" -- "${paths[@]}")" \
        || { unknown "$m" "git diff ${served:0:7}..${MAIN_SHA:0:7} failed"; return; }
    if [[ -z "$changed" ]]; then
        setv "$m" class none; setv "$m" drift "none (sha differs, no module changes)"; return
    fi
    n="$(git rev-list --count "${served}..${MAIN_SHA}")" \
        || { unknown "$m" "git rev-list ${served:0:7}..${MAIN_SHA:0:7} failed"; return; }
    total="$(printf '%s\n' "$changed" | wc -l | tr -d ' ')"
    list="$(printf '%s\n' "$changed" | head -10 | paste -sd ',' - | sed 's/,/, /g')"
    [[ "$total" -le 10 ]] || list="${list}, +$((total - 10)) more"
    setv "$m" class STALE; setv "$m" drift "STALE (${n} commits behind; changed: ${list})"
}

# Release tags are ANNOTATED tags named vYYYY.MM.DD.N; nothing else counts.
is_release_tag() {
    [[ "$1" =~ ^v[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$ ]] \
        && [[ "$(git cat-file -t "refs/tags/$1" 2>/dev/null)" == tag ]]
}
# Release tags from a `git tag` listing (newest first by version order), filtered.
filter_release_tags() {
    local t
    while IFS= read -r t; do
        [[ -z "$t" ]] || ! is_release_tag "$t" || printf '%s\n' "$t"
    done
}
# The newest release tag pointing at a commit, if any.
release_tag_at() {
    git tag --points-at "$1" --sort=-v:refname -l 'v*' 2>/dev/null | filter_release_tags | head -1
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
    # A status that could not read the host stops here (exit 1); the live check would repeat it.
    if [[ "$rc" -ne 0 ]]; then
        echo; echo "verify: not run (a status probe failed)"
        return 1
    fi
    # The live check closes every --status: the selected modules must serve origin/main itself.
    local want_static="" want_backstage="" want_tag=no release=yes vrc=0
    for m in "${MODULES[@]}"; do
        case "$m" in
            static) want_static="${MAIN_SHA:-origin/main-unresolved}" ;;
            backstage) want_backstage="${MAIN_SHA:-origin/main-unresolved}"; release="$(backstage_release_state)" ;;
        esac
    done
    [[ "$MODULE" != all ]] || want_tag=yes
    closing_verify "$want_static" "$want_backstage" "$want_tag" "$release" || vrc=6
    [[ "$drifted" -eq 0 ]] || return 3
    return "$vrc"
}

if [[ "$ACTION" == status ]]; then
    run_status
    exit $?
fi

# ------------------------------------------------------------------ live verify (read-only)
if [[ "$ACTION" == verify ]]; then
    load_config
    refresh_main || log_warn "Could not fetch origin/main; using the local origin/main ref."
    want="${VERIFY_SHA:-$MAIN_SHA}"
    if [[ -z "$want" ]]; then
        log_error "origin/main could not be resolved and no SHA was given; nothing to verify against."
        exit 6
    fi
    verify_live "$want" "$want" yes yes || exit 6
    exit 0
fi

# ------------------------------------------------------------------ release record
yaml_quote() { local s="$1"; s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; printf '"%s"' "$s"; }
# A plain token is emitted bare; anything else is quoted.
yaml_value() {
    if [[ "$1" =~ ^[A-Za-z0-9._/+-]+$ ]]; then printf '%s' "$1"; else yaml_quote "$1"; fi
}
# A command line safe to paste: every argument shell-quoted.
quoted_cmd() {
    local out="" a
    for a in "$@"; do out="${out}${out:+ }$(printf '%q' "$a")"; done
    printf '%s' "$out"
}

# "#N title" per first-parent commit in the range: squash subjects ending "(#N)" and
# "Merge pull request #N from ..." (title = first body line). Fails when git log fails.
pr_lines() {
    local h subj body n re_squash='\(#([0-9]+)\)$' re_merge='^Merge pull request #([0-9]+) from'
    git log --first-parent --format='%H' "$@" | while IFS= read -r h; do
        subj="$(git log -1 --format=%s "$h")" || exit 1
        if [[ "$subj" =~ $re_squash ]]; then
            printf '#%s %s\n' "${BASH_REMATCH[1]}" "${subj% (#*)}"
        elif [[ "$subj" =~ $re_merge ]]; then
            n="${BASH_REMATCH[1]}"
            body="$(git log -1 --format=%b "$h" | sed -n '/[^[:space:]]/{p;q;}')" || exit 1
            printf '#%s %s\n' "$n" "${body:-$subj}"
        fi
    done
}

# vYYYY.MM.DD.N, UTC date, N = 1 + count of existing release tags for that date (skipping any
# taken name).
next_version() {
    local d n
    d="$(date -u +%Y.%m.%d)"
    n="$(git tag -l "v${d}.*" | filter_release_tags | grep -c . || true)"
    n=$((n + 1))
    while git rev-parse -q --verify "refs/tags/v${d}.${n}" >/dev/null 2>&1; do n=$((n + 1)); done
    printf 'v%s.%s\n' "$d" "$n"
}

# The newest release tag reachable from S that does not point at S itself.
previous_tag() {
    local sha="$1" t
    while IFS= read -r t; do
        if [[ "$(git rev-parse "${t}^{commit}" 2>/dev/null)" != "$sha" ]]; then printf '%s\n' "$t"; return 0; fi
    done < <(git tag --merged "$sha" --sort=-v:refname -l 'v*' 2>/dev/null | filter_release_tags)
}

release_yaml() {
    local version="$1" sha="$2" prev="$3" line prs
    if [[ -n "$prev" ]]; then prs="$(pr_lines "${prev}..${sha}")" || return 1
    else prs="$(pr_lines "$sha")" || return 1; fi
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

# Records S as a release: a local annotated CalVer tag, the same tag on origin, and the GitHub
# release, each checked and created independently, so a rerun finishes whatever is missing.
# Returns 5 on any failure, after printing the exact (quoted) command that finishes the job.
# Never touches the deployed modules.
release_record() {
    local sha="$MAIN_SHA" version existing prev dir yaml msgfile notes push_cmd gh_cmd
    local local_obj local_peeled remote_out remote_obj remote_peeled gh_out gh_tag gh_target
    if ! $TAGS_FETCHED; then
        log_error "Deploy verified and live; release tags could not be fetched from origin, so the version and previous_tag cannot be trusted. Re-run .deploy/ship.sh once origin is reachable: modules already at origin/main are skipped."
        return 5
    fi
    existing="$(release_tag_at "$sha")"
    if [[ -n "$existing" ]]; then version="$existing"; else version="$(next_version)"; fi
    prev="$(previous_tag "$sha")"
    # Private per-run directory; kept on failure because the recovery command names its files.
    dir="$(mktemp -d "${TMPDIR:-/tmp}/jevnotjev-release.XXXXXX")" \
        || { log_error "Deploy verified and live; cannot create a private release directory under ${TMPDIR:-/tmp}. Nothing tagged."; return 5; }
    msgfile="${dir}/tag-message.txt"; notes="${dir}/notes.md"
    yaml="$(release_yaml "$version" "$sha" "$prev")" && [[ -n "$yaml" ]] \
        || { log_error "Deploy verified and live; generating the release metadata failed. Nothing tagged."; return 5; }
    printf 'Release %s\n\n%s\n' "$version" "$yaml" > "$msgfile" \
        && release_notes "$version" "$sha" "$prev" "$yaml" > "$notes" \
        || { log_error "Deploy verified and live; writing the release metadata to ${dir} failed. Nothing tagged."; return 5; }
    push_cmd="$(quoted_cmd git push origin "refs/tags/${version}")"
    gh_cmd="$(quoted_cmd gh release create "$version" --verify-tag --title "$version" --notes-file "$notes")"

    if [[ -n "$existing" ]]; then
        echo "release: ${version} already tags ${sha}; checking origin and the GitHub release"
    else
        if ! git tag -a "$version" "$sha" --cleanup=verbatim -F "$msgfile"; then
            log_error "Deploy verified and live; creating tag ${version} failed. Finish with:"
            echo "  $(quoted_cmd git tag -a "$version" "$sha" --cleanup=verbatim -F "$msgfile") && ${push_cmd} && ${gh_cmd}" >&2
            return 5
        fi
        echo "release: tagged ${version} on ${sha} (previous: ${prev:-none})"
    fi

    # The NAME on origin is not enough: its tag object must be ours and peel to S. A same-named
    # tag created elsewhere after our tag fetch must never get these release notes.
    local_obj="$(git rev-parse -q --verify "refs/tags/${version}" 2>/dev/null)"
    local_peeled="$(git rev-parse -q --verify "refs/tags/${version}^{commit}" 2>/dev/null)"
    if [[ -z "$local_obj" || "$local_peeled" != "$sha" ]]; then
        log_error "Deploy verified and live; local tag ${version} peels to '${local_peeled:-none}', not ${sha}. Refusing to publish."
        return 5
    fi
    remote_out="$(git ls-remote origin "refs/tags/${version}" "refs/tags/${version}^{}")" || {
        log_error "Deploy verified and live; cannot ask origin whether ${version} exists. Finish with:"
        echo "  ${push_cmd} && ${gh_cmd}" >&2
        return 5
    }
    remote_obj="$(printf '%s\n' "$remote_out" | awk -v r="refs/tags/${version}" '$2 == r {print $1}')"
    remote_peeled="$(printf '%s\n' "$remote_out" | awk -v r="refs/tags/${version}^{}" '$2 == r {print $1}')"
    if [[ -z "$remote_obj" ]]; then
        if ! git push origin "refs/tags/${version}"; then
            log_error "Deploy verified and live; pushing tag ${version} failed. Finish with:"
            echo "  ${push_cmd} && ${gh_cmd}" >&2
            return 5
        fi
    elif [[ "$remote_obj" != "$local_obj" || "$remote_peeled" != "$sha" ]]; then
        log_error "Deploy verified and live; origin already has ${version} as tag object ${remote_obj} on commit ${remote_peeled:-none}, but this release is tag object ${local_obj} on ${sha}. Refusing to push or publish; resolve the tag by hand."
        return 5
    else
        echo "release: ${version} is on origin (tag ${remote_obj}, commit ${sha})"
    fi

    # An existing GitHub release must answer for this tag; a SHA target must be S.
    if gh_out="$(gh release view "$version" --json tagName,targetCommitish --jq '.tagName + " " + .targetCommitish' 2>/dev/null)"; then
        gh_tag="${gh_out%% *}"; gh_target="${gh_out#* }"
        if [[ "$gh_tag" != "$version" ]] || { [[ "$gh_target" =~ ^[0-9a-f]{40}$ ]] && [[ "$gh_target" != "$sha" ]]; }; then
            log_error "Deploy verified and live; the GitHub release for ${version} answers tag '${gh_tag}' target '${gh_target}', not ${version} at ${sha}. Refusing; resolve the release by hand."
            return 5
        fi
        echo "release: GitHub release ${version} exists (target ${gh_target})"
    elif ! gh release create "$version" --verify-tag --title "$version" --notes-file "$notes"; then
        log_error "Deploy verified and live; tag ${version} is on origin; the GitHub release failed. Finish with:"
        echo "  ${gh_cmd}" >&2
        return 5
    else
        echo "release: published ${version}"
    fi
    rm -rf "$dir"
}

# A module is current only when every observation names origin/main: the served SHA, the
# verified current release, and that release's own identity (static: its DEPLOYED_SHA marker;
# backstage: the release directory named by its SHA).
module_current() {
    local m="$1"
    [[ -n "$MAIN_SHA" && "$(getv "$m" served)" == "$MAIN_SHA" && "$(getv "$m" verified)" == yes ]] || return 1
    case "$m" in
        static) [[ "$(getv static marker)" == "$MAIN_SHA" ]] ;;
        backstage) [[ "$(getv backstage current)" == "/var/www/jevnotjev-backstage-releases/${MAIN_SHA}" ]] ;;
        *) return 1 ;;
    esac
}

# ------------------------------------------------------------------ ship lock
# One host lock for a whole deploy or rollback: every state read, module deploy, final check
# and release record happens under it, so the recorded stack existed as one state.
SHIP_LOCK=/var/lock/jevnotjev-ship
LOCKED=false
release_ship_lock() {
    $LOCKED || return 0
    LOCKED=false
    remote "rmdir ${SHIP_LOCK}" >/dev/null 2>&1 || log_error "Could not remove ${SHIP_LOCK} on the host; inspect it before the next deploy."
}
take_ship_lock() {
    if ! remote "mkdir ${SHIP_LOCK}" >/dev/null 2>&1; then
        log_error "Cannot take ${SHIP_LOCK} on the host: another ship.sh deploy or rollback holds it, or the host is unreachable. Refusing; inspect it before retrying."
        exit 1
    fi
    LOCKED=true
    trap 'rc=$?; release_ship_lock; exit $rc' EXIT
}

if [[ "$ACTION" == rollback ]] && ! $DRY_RUN; then
    load_config
    take_ship_lock
fi

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
    # Checked here, not only in the module scripts: skipped modules never run their own guard.
    if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
        msg="Uncommitted tracked changes present. The release records origin/main; deploy from a clean worktree."
        if $DRY_RUN; then log_warn "${msg} (dry-run, not blocking)"; else log_error "$msg"; exit 1; fi
    fi
    $DRY_RUN || take_ship_lock
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
        if module_current "$m"; then
            row "$m" "up to date (serving ${served:0:7} from its verified release)"
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
    [[ "$FINAL_RC" -eq 0 ]] && ! $DRY_RUN || exit "$FINAL_RC"
    # Setup and rollback close with the live check. Setup asserts no SHA (it ships no release);
    # a rollback asserts the SHA it rolled back to.
    load_config
    want_static=""; want_backstage=""; release=yes
    read_backstage >/dev/null 2>&1 || true
    release="$(backstage_release_state)"
    if [[ "$ACTION" == rollback && "$MODULE" == static ]]; then
        read_static >/dev/null 2>&1 || true
        want_static="$(getv static marker)"
        [[ -n "$want_static" ]] || want_static="unreadable-release-marker"
    elif [[ "$ACTION" == rollback && "$MODULE" == backstage ]]; then
        want_backstage="$ROLLBACK_SHA"
    fi
    closing_verify "$want_static" "$want_backstage" no "$release" || exit 6
    exit 0
fi

if $DRY_RUN; then
    summary
    if [[ "$MODULE" == all && "$NO_RELEASE" == false && -n "$MAIN_SHA" ]]; then
        existing="$(release_tag_at "$MAIN_SHA")"
        if ! $TAGS_FETCHED; then
            echo "release: would refuse (exit 5): release tags could not be fetched from origin"
        elif [[ -n "$existing" ]]; then
            echo "release: ${existing} already tags ${MAIN_SHA}; would check origin and the GitHub release"
        else
            v="$(next_version)"
            p="$(previous_tag "$MAIN_SHA")"
            echo "release: would create tag ${v} on ${MAIN_SHA} (previous: ${p:-none}), push refs/tags/${v}, gh release create ${v} --verify-tag"
        fi
    fi
    exit 0
fi

# Every deployed module must now be current at origin/main; for the full stack, every module.
post_ok=true
for m in "${MODULES[@]}"; do
    read_state "$m" || true
    if ! module_current "$m"; then
        log_error "${m} is not serving origin/main from its verified release after the deploy: served $(getv "$m" served), release $(getv "$m" current), main ${MAIN_SHA}"
        post_ok=false
    fi
done
summary
$post_ok || exit 1

want_tag=no
if [[ "$MODULE" == all && "$NO_RELEASE" == false ]]; then
    release_record || exit 5
    want_tag=yes
fi

# The deploy closes with the live check: the deployed modules serve origin/main, the gate holds,
# the public paths answer, and (full stack) the release tag is on origin.
want_static=""; want_backstage=""
for m in "${MODULES[@]}"; do
    case "$m" in
        static) want_static="$MAIN_SHA" ;;
        backstage) want_backstage="$MAIN_SHA" ;;
    esac
done
closing_verify "$want_static" "$want_backstage" "$want_tag" yes || exit 6
exit 0
