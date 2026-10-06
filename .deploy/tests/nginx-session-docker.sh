#!/usr/bin/env bash
#
# nginx-session-docker.sh - manual proof of the Backstage session gate in a throwaway nginx.
#
# Runs .deploy/backstage-nginx.conf inside nginx:1.27-alpine over TLS (self-signed, test-only),
# in front of a local Backstage build on this machine. Only the proxy_pass host:port is
# rewritten. Every secret, password and certificate is generated here and deleted at exit.
# Needs Docker and the nginx:1.27-alpine image, so it is NOT part of scripts/gate.ts.
# No remote host is contacted. Prints one PASS/FAIL row per check and a summary; exits 1 on any FAIL.
#
#   bash .deploy/tests/nginx-session-docker.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/backstage-ngx.XXXXXX")"
PORT="${NGX_UPSTREAM_PORT:-3466}"
TLS="${NGX_TLS_PORT:-18443}"
HOST=jevnotjev.test
ORIGIN="https://${HOST}:${TLS}"
NAME="backstage-ngx-$$"
SERVER=""
cleanup() {
    [[ -z "$SERVER" ]] || kill "$SERVER" 2>/dev/null
    docker rm -f "$NAME" >/dev/null 2>&1
    rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$TMP/conf/www" "$TMP/state"
sed "s#http://127.0.0.1:3456#http://host.docker.internal:${PORT}#g" "$ROOT/.deploy/backstage-nginx.conf" > "$TMP/conf/snippet.inc"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=${HOST}" \
    -keyout "$TMP/conf/key.pem" -out "$TMP/conf/cert.pem" >/dev/null 2>&1 || { echo "openssl failed"; exit 1; }
printf 'static root\n' > "$TMP/conf/www/index.html"
cat > "$TMP/conf/default.conf" <<EOF
server {
  listen 443 ssl;
  server_name ${HOST};
  ssl_certificate /etc/nginx/conf.d/cert.pem;
  ssl_certificate_key /etc/nginx/conf.d/key.pem;
  root /etc/nginx/conf.d/www;
  include /etc/nginx/conf.d/snippet.inc;
  location / { try_files \$uri \$uri/ =404; }
}
EOF

PW="$(openssl rand -hex 12)"
EMAIL="tester@example.test"
printf '%s' "$PW" | bun "$ROOT/scripts/backstage-operator-password.ts" "$EMAIL" --stdin | tail -1 | sed 's/^/[/; s/$/]/' > "$TMP/state/operators.json"
chmod 600 "$TMP/state/operators.json"
SECRET="$(openssl rand -hex 32)"

DIR="$(cd "$ROOT" && bun -e 'import {buildBackstage} from "./scripts/backstage-build.ts"; console.log(await buildBackstage());')" || { echo "build failed"; exit 1; }
VER="$(bun -e "console.log((await Bun.file('${DIR}/release.json').json()).version)")"
env BACKSTAGE_VERSION="$VER" BACKSTAGE_STATIC_ROOT="$DIR/site" BACKSTAGE_ORIGIN="$ORIGIN" PORT="$PORT" \
    BACKSTAGE_SESSION_SECRET="$SECRET" BACKSTAGE_OPERATORS_PATH="$TMP/state/operators.json" \
    BACKSTAGE_TRUST_PROXY=loopback BACKSTAGE_REQUIRE_SESSION=1 \
    bun "$DIR/server.js" > "$TMP/state/server.log" 2>&1 &
SERVER=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:${PORT}/backstage/sign-in" && break; sleep 0.1; done

docker run -d --name "$NAME" -p "127.0.0.1:${TLS}:443" -v "$TMP/conf:/etc/nginx/conf.d:ro" nginx:1.27-alpine >/dev/null || exit 1
sleep 2
echo "nginx: $(docker exec "$NAME" nginx -v 2>&1); auth_request module: $(docker exec "$NAME" nginx -V 2>&1 | grep -c -- '--with-http_auth_request_module')"

C=(curl -q -sk --path-as-is --resolve "${HOST}:${TLS}:127.0.0.1" --max-time 10)
PASS=0; FAIL=0
# row <name> <want code> <path> [curl args]: PASS needs the code, no WWW-Authenticate and no injected header.
row() {
    local name="$1" want="$2" path="$3"; shift 3
    local h code loc wa inj ok=FAIL
    h="$("${C[@]}" -o "$TMP/state/body" -D - "$@" "${ORIGIN}${path}" | tr -d '\r')"
    code="$(printf '%s\n' "$h" | awk 'toupper($1) ~ /^HTTP/ {c=$2} END {print c}')"
    loc="$(printf '%s\n' "$h" | awk 'tolower($1)=="location:" {print $2}')"
    wa="$(printf '%s\n' "$h" | grep -ic '^www-authenticate')"
    inj="$(printf '%s\n' "$h" | grep -ic '^set-cookie: injected')"
    [[ "$code" == "$want" && "$wa" == 0 && "$inj" == 0 ]] && ok=PASS
    if [[ $ok == PASS ]]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); fi
    printf '%-4s %-48s %s (want %s) www-auth=%s injected=%s location=%s\n' "$ok" "$name" "${code:-none}" "$want" "$wa" "$inj" "${loc:--}"
}
body_has() { # name needle
    if grep -q "$2" "$TMP/state/body"; then PASS=$((PASS + 1)); echo "PASS $1"; else FAIL=$((FAIL + 1)); echo "FAIL $1"; fi
}
JAR="$TMP/state/jar"
WRONG_SIG="$(printf '{"email":"%s","auth":"password","iat":1,"exp":9999999999999,"sid":"x","cred":"x"}' "$EMAIL" | base64 | tr '+/' '-_' | tr -d '=\n').AAAA"

