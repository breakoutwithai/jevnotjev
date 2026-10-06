#!/usr/bin/env bash
# Shared state and alert delivery for the two one-shot monitors. Bash 3.2 compatible.

monitor_private_file() {
    [[ -n "$1" && -f "$1" && ! -L "$1" ]] || return 1
    bun -e 'import {lstatSync} from "node:fs";const s=lstatSync(process.argv[1]);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077)!==0)process.exit(1)' "$1" 2>/dev/null
}

monitor_credential_file() {
    [[ -n "$1" && -f "$1" && ! -L "$1" ]] || return 1
    bun -e 'import {lstatSync} from "node:fs";const s=lstatSync(process.argv[1]);if(!s.isFile()||(s.mode&0o007)!==0)process.exit(1)' "$1" 2>/dev/null
}

monitor_config() {
    case "${MONITOR_ALERT_KIND:-}" in teams|telegram) ;; *) echo 'CONFIG: MONITOR_ALERT_KIND must be teams or telegram' >&2; return 2;; esac
    if [[ -n "${CREDENTIALS_DIRECTORY:-}" ]]; then MONITOR_ALERT_CURL_CONFIG="${CREDENTIALS_DIRECTORY}/alert.curl"; fi
    if [[ -n "${MONITOR_ALERT_CURL_CONFIG:-}" ]]; then
        if [[ -n "${CREDENTIALS_DIRECTORY:-}" && "$MONITOR_ALERT_CURL_CONFIG" == "$CREDENTIALS_DIRECTORY/alert.curl" ]]; then
            monitor_credential_file "$MONITOR_ALERT_CURL_CONFIG" || { echo 'CONFIG: alert credential must be a regular non-symlink file without world access' >&2; return 2; }
        else
            monitor_private_file "$MONITOR_ALERT_CURL_CONFIG" || { echo 'CONFIG: MONITOR_ALERT_CURL_CONFIG must be a private regular file owned by the runner' >&2; return 2; }
        fi
    elif [[ "$MONITOR_DRY_RUN" != yes ]]; then
        echo 'CONFIG: MONITOR_ALERT_CURL_CONFIG is required' >&2; return 2
    fi
}

monitor_state_init() {
    local base="${MONITOR_STATE_DIR:-${STATE_DIRECTORY:-${XDG_STATE_HOME:-$HOME/.local/state}/jevnotjev-monitor}}"
    MONITOR_DIR="${base}/${1}"
    (umask 077; mkdir -p "$MONITOR_DIR") || { echo 'CONFIG: cannot create monitor state directory' >&2; return 2; }
    chmod 700 "$MONITOR_DIR" || return 2
    if ! ln -s "$$" "$MONITOR_DIR/lock" 2>/dev/null; then
        local owner=''
        owner="$(readlink "$MONITOR_DIR/lock" 2>/dev/null)" || true
        if [[ "$owner" =~ ^[0-9]+$ ]] && kill -0 "$owner" 2>/dev/null; then
            echo 'previous run active'
            return 3
        fi
        rm -f "$MONITOR_DIR/lock" 2>/dev/null || { echo 'previous run active'; return 3; }
        ln -s "$$" "$MONITOR_DIR/lock" 2>/dev/null || { echo 'previous run active'; return 3; }
    fi
    trap 'monitor_unlock' EXIT
}

monitor_unlock() {
    [[ "${BASH_SUBSHELL:-0}" -eq 0 ]] || return 0
    [[ "$(readlink "$MONITOR_DIR/lock" 2>/dev/null)" == "$$" ]] && rm -f "$MONITOR_DIR/lock"
    return 0
}

