#!/usr/bin/env bash
# [T1] The branch guard gates on COMMIT IDENTITY, and verify_head_is_remote_main fails closed.
#
# Ported from lakelife .deploy/tests/branch-guard.test.sh and rollback.test.sh (13a-13d).
# EXECUTES the guard block extracted from deploy.sh, and the real lib.sh function, against
# throwaway git repositories. Hermetic: no ssh, no network (origin is a local directory).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
pass=0; fail=0
ok()   { echo "  ok   - $1"; pass=$((pass+1)); }
nope() { echo "  FAIL - $1"; fail=$((fail+1)); }

echo "[T1] branch guard + origin/main verification"

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

# The promotion block verbatim from deploy.sh. Extracted, never reimplemented, so a drift in
# the shipped code is what gets tested.
guard_block="$(awk '/^if \[\[ "\$BRANCH" != "\$ALLOWED_BRANCH" \]\]; then$/ { on=1 } on { print } on && /^fi$/ { exit }' .deploy/deploy.sh)"
if [[ -n "$guard_block" ]]; then
    ok "the promotion block is extractable from deploy.sh"
else
    nope "could not extract the promotion block - the guard may have been rewritten"
fi

make_upstream() {
    # $1 = dir. Two commits on main.
    git init -q --initial-branch=main --template= "$1"
    ( cd "$1" && echo one > f && git add f && git -c commit.gpgsign=false commit -qm one \
      && echo two > f && git add f && git -c commit.gpgsign=false commit -qm two )
}

run_guard_at() {
    local checkout="$1" tmp
    tmp="$(mktemp -d)"
    (
        cd "$tmp" || exit 1
        make_upstream upstream >/dev/null 2>&1
        git clone -q upstream work 2>/dev/null
        cd work || exit 1
        case "$checkout" in
            at-main) git checkout -q --detach origin/main ;;
            older)   git checkout -q --detach origin/main~1 ;;
            feature) git checkout -q -b feature-x origin/main ;;
            feature-ahead)
                git checkout -q -b feature-x origin/main && echo ahead > g && git add g \
                    && git -c commit.gpgsign=false commit -qm ahead ;;
            feature-older) git checkout -q -b feature-x origin/main~1 ;;
        esac
        BRANCH="$(git rev-parse --abbrev-ref HEAD)"
        SHA="$(git rev-parse HEAD)"
        SHORT_SHA="$(git rev-parse --short HEAD)"
        ALLOWED_BRANCH=main
        log_info() { :; }
        eval "$guard_block"
        echo "RESOLVED=${BRANCH}"
    ) 2>/dev/null
    rm -rf "$tmp"
}

r="$(run_guard_at at-main)"
[[ "$r" == "RESOLVED=main" ]] \
    && ok "detached HEAD AT origin/main resolves to 'main' (deploy proceeds)" \
    || nope "detached HEAD at origin/main resolved to '${r#RESOLVED=}', expected main"

r="$(run_guard_at older)"
[[ "$r" == "RESOLVED=HEAD" ]] \
    && ok "detached HEAD at an OLDER commit stays 'HEAD' (deploy refuses)" \
    || nope "an older detached commit resolved to '${r#RESOLVED=}' - it would have deployed"

r="$(run_guard_at feature)"
[[ "$r" == "RESOLVED=main" ]] \
    && ok "a NAMED branch whose HEAD is exactly fresh origin/main resolves to 'main' (wt.sh worktree deploys)" \
    || nope "named branch at origin/main resolved to '${r#RESOLVED=}', expected main"

r="$(run_guard_at feature-ahead)"
[[ "$r" == "RESOLVED=feature-x" ]] \
    && ok "a named branch AHEAD of origin/main stays 'feature-x' (deploy refuses)" \
    || nope "a named branch ahead of main resolved to '${r#RESOLVED=}' - it would have deployed"

r="$(run_guard_at feature-older)"
[[ "$r" == "RESOLVED=feature-x" ]] \
    && ok "a named branch BEHIND origin/main stays 'feature-x' (deploy refuses)" \
    || nope "a named branch behind main resolved to '${r#RESOLVED=}' - it would have deployed"

awk '!/^[[:space:]]*#/ && /verify_head_is_remote_main/ {f=1} END {exit !f}' .deploy/deploy.sh \
    && ok "deploy.sh still calls verify_head_is_remote_main after the guard" \
    || nope "verify_head_is_remote_main is not called - the name guard is the only check"

grep -q 'git worktree add' .deploy/deploy.sh \
    && ok "the refusal message names the clean-worktree procedure" \
    || nope "the refusal does not tell the operator the correct path"

