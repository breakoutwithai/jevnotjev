#!/usr/bin/env bash
# Host-side Backstage restart and activity monitor. Bash 3.2 compatible.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/monitor-lib.sh"
MONITOR_DRY_RUN=no
case "${1:-}" in --dry-run) MONITOR_DRY_RUN=yes;; '') ;; *) echo 'usage: monitor-host.sh [--dry-run]' >&2; exit 2;; esac
[[ "$#" -le 1 ]] || exit 2
monitor_config || exit 2
monitor_state_init host; init_rc=$?
[[ "$init_rc" -eq 0 ]] || { [[ "$init_rc" -eq 3 ]] && exit 0; exit 2; }
unit="${MONITOR_UNIT:-jevnotjev-backstage}"
show="$(systemctl show "$unit" -p ActiveState -p Restart -p NRestarts 2>/dev/null)"; show_rc=$?
active="$(printf '%s\n' "$show" | sed -n 's/^ActiveState=//p')"
restart="$(printf '%s\n' "$show" | sed -n 's/^Restart=//p')"
n="$(printf '%s\n' "$show" | sed -n 's/^NRestarts=//p')"
failed=0
if [[ "$show_rc" -ne 0 || $(printf '%s\n' "$show" | grep -Ec '^(ActiveState|Restart|NRestarts)=') -ne 3 || ! "$n" =~ ^[0-9]+$ ]]; then
    echo 'FAIL H1-H3 unparseable systemctl output'; failed=1
else
    if [[ "$restart" == on-failure || "$restart" == always ]]; then echo "PASS H1 Restart=${restart}"; else echo "FAIL H1 Restart=${restart}"; failed=1; fi
    if [[ "$active" == active ]]; then echo 'PASS H2 ActiveState=active'; else echo "FAIL H2 ActiveState=${active}"; failed=1; fi
    previous=""
    [[ ! -r "$MONITOR_DIR/nrestarts" ]] || read -r previous < "$MONITOR_DIR/nrestarts" || true
    if [[ -n "$previous" && ! "$previous" =~ ^[0-9]+$ ]]; then
        echo 'FAIL H3 invalid stored NRestarts'; failed=1
    elif [[ -n "$previous" && "$n" -gt "$previous" ]]; then
        echo "FAIL H3 NRestarts grew ${previous} to ${n}"; failed=1
    else
        echo "PASS H3 NRestarts=${n} (baseline or no growth)"
    fi
    (umask 077; printf '%s\n' "$n" > "$MONITOR_DIR/nrestarts.tmp") && mv -f "$MONITOR_DIR/nrestarts.tmp" "$MONITOR_DIR/nrestarts" || { echo 'FAIL H3 baseline write'; failed=1; }
fi
if [[ "$failed" -eq 0 ]]; then monitor_transition yes 'jevnotjev Backstage service recovered' || exit 1; exit 0; fi
monitor_transition no 'jevnotjev Backstage restart or service check failed' || exit 1
exit 1
