#!/usr/bin/env bash
# Backstage-specific preconditions; sourced by deploy and tested with command doubles.
# A new shell must mint its own jar; never accept or delete a path inherited from the environment.
BACKSTAGE_SESSION_JAR=""
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

# A neighbour that cannot be reached is an OBSERVATION, recorded as "<http code>/<curl exit>" (the code
# curl printed before failing, 000 when it got none) so neighbour_status_changes compares the failure
# category and any status too: 000/60 -> 000/60 passes, while 000/60 -> 000/7, 200/28 -> 502/28,
# 200 -> 000/x and 000/x -> 200 all fail.
# Only network-level curl exits count as observations: 6 resolve, 7 connect, 28 timeout, 35 TLS
# handshake, 52 empty reply, 56 recv failure, 58/60 TLS cert problems. Anything else (126/127 curl
# missing, 2/3/48 bad invocation, ...) is a LOCAL fault, not a fact about the co-tenant: it returns 1
# with curl's stderr shown. Exit 0 with output that is no HTTP status is also a failure. Empty list: 1.
backstage_probe_neighbours() {
    local ip="$1" name code rc errfile probes=""
    shift
    [[ "$#" -gt 0 ]] || return 1
    errfile="$(mktemp)" || return 1
    for name in "$@"; do
        rc=0
        code="$(curl -q -sS -o /dev/null -w '%{http_code}' --max-time 10 --resolve "${name}:443:${ip}" "https://${name}/" 2>"$errfile")" || rc=$?
        if [[ "$rc" -eq 0 ]]; then
            [[ "$code" =~ ^[1-5][0-9][0-9]$ ]] || { echo "Probe of ${name} returned no HTTP status: '${code}'" >&2; rm -f "$errfile"; return 1; }
        else
            case "$rc" in
                6|7|28|35|52|56|58|60)
                    # Keep the status curl got before failing (000 = none): 200/28 and 502/28 differ.
                    [[ "$code" =~ ^(000|[1-5][0-9][0-9])$ ]] || { echo "Probe of ${name} printed no 3-digit status: '${code}' (curl exit ${rc})" >&2; rm -f "$errfile"; return 1; }
                    code="${code}/${rc}" ;;
                *) cat "$errfile" >&2; echo "Probe of ${name} failed locally (curl exit ${rc})" >&2; rm -f "$errfile"; return 1 ;;
            esac
        fi
        probes="${probes}${name} ${code}
"
    done
    rm -f "$errfile"
    printf '%s' "$probes"
}

# Existing unsuccessful releases can be quarantined, but never a live or verified one.
# No release payload is deleted: interruptions leave an inspectable quarantine.
backstage_prepare_destination() {
    local release="$1" current="$2"
    remote "if [ -e '${release}' ]; then test ! -f '${release}/.verified' || exit 1; if [ -L '${current}' ]; then live=\$(readlink '${current}') || exit 1; test \"\$live\" != '${release}' || exit 1; elif [ -e '${current}' ]; then exit 1; fi; quarantine=\$(mktemp -d '${release}.failed-XXXXXX') && rmdir \"\$quarantine\" && mv '${release}' \"\$quarantine\"; fi"
}

# Credential file contents never enter command arguments or output.
backstage_curl() {
    if [[ "${BACKSTAGE_GATE:-}" == session ]]; then
        backstage_session_mint || return 1
        curl -q -b "$BACKSTAGE_SESSION_JAR" "$@"
        return
    fi
    if [[ -n "${BACKSTAGE_CURL_CONFIG:-}" ]]; then
        curl -q --config "$BACKSTAGE_CURL_CONFIG" "$@"
    else
        curl -q "$@"
    fi
}