row "anon GET /backstage/" 302 /backstage/
row "anon GET /backstage/backstage.css" 302 /backstage/backstage.css
row "anon GET /api/backstage/health" 401 /api/backstage/health
body_has "anon api 401 body is the JSON code" '"code":"unauthenticated"'
row "anon POST /api/backstage/answer" 401 /api/backstage/answer -X POST -H 'content-type: application/json' --data '{}'
row "anon GET /backstage/sign-in" 200 /backstage/sign-in
body_has "sign-in page has the password form" 'action="/api/auth/password"'
row "anon GET /api/auth/session (no route outside nginx internal)" 404 /api/auth/session
row "anon GET /_backstage_session (internal, mapped to 401)" 401 /_backstage_session
row "anon GET / (static unchanged)" 200 /
row "anon GET /api/auth/google (not configured)" 503 /api/auth/google
row "pivot /api/auth/..\\..\\%62ackstage/" 404 '/api/auth/..\..\%62ackstage/'
row "pivot /api/auth/..\\..\\/backstage/" 404 '/api/auth/..\..\/backstage/'
row "pivot /api/auth/password\\..\\..\\backstage\\" 404 '/api/auth/password\..\..\backstage\'
row "encoded /%62ackstage/index.html" 302 /%62ackstage/index.html
row "CRLF in path: no injected header" 302 '/backstage/x%0d%0aSet-Cookie:%20injected=1'
row "old Basic header only" 302 /backstage/ -u "${EMAIL}:${PW}"
row "garbage cookie page" 302 /backstage/ -b "__Host-backstage_session=x.y"
row "garbage cookie api" 401 /api/backstage/health -b "__Host-backstage_session=x.y"
row "well-formed cookie, wrong signature" 302 /backstage/ -b "__Host-backstage_session=${WRONG_SIG}"
row "wrong password POST" 303 /api/auth/password -X POST --data-urlencode "email=${EMAIL}" --data-urlencode "password=nope"
row "cross-site POST refused" 403 /api/auth/password -X POST -H 'sec-fetch-site: cross-site' --data-urlencode "email=${EMAIL}" --data-urlencode "password=${PW}"
row "form sign-in" 303 /api/auth/password -X POST -H "origin: ${ORIGIN}" --data-urlencode "email=${EMAIL}" --data-urlencode "password=${PW}" -c "$JAR"
grep -q '__Host-backstage_session' "$JAR" && { PASS=$((PASS + 1)); echo "PASS jar holds __Host-backstage_session"; } || { FAIL=$((FAIL + 1)); echo "FAIL jar holds __Host-backstage_session"; }
echo "     set-cookie: $("${C[@]}" -o /dev/null -D - -X POST --data-urlencode "email=${EMAIL}" --data-urlencode "password=${PW}" "${ORIGIN}/api/auth/password" | tr -d '\r' | grep -i '^set-cookie' | sed 's/=[^;]*;/=<redacted>;/')"
row "session GET /backstage/" 200 /backstage/ -b "$JAR"
row "session GET /backstage/backstage.css" 200 /backstage/backstage.css -b "$JAR"
row "session GET /api/backstage/health" 200 /api/backstage/health -b "$JAR"
row "session sign-out" 303 /api/auth/sign-out -X POST -H "origin: ${ORIGIN}" -b "$JAR"
row "revoked session after sign-out" 302 /backstage/ -b "$JAR"
rm -f "$JAR"
printf 'user = "%s:%s"\n' "$EMAIL" "$PW" > "$TMP/state/curlcfg"; chmod 600 "$TMP/state/curlcfg"
row "curl-config Basic mint" 303 /api/auth/password -X POST --config "$TMP/state/curlcfg" -c "$JAR"
row "minted session GET /api/backstage/health" 200 /api/backstage/health -b "$JAR"
kill "$SERVER"; wait "$SERVER" 2>/dev/null; SERVER=""
row "service down: page" 302 /backstage/ -b "$JAR"
row "service down: api" 401 /api/backstage/health -b "$JAR"
echo "matrix: ${PASS} passed, ${FAIL} failed"
[[ "$FAIL" -eq 0 ]]
