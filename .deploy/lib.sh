#!/usr/bin/env bash
#
# lib.sh - the swap / rollback / prune / guard / neighbour mechanism, kept out of deploy.sh so
# the tests drive the REAL functions. Every remote action goes through `remote`, which config.sh
# defines as ssh in production and the tests override to act on a local fixture directory.
#
# Sourced after config.sh (needs remote, log_*, HEALTH_URL, CURL_PIN). Do not execute directly.
# Bash 3.2 compatible: no mapfile, no associative arrays, no ${var,,}.
set -uo pipefail

# activate_release - atomic symlink swap. `ln -sfn` writes a temp link, `mv -T` renames it over
# the live path; rename(2) is atomic. Callers set ACTIVATED=true BEFORE calling this, so a
# connection dropped after the remote mv ran still leaves the EXIT trap armed.
activate_release() {
    local release_dir="$1" deploy_path="$2"
    remote "ln -sfn ${release_dir} ${deploy_path}.new && mv -T ${deploy_path}.new ${deploy_path}"
}

# live_release - ask the BOX what is served. Empty output means UNKNOWN (unreachable or not a
# symlink), never "nothing to restore".
live_release() {
    local deploy_path="$1"
    remote "readlink ${deploy_path} 2>/dev/null || true" 2>/dev/null | tr -d '[:space:]'
}

# rollback_release - restore the previous release after a failed post-activation step, but only
# after confirming via live_release that the box is on the release we think we activated.
# Args: rc previous_release previous_sha deploy_path release_dir. Returns rc unchanged.
rollback_release() {
    local rc="$1" previous_release="$2" previous_sha="$3" deploy_path="$4" release_dir="$5"

    [[ "$rc" -eq 0 ]] && return 0

    local live
    live="$(live_release "$deploy_path")"
    if [[ -z "$live" ]]; then
        log_error "Cannot determine what ${deploy_path} is actually serving (box unreachable)."
        log_error "BOX STATE UNKNOWN. It may be on ${release_dir} (unverified) or something else entirely."
        log_error "Manual check required: ssh in and run 'readlink ${deploy_path}' before trusting anything."
        return "$rc"
    fi

    if [[ "$live" != "$release_dir" ]]; then
        log_warn "Live release is '${live}', not '${release_dir}' - nothing to restore against that assumption."
        return "$rc"
    fi

    if [[ -z "$previous_release" ]]; then
        log_error "Deploy failed after activation and there is NO previous release to restore."
        log_error "The box is serving ${release_dir}, which did not verify. Fix forward or restore by hand."
        return "$rc"
    fi

    log_warn "Deploy failed after activation - restoring ${previous_release}"
    if activate_release "$previous_release" "$deploy_path" 2>/dev/null; then
        # Prove the restore: positive match on the previous release's own marker, curl --fail so
        # an error page is an error rather than a non-empty body.
        local back
        back="$(curl -sS --fail --max-time 15 ${CURL_PIN} "${HEALTH_URL}/DEPLOYED_SHA" 2>/dev/null | tr -d '[:space:]' || true)"
        if [[ -n "$previous_sha" && "$back" == "$previous_sha" ]]; then
            log_success "Rolled back to ${previous_release} (serving ${back:0:7}, matches its marker)"
        elif [[ -z "$previous_sha" ]]; then
            log_warn "Restored the ${previous_release} symlink, but it has no DEPLOYED_SHA marker to verify against. CHECK THE SITE."
        else
            log_error "Rollback ran but the site serves '${back:-<none>}', expected '${previous_sha}'. INVESTIGATE NOW."
        fi
    else
        log_error "ROLLBACK FAILED. The box is serving a release that did not verify: ${release_dir}"
        log_error "Restore by hand: ln -sfn ${previous_release} ${deploy_path}.rb && mv -T ${deploy_path}.rb ${deploy_path}"
    fi
    return "$rc"
}

# prune_release_list - pure. Given release NAMES newest first, print the ones to delete: never
# the active or previous release, then keep the newest $keep of the rest.
prune_release_list() {
    local keep="$1" active="$2" previous="$3"
    shift 3
    local -a candidates=()
    local name
    for name in "$@"; do
        [[ -n "$active" && "$name" == "$active" ]] && continue
        [[ -n "$previous" && "$name" == "$previous" ]] && continue
        candidates+=("$name")
    done
    local i=0
    for name in ${candidates[@]+"${candidates[@]}"}; do
        i=$((i+1))
        [[ $i -gt $keep ]] && printf '%s\n' "$name"
    done
}

# manifest_served_paths MANIFEST - the URL paths the static deploy must see served: the root plus
# every manifest file except the Backstage module's (BACKSTAGE_SITE_PREFIX), which nginx routes to
# the Backstage service behind Basic Auth and so answers 401 here.
manifest_served_paths() {
    printf '/\n'
    printf '%s\n' "$1" | grep -v "^${BACKSTAGE_SITE_PREFIX}" | sed 's|^|/|' || true
}

# verify_served_paths MANIFEST - curl each served path (pinned); return 1 if any is not 200.
verify_served_paths() {
    local path code ok=true
    for path in $(manifest_served_paths "$1"); do
        code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 ${CURL_PIN} "${HEALTH_URL}${path}" 2>/dev/null || true)"; code="${code:-000}"
        if [[ "$code" == "200" ]]; then
            log_success "${path} -> 200"
        else
            log_error "${path} -> ${code}"
            ok=false
        fi
    done
    $ok
}

# release_is_verified - a release qualifies as a rollback target only if a deploy verified it
# end to end (served SHA, every path, co-tenants unchanged). DEPLOYED_SHA alone is written
# before activation, so a failed or half-staged release carries it too.
release_is_verified() { remote "test -f ${1}/DEPLOYED_SHA && test -f ${1}/.verified" 2>/dev/null; }