# The caller owns the jar so command substitutions running curl can reuse it.
backstage_session_cleanup() {
    [[ -z "${BACKSTAGE_SESSION_JAR:-}" ]] || rm -f "$BACKSTAGE_SESSION_JAR"
    BACKSTAGE_SESSION_JAR=""
}
backstage_session_reset() { backstage_session_cleanup; }
backstage_session_on_exit() {
    local rc=$?
    backstage_session_cleanup
    if [[ -n "${BACKSTAGE_PRIOR_EXIT:-}" ]]; then
        set +e
        (exit "$rc")
        eval "$BACKSTAGE_PRIOR_EXIT"
    fi
    return "$rc"
}
backstage_session_install_exit() {
    local prior
    prior="$(trap -p EXIT)"
    [[ "$prior" != *backstage_session_cleanup* && "$prior" != *backstage_session_on_exit* ]] || return 0
    if [[ -n "$prior" ]]; then
        prior="${prior#trap -- \'}"
        prior="${prior%\' EXIT}"
    fi
    BACKSTAGE_PRIOR_EXIT="$prior"
    trap backstage_session_on_exit EXIT
}
backstage_session_mint() {
    [[ "${BACKSTAGE_GATE:-}" == session ]] || return 0
    [[ -z "${BACKSTAGE_SESSION_JAR:-}" ]] || return 0
    backstage_require_curl_config session || return 1
    local jar headers code rc=0 cookie
    jar="$(mktemp "${TMPDIR:-/tmp}/jevnotjev-session.XXXXXX")" || return 1
    headers="$(mktemp "${TMPDIR:-/tmp}/jevnotjev-mint.XXXXXX")" || { rm -f "$jar"; return 1; }
    chmod 600 "$jar" "$headers" || { rm -f "$jar" "$headers"; return 1; }
    code="$(curl -q --config "$BACKSTAGE_CURL_CONFIG" -sS -X POST -c "$jar" -D "$headers" -o /dev/null -w '%{http_code}' --max-time 15 ${CURL_PIN} "${HEALTH_URL}/api/auth/password" 2>/dev/null)" || rc=$?
    cookie="$(awk 'BEGIN{IGNORECASE=1} tolower($1)=="set-cookie:" && ($2 ~ /^(backstage_session|__Host-backstage_session)=/) {print "yes"; exit}' "$headers")"
    rm -f "$headers"
    if [[ "$rc" -ne 0 || "$code" != 303 || "$cookie" != yes ]]; then
        rm -f "$jar"
        echo "BACKSTAGE_CURL_CONFIG could not mint a Backstage session" >&2
        return 1
    fi
    BACKSTAGE_SESSION_JAR="$jar"
    export BACKSTAGE_SESSION_JAR
    backstage_session_install_exit
}

backstage_list_neighbours() {
    local names
    names="$(list_neighbours "$1")" || return 1
    [[ -n "$names" ]] || return 1
    printf '%s\n' "$names"
}

backstage_check_curl_config() {
    [[ -n "${BACKSTAGE_CURL_CONFIG:-}" ]] || return 0
    bun -e 'import {statSync} from "node:fs";const s=statSync(process.argv[1]);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o077)!==0)process.exit(1)' "$BACKSTAGE_CURL_CONFIG" 2>/dev/null
}

