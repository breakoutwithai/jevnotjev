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