# select_rollback_target - newest release other than the active one that has a DEPLOYED_SHA
# marker. has_marker_fn is a callback (name -> 0/1). Prints the name, or returns 1.
select_rollback_target() {
    local active="$1" has_marker_fn="$2"
    shift 2
    local name
    for name in "$@"; do
        [[ "$name" == "$active" ]] && continue
        if "$has_marker_fn" "$name"; then
            printf '%s\n' "$name"
            return 0
        fi
    done
    return 1
}

# verify_head_is_remote_main - ship only what origin/main points at. Fails CLOSED in a real
# deploy when origin/main cannot be fetched or resolved; downgrades to a warning under dry-run.
# Args: sha branch allowed_branch dry_run(true/false). Returns 0 proceed, 1 refuse.
verify_head_is_remote_main() {
    local sha="$1" branch="$2" allowed_branch="$3" dry_run="$4"

    local fetch_ok=true
    git fetch origin main --no-tags 2>/dev/null || fetch_ok=false
    local remote_main_sha=""
    if $fetch_ok; then
        remote_main_sha="$(git rev-parse origin/main 2>/dev/null || true)"
    fi

    local msg=""
    if [[ "$branch" == "$allowed_branch" ]]; then
        if ! $fetch_ok; then
            msg="Could not fetch origin/main - cannot verify HEAD (${sha}) is what main points at."
        elif [[ -z "$remote_main_sha" ]]; then
            msg="Fetched origin/main but 'git rev-parse origin/main' returned nothing - cannot verify HEAD (${sha})."
        elif [[ "$sha" != "$remote_main_sha" ]]; then
            msg="HEAD (${sha}) does not match origin/main (${remote_main_sha}). Refusing to deploy a commit main does not point at."
        else
            return 0
        fi
    else
        # DEPLOY_ALLOW_BRANCH path: the commit must at least exist on a remote branch.
        if ! $fetch_ok; then
            msg="Could not fetch origin/main - remote-tracking branches may be stale."
        elif [[ -n "$(git branch -r --contains "$sha" 2>/dev/null)" ]]; then
            return 0
        else
            msg="HEAD (${sha}) exists on no remote branch. Push it first - an unpushed commit must never ship."
        fi
    fi

    if [[ "$dry_run" == "true" ]]; then
        log_warn "$msg (dry-run, not blocking)"
        return 0
    fi
    log_error "$msg"
    return 1
}

# deploy_path_state - classify DEPLOY_PATH on the box. Prints one token:
#   OURS          a symlink into RELEASES_ROOT (normal state after the first deploy)
#   ABSENT        nothing there (first deploy)
#   FOREIGN_LINK  a symlink pointing anywhere else
#   FOREIGN       a real file or directory we did not create
#   UNKNOWN       the probe did not run (ssh failed)
# Returns 0 for OURS / ABSENT, 1 otherwise. Anything not ours must never be swapped over.
deploy_path_state() {
    local deploy_path="$1" releases_root="$2" token
    token="$(remote "if [ -L '${deploy_path}' ]; then t=\$(readlink '${deploy_path}'); case \"\$t\" in '${releases_root}'/*) echo OURS ;; *) echo FOREIGN_LINK ;; esac; elif [ -e '${deploy_path}' ]; then echo FOREIGN; else echo ABSENT; fi" 2>/dev/null | tr -d '[:space:]')"
    case "$token" in
        OURS|ABSENT) printf '%s\n' "$token"; return 0 ;;
        FOREIGN_LINK|FOREIGN) printf '%s\n' "$token"; return 1 ;;
        *) printf 'UNKNOWN\n'; return 1 ;;
    esac
}

# parse_server_names - read nginx config text on stdin, print each concrete server_name once.
# Drops comments, `_`, wildcards, regex names, and the domain passed as $1 (our own).
parse_server_names() {
    local own="${1:-}"
    awk -v own="$own" '
        { sub(/#.*/, "") }
        $1 == "server_name" {
            for (i = 2; i <= NF; i++) {
                n = $i; gsub(/;/, "", n)
                if (n == "" || n == "_" || n == own) continue
                if (n ~ /[*~]/ || n ~ /^\./) continue
                print n
            }
        }
    ' | sort -u
}

# list_neighbours - server_names enabled on the box right now, excluding our own domain.
list_neighbours() {
    local own="$1"
    remote "cat /etc/nginx/sites-enabled/* 2>/dev/null" 2>/dev/null | parse_server_names "$own"
}

# probe_neighbours - print "name code" per name, each curl pinned to the box's IP.
# Args: server_ip name...
probe_neighbours() {
    local ip="$1"; shift
    local name code
    for name in "$@"; do
        code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --resolve "${name}:443:${ip}" "https://${name}/" 2>/dev/null || true)"
        printf '%s %s\n' "$name" "${code:-000}"
    done
}

# neighbour_status_changes - compare two "name code" listings. Prints every name whose status
# changed or vanished, and returns 1 if there was any. Identical listings return 0.
neighbour_status_changes() {
    local before="$1" after="$2"
    { printf '%s\n' "$before" | sed '/^$/d; s/^/B /'; printf '%s\n' "$after" | sed '/^$/d; s/^/A /'; } \
    | awk '
        $1 == "B" { b[$2] = $3 }
        $1 == "A" { a[$2] = $3 }
        END {
            bad = 0
            for (n in b) {
                if (!(n in a)) { print n " " b[n] " -> <not probed>"; bad = 1 }
                else if (a[n] != b[n]) { print n " " b[n] " -> " a[n]; bad = 1 }
            }
            exit bad
        }'
}
