#!/usr/bin/env bash
# Backstage-specific preconditions; sourced by deploy and tested with command doubles.
backstage_clean_sources() {
    local status
    status="$(git status --porcelain --untracked-files=all -- src site scripts .deploy package.json bun.lock tsconfig.json)" || return 1
    [[ -z "$status" ]]
}

# An empty SSH response is never evidence of an initial installation.
backstage_previous_release() {
    local current="$1" state target
    state="$(remote "if [ -L '${current}' ]; then target=\$(readlink '${current}') || exit 1; printf 'LINK:%s\\n' \"\$target\"; elif [ -e '${current}' ]; then printf 'FOREIGN\\n'; else printf 'ABSENT\\n'; fi")" || return 1
    case "$state" in
        ABSENT) return 0 ;;
        LINK:*)
            target="${state#LINK:}"
            [[ "$target" =~ ^/var/www/jevnotjev-backstage-releases/[a-f0-9]{40}$ ]] || return 1
            printf '%s\n' "$target"
            ;;
        *) return 1 ;;
    esac
}

# Called only after a failed initial activation, under the deployment lock.
# Verify ownership before stopping/removing anything; a new pointer must survive.
backstage_remove_failed_initial() {
    local current="$1" release="$2" stop_command="$3"
    remote "test -L '${current}' && test \"\$(readlink '${current}')\" = '${release}' && ${stop_command} && rm '${current}'"
}

# Never accept an unreachable neighbour as a stable baseline.
backstage_probe_neighbours() {
    local probes
    probes="$(probe_neighbours "$@")" || return 1
    [[ -n "$probes" ]] || return 1
    printf '%s\n' "$probes" | awk 'NF != 2 || $2 !~ /^[1-5][0-9][0-9]$/ { bad=1 } END { exit bad }' || return 1
    printf '%s\n' "$probes"
}

# Existing unsuccessful releases can be quarantined, but never a live or verified one.
# No release payload is deleted: interruptions leave an inspectable quarantine.
backstage_prepare_destination() {
    local release="$1" current="$2"
    remote "if [ -e '${release}' ]; then test ! -f '${release}/.verified' || exit 1; if [ -L '${current}' ]; then live=\$(readlink '${current}') || exit 1; test \"\$live\" != '${release}' || exit 1; elif [ -e '${current}' ]; then exit 1; fi; quarantine=\$(mktemp -d '${release}.failed-XXXXXX') && rmdir \"\$quarantine\" && mv '${release}' \"\$quarantine\"; fi"
}

# Credential file contents never enter command arguments or output.
backstage_curl() {
    if [[ -n "${BACKSTAGE_CURL_CONFIG:-}" ]]; then
        curl -q --config "$BACKSTAGE_CURL_CONFIG" "$@"
    else
        curl -q "$@"
    fi
}

backstage_list_neighbours() {
    local names
    names="$(list_neighbours "$1")" || return 1
    [[ -n "$names" ]] || return 1
    printf '%s\n' "$names"
}

backstage_check_curl_config() {
    [[ -n "${BACKSTAGE_CURL_CONFIG:-}" ]] || return 0
    bun -e 'import {statSync} from "node:fs";const s=statSync(process.argv[1]);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077)!==0)process.exit(1)' "$BACKSTAGE_CURL_CONFIG"
}