# Behavioural: a real --dry-run from a feature branch of a throwaway copy of THIS repo's .deploy
# must refuse with the branch message (the dry-run flag does not bypass the name guard), unless
# the named branch sits exactly on origin/main.
dry_run_on_branch() {
    # $1 = ahead|at-main. Prints deploy.sh output, then "RC=<rc>".
    local tmp out rc
    tmp="$(mktemp -d)"
    (
        cd "$tmp" || exit 1
        make_upstream upstream >/dev/null 2>&1
        git clone -q upstream work 2>/dev/null
        cd work || exit 1
        git checkout -q -b feature-y
        if [[ "$1" == ahead ]]; then
            echo ahead > g && git add g && git -c commit.gpgsign=false commit -qm ahead
        fi
    ) >/dev/null 2>&1
    cp -R .deploy "$tmp/work/.deploy"
    out="$(cd "$tmp/work" && TMPDIR="$tmp" JEVNOTJEV_SSH_KEY=/nonexistent /bin/bash .deploy/deploy.sh --dry-run 2>&1)"; rc=$?
    rm -rf "$tmp"
    printf '%s\nRC=%s\n' "$out" "$rc"
}
out="$(dry_run_on_branch ahead)"; rc="${out##*RC=}"
if [[ "$rc" != 0 && "$out" == *"Refusing to deploy from 'feature-y'"* ]]; then
    ok "deploy.sh --dry-run on a feature branch ahead of main refuses (rc=${rc})"
else
    nope "deploy.sh --dry-run on a feature branch did not refuse: rc=${rc}, out: $(printf '%s' "$out" | tail -3)"
fi
out="$(dry_run_on_branch at-main)"
if [[ "$out" != *"Refusing to deploy from"* && "$out" == *"treating as 'main'"* ]]; then
    ok "deploy.sh --dry-run on a named branch at origin/main passes the branch guard"
else
    nope "named branch at origin/main was refused by the branch guard: $(printf '%s' "$out" | tail -3)"
fi

# ------------------------------------------------ verify_head_is_remote_main (real lib.sh)
log_info()    { :; }
log_success() { :; }
log_warn()    { echo "[WARN] $1"; }
log_error()   { echo "[FAIL] $1" >&2; }
remote()      { return 1; }
source .deploy/lib.sh

setup_origin_fixture() {
    ORIGIN_DIR="$(mktemp -d)"; CLONE_DIR="$(mktemp -d)"
    make_upstream "$ORIGIN_DIR/r" >/dev/null 2>&1
    git clone -q "$ORIGIN_DIR/r" "$CLONE_DIR/w" 2>/dev/null
    CLONE_DIR="$CLONE_DIR/w"
}
teardown_origin_fixture() { rm -rf "${ORIGIN_DIR:-/nonexistent}" "$(dirname "${CLONE_DIR:-/nonexistent/x}")"; }

setup_origin_fixture
sha="$(git -C "$CLONE_DIR" rev-parse HEAD)"
rm -rf "$ORIGIN_DIR"
if (cd "$CLONE_DIR" && verify_head_is_remote_main "$sha" main main false >/dev/null 2>&1); then
    nope "fetch failed but verify_head_is_remote_main returned success (fail-open)"
else
    ok "fetch fails, real run -> refuses"
fi
teardown_origin_fixture

setup_origin_fixture
(cd "$CLONE_DIR" && echo three > g && git add g && git -c commit.gpgsign=false commit -qm three) >/dev/null 2>&1
sha="$(git -C "$CLONE_DIR" rev-parse HEAD)"
if (cd "$CLONE_DIR" && verify_head_is_remote_main "$sha" main main false >/dev/null 2>&1); then
    nope "HEAD ahead of origin/main but verify_head_is_remote_main returned success"
else
    ok "fetch OK, HEAD != origin/main -> refuses"
fi
teardown_origin_fixture

setup_origin_fixture
sha="$(git -C "$CLONE_DIR" rev-parse HEAD)"
if (cd "$CLONE_DIR" && verify_head_is_remote_main "$sha" main main false >/dev/null 2>&1); then
    ok "fetch OK, HEAD == origin/main -> proceeds"
else
    nope "HEAD matches origin/main but verify_head_is_remote_main refused"
fi
teardown_origin_fixture

setup_origin_fixture
sha="$(git -C "$CLONE_DIR" rev-parse HEAD)"
rm -rf "$ORIGIN_DIR"
out="$(cd "$CLONE_DIR" && verify_head_is_remote_main "$sha" main main true 2>&1)"; rc=$?
if [[ $rc -eq 0 && "$out" == *WARN* ]]; then
    ok "fetch fails, dry-run -> warns and proceeds"
else
    nope "dry-run with a failed fetch did not warn-and-proceed: rc=${rc}"
fi
teardown_origin_fixture

setup_origin_fixture
(cd "$CLONE_DIR" && git checkout -q -b hotfix && echo four > h && git add h && git -c commit.gpgsign=false commit -qm four) >/dev/null 2>&1
sha="$(git -C "$CLONE_DIR" rev-parse HEAD)"
if (cd "$CLONE_DIR" && verify_head_is_remote_main "$sha" hotfix main false >/dev/null 2>&1); then
    nope "DEPLOY_ALLOW_BRANCH path accepted an unpushed commit"
else
    ok "DEPLOY_ALLOW_BRANCH path refuses a commit that exists on no remote branch"
fi
teardown_origin_fixture

echo "[T1] passed=${pass} failed=${fail}"
[[ $fail -eq 0 ]]