# backstage_snippet_auth - pure. Snippet text on stdin; prints the EFFECTIVE auth of the supported
# layout: exactly one top-level `location ^~ /backstage/` and one `location ^~ /api/backstage/`.
#   yes      both locations carry auth_basic (not off) and auth_basic_user_file
#   session  both locations use auth_request to the internal session check
#   no       neither location has auth, or auth_basic is off in both
#   unknown  anything else: one location only, auth_basic without a file, auth directives outside
#            those two locations or in nested blocks, missing/duplicate locations, unbalanced braces
# Statements are split on ; { } so one-line and multi-line blocks parse the same.
backstage_snippet_auth() {
    awk '
    { sub(/#.*/, ""); buf = buf " " $0 }
    END {
        # Braces in a quoted JSON return body are not nginx block delimiters.
        parsed = ""; quote = ""; escaped = 0
        for (j = 1; j <= length(buf); j++) {
            c = substr(buf, j, 1)
            if (quote != "") {
                parsed = parsed c
                if (escaped) escaped = 0
                else if (c == "\\") escaped = 1
                else if (c == quote) quote = ""
            } else {
                parsed = parsed c
                if (c == "\047" || c == "\042") quote = c
                else if (c == "{" || c == "}" || c == ";") parsed = parsed "\n"
            }
        }
        buf = parsed
        n = split(buf, st, "\n"); depth = 0; cur = ""; bad = 0
        for (i = 1; i <= n; i++) {
            s = st[i]; gsub(/^[[:space:]]+|[[:space:]]+$/, "", s)
            if (s == "") continue
            last = substr(s, length(s), 1)
            if (last == "{") {
                h = substr(s, 1, length(s) - 1); gsub(/[[:space:]]+$/, "", h); gsub(/[[:space:]]+/, " ", h)
                if (depth == 0) {
                    if (h == "location ^~ /backstage/") { cur = "page"; seen["page"]++ }
                    else if (h == "location ^~ /api/backstage/") { cur = "api"; seen["api"]++ }
                    else if (h == "location = /_backstage_session") { cur = "session_check"; seen["session_check"]++ }
                    else cur = "other"
                } else if (cur == "page" || cur == "api") bad = 1
                depth++
            } else if (s == "}") {
                depth--; if (depth < 0) bad = 1; if (depth == 0) cur = ""
            } else if (last == ";") {
                s = substr(s, 1, length(s) - 1); split(s, w, /[[:space:]]+/); d = w[1]
                if (cur == "session_check" && depth == 1) {
                    if (d == "internal") { if (internal++ || s != "internal") bad = 1; continue }
                    if (d == "proxy_pass") { if (session_proxy++ || s != "proxy_pass http://127.0.0.1:3456/api/auth/session") bad = 1; continue }
                    if (d == "return") { bad = 1; continue }
                }
                if ((cur == "page" || cur == "api") && depth == 1 && (d == "satisfy" || d == "allow" || d == "deny")) { bad = 1; continue }
                if (d != "auth_basic" && d != "auth_basic_user_file" && d != "auth_request") continue
                if (depth != 1 || (cur != "page" && cur != "api") || ((cur, d) in dir)) { bad = 1; continue }
                v = s; sub(/^[^[:space:]]+[[:space:]]*/, "", v); gsub(/["\047]/, "", v)
                dir[cur, d] = v
            } else bad = 1
        }
        if (depth != 0 || bad || seen["page"] != 1 || seen["api"] != 1) { print "unknown"; exit }
        for (k = 1; k <= 2; k++) {
            loc = (k == 1 ? "page" : "api")
            ab = ((loc, "auth_basic") in dir); uf = ((loc, "auth_basic_user_file") in dir); ar = ((loc, "auth_request") in dir)
            if (ar) {
                if (!ab && !uf && dir[loc, "auth_request"] == "/_backstage_session") r[loc] = "session"
                else r[loc] = "unknown"
                continue
            }
            if (ab && dir[loc, "auth_basic"] == "off") r[loc] = "no"
            else if (ab && uf && dir[loc, "auth_basic"] != "" && dir[loc, "auth_basic_user_file"] != "") r[loc] = "yes"
            else if (!ab && !uf) r[loc] = "no"
            else r[loc] = "unknown"
        }
        if (r["page"] != r["api"]) { print "unknown"; exit }
        if (r["page"] == "session" && (seen["session_check"] != 1 || internal != 1 || session_proxy != 1)) { print "unknown"; exit }
        print r["page"]
    }'
}

# backstage_auth_state - prints yes or session when the INSTALLED snippet gates both Backstage
# locations, no when it gates neither (or is absent). Fails closed (returns 1): a read error, a
# failed probe, or a layout backstage_snippet_auth does not recognise.
backstage_auth_state() {
    local text rc=0 state
    text="$(remote "S='/etc/nginx/snippets/jevnotjev-backstage.conf'; test -e \"\$S\" || exit 10; cat \"\$S\"")" || rc=$?
    case "$rc" in
        0) ;;
        10) echo no; return 0 ;;
        *) return 1 ;;
    esac
    state="$(printf '%s\n' "$text" | backstage_snippet_auth)" || return 1
    case "$state" in
        yes|session|no) echo "$state" ;;
        *) return 1 ;;
    esac
}

# backstage_require_curl_config - $1 is the auth state (yes|session|no). With auth on the host every
# Backstage probe needs the private curl config; say so by name instead of failing on a bare 401.
backstage_require_curl_config() {
    case "$1" in
        no) ;;
        yes|session)
            if [[ -z "${BACKSTAGE_CURL_CONFIG:-}" ]]; then
                echo "Backstage is behind a gate on the host: export BACKSTAGE_CURL_CONFIG=<absolute path to your private curl config> (see docs/DEPLOY.md)." >&2
                return 1
            fi ;;
        *) echo "Backstage auth state '${1}' is unknown; refusing." >&2; return 1 ;;
    esac
    backstage_check_curl_config || {
        echo "BACKSTAGE_CURL_CONFIG must name a regular file owned by you with mode 0600: ${BACKSTAGE_CURL_CONFIG}" >&2
        return 1
    }
}