# Bash 3.2 compatible deadline for a single external command. The output file belongs to the caller.
monitor_deadline() {
    local output="$1" seconds="${MONITOR_CMD_TIMEOUT:-20}" pid guard rc=0
    shift
    [[ "$seconds" =~ ^[1-9][0-9]*$ ]] || return 2
    "$@" > "$output" 2>/dev/null & pid=$!
    (sleep "$seconds" & sleeper=$!; trap 'kill "$sleeper" 2>/dev/null || true; wait "$sleeper" 2>/dev/null || true; exit 0' TERM; wait "$sleeper"; kill -TERM "$pid" 2>/dev/null || true; sleep 1 & sleeper=$!; wait "$sleeper"; kill -KILL "$pid" 2>/dev/null || true) & guard=$!
    wait "$pid" || rc=$?
    kill "$guard" 2>/dev/null || true
    wait "$guard" 2>/dev/null || true
    return "$rc"
}

monitor_fail_rows() {
    grep '^FAIL [MH][0-9]' "$1" | head -20 | tr -cd '[:print:]\n'
}

monitor_load_state() {
    MONITOR_COUNT=0; MONITOR_OPEN=no
    if [[ -r "$MONITOR_DIR/alert.state" ]]; then
        local count open
        read -r count open < "$MONITOR_DIR/alert.state" || true
        if [[ "$count" =~ ^[0-9]+$ && ( "$open" == yes || "$open" == no ) ]]; then
            MONITOR_COUNT="$count"; MONITOR_OPEN="$open"
        fi
    fi
}

monitor_save_state() {
    local tmp="$MONITOR_DIR/alert.state.$$"
    (umask 077; printf '%s %s\n' "$MONITOR_COUNT" "$MONITOR_OPEN" > "$tmp") && mv -f "$tmp" "$MONITOR_DIR/alert.state"
}

monitor_send() {
    local status="$1" message="$2" payload code rc=0
    if [[ "$MONITOR_DRY_RUN" == yes ]]; then
        echo "${status} (dry-run): ${message}"
        return 0
    fi
    if [[ "$MONITOR_ALERT_KIND" == teams ]]; then
        payload="$(printf '%s' "$message" | bun -e 'const text=await Bun.stdin.text();console.log(JSON.stringify({type:"message",attachments:[{contentType:"application/vnd.microsoft.card.adaptive",content:{type:"AdaptiveCard",version:"1.4",body:[{type:"TextBlock",text,wrap:true}]}}]}))')" || return 1
        code="$(printf '%s' "$payload" | curl -q --config "$MONITOR_ALERT_CURL_CONFIG" -sS -o /dev/null -w '%{http_code}' --max-time 15 -H 'Content-Type: application/json' --data-binary @- 2>/dev/null)" || rc=$?
    else
        code="$(printf '%s' "$message" | curl -q --config "$MONITOR_ALERT_CURL_CONFIG" -sS -o /dev/null -w '%{http_code}' --max-time 15 --data-urlencode text@- 2>/dev/null)" || rc=$?
    fi
    [[ "$rc" -eq 0 && "$code" =~ ^2[0-9][0-9]$ ]]
}

monitor_transition() {
    local healthy="$1" message="$2" delivery_failed=0
    monitor_load_state
    if [[ "$healthy" == yes ]]; then
        if [[ "$MONITOR_OPEN" == yes ]]; then
            if monitor_send RECOVERED "$message"; then
                MONITOR_COUNT=0; MONITOR_OPEN=no
            else
                echo 'FAIL recovery delivery'
                delivery_failed=1
            fi
        else
            MONITOR_COUNT=0
        fi
    elif [[ "$MONITOR_OPEN" == no ]]; then
        MONITOR_COUNT=$((MONITOR_COUNT + 1))
        if [[ "$MONITOR_COUNT" -ge 2 ]]; then
            MONITOR_COUNT=2
            if monitor_send ALERT "$message"; then
                MONITOR_OPEN=yes
            else
                echo 'FAIL alert delivery'
                delivery_failed=1
            fi
        fi
    fi
    if [[ "$MONITOR_DRY_RUN" != yes ]]; then
        monitor_save_state || { echo 'FAIL state save'; return 1; }
    fi
    [[ "$delivery_failed" -eq 0 ]]
}
