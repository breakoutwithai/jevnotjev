#!/usr/bin/env bash
# Sourced only by test fixtures (#240). Never inherit another checkout's Git destinations.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR

fixture_refuse() { echo "fixture safety: $*" >&2; return 1; }

# Check canonical paths before init/clone can write. The root is an owned mktemp directory;
# neither its spelling nor a symlink below it may authorize a destination outside that root.
fixture_assert_destination() {
    local root="$1" target="$2" canonical_root canonical_target parent leaf
    [[ "$root" == /* && "$root" != / && -d "$root" && -O "$root" && ! -L "$root" ]] \
        || { fixture_refuse "root is not an owned, direct temporary directory: $root"; return 1; }
    canonical_root="$(cd "$root" && pwd -P)" || return 1
    [[ "$target" == /* && ! -L "$target" ]] \
        || { fixture_refuse "destination must be absolute and not a symlink: $target"; return 1; }
    if [[ -e "$target" ]]; then
        [[ -d "$target" ]] || { fixture_refuse "destination is not a directory: $target"; return 1; }
        canonical_target="$(cd "$target" && pwd -P)" || return 1
    else
        parent="$(dirname "$target")"; leaf="$(basename "$target")"
        [[ "$leaf" != . && "$leaf" != .. && -d "$parent" ]] \
            || { fixture_refuse "destination parent does not exist: $target"; return 1; }
        parent="$(cd "$parent" && pwd -P)" || return 1
        canonical_target="${parent}/${leaf}"
    fi
    case "$canonical_target" in
        "$canonical_root"/*) return 0 ;;
        *) fixture_refuse "destination escaped owned root: $target"; return 1 ;;
    esac
}

# rev-parse can follow a .git symlink/file or repository discovery into another checkout.
# Resolve its actual directory, then refuse before the caller makes any config/ref write.
fixture_assert_repository() {
    local root="$1" target="$2" gitdir common canonical_root
    fixture_assert_destination "$root" "$target" || return 1
    gitdir="$(git -C "$target" rev-parse --absolute-git-dir 2>/dev/null)" \
        || { fixture_refuse "destination has no repository: $target"; return 1; }
    gitdir="$(cd "$gitdir" && pwd -P)" || return 1
    canonical_root="$(cd "$root" && pwd -P)" || return 1
    case "$gitdir" in
        "$canonical_root"/*) ;;
        *) fixture_refuse "gitdir escaped owned root: $gitdir"; return 1 ;;
    esac
    common="$(git -C "$target" rev-parse --git-common-dir 2>/dev/null)" \
        || { fixture_refuse "cannot resolve common directory: $target"; return 1; }
    case "$common" in /*) ;; *) common="$target/$common" ;; esac
    common="$(cd "$common" && pwd -P)" || return 1
    case "$common" in
        "$canonical_root"/*) return 0 ;;
        *) fixture_refuse "common directory escaped owned root: $common"; return 1 ;;
    esac
}

fixture_init() {
    local root="$1" target="$2" option
    shift 2
    for option in "$@"; do
        case "$option" in
            --bare|--initial-branch=main) ;;
            *) fixture_refuse "unsupported init option: $option"; return 1 ;;
        esac
    done
    fixture_assert_destination "$root" "$target" || return 1
    # An existing .git entry must be contained before git init can reinitialize it.
    if [[ -e "$target/.git" || -L "$target/.git" || -f "$target/HEAD" ]]; then
        fixture_assert_repository "$root" "$target" || return 1
    fi
    git -C "$(dirname "$target")" init -q --template= "$@" "$target" || return 1
    fixture_assert_repository "$root" "$target"
}

fixture_clone() {
    local root="$1" source="$2" target="$3"
    fixture_assert_destination "$root" "$target" || return 1
    [[ ! -e "$target" && ! -L "$target" ]] \
        || { fixture_refuse "clone destination already exists: $target"; return 1; }
    git -C "$root" clone -q --no-hardlinks "$source" "$target" || return 1
    fixture_assert_repository "$root" "$target"
}
