#!/usr/bin/env bash
# Manual Docker proof for #106. Requires an already local nginx:1.27-alpine image.
# Uses loopback only; never pulls an image or contacts a remote host.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/jev-monitor-docker.XXXXXX")"
HOST=jevnotjev.test
PORT="${MONITOR_DOCKER_UPSTREAM_PORT:-3467}"
TLS="${MONITOR_DOCKER_TLS_PORT:-18444}"
ORIGIN="https://${HOST}:${TLS}"
NAME="jev-monitor-nginx-$$"
SERVER=''
pass=0; fail=0
ok() { echo "PASS $1"; pass=$((pass+1)); }
nope() { echo "FAIL $1"; fail=$((fail+1)); }
cleanup() {
  [[ -z "$SERVER" ]] || { kill "$SERVER" 2>/dev/null || true; wait "$SERVER" 2>/dev/null || true; }
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
command -v docker >/dev/null && docker image inspect nginx:1.27-alpine >/dev/null 2>&1 || { echo 'nginx:1.27-alpine must be available locally'; exit 2; }
mkdir -p "$TMP/conf/www/label" "$TMP/conf/www/little-shop" "$TMP/state"
for path in index.html label/index.html little-shop/index.html; do printf 'static root\n' > "$TMP/conf/www/$path"; done
sed "s#http://127.0.0.1:3456#http://host.docker.internal:${PORT}#g" "$ROOT/.deploy/backstage-nginx.conf" > "$TMP/conf/snippet.inc"
make_cert() {
  openssl req -x509 -newkey rsa:2048 -nodes -days "$1" -subj "/CN=${HOST}" \
    -addext "subjectAltName=DNS:${HOST}" -keyout "$TMP/conf/key.pem" -out "$TMP/conf/cert.pem" >/dev/null 2>&1
}
make_cert 30 || exit 1
cat > "$TMP/conf/default.conf" <<CONF
server {
  listen 443 ssl;
  server_name ${HOST};
  ssl_certificate /etc/nginx/conf.d/cert.pem;
  ssl_certificate_key /etc/nginx/conf.d/key.pem;
  root /etc/nginx/conf.d/www;
  include /etc/nginx/conf.d/snippet.inc;
  location / { try_files \$uri \$uri/ =404; }
}
CONF
PW="$(openssl rand -hex 12)"
EMAIL=monitor@example.test
printf '%s' "$PW" | bun "$ROOT/scripts/backstage-operator-password.ts" "$EMAIL" --stdin | tail -1 | sed 's/^/[/; s/$/]/' > "$TMP/state/operators.json"
chmod 600 "$TMP/state/operators.json"
SECRET="$(openssl rand -hex 32)"
DIR="$(cd "$ROOT" && bun -e 'import {buildBackstage} from "./scripts/backstage-build.ts"; console.log(await buildBackstage())')" || exit 1
VER="$(bun -e 'console.log((await Bun.file(process.argv[1]).json()).version)' "$DIR/release.json")"
[[ "$VER" == "$(git -C "$ROOT" rev-parse HEAD)" ]] || { echo 'built version does not equal repository HEAD'; exit 1; }
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.test
GIT_CONFIG_GLOBAL=/dev/null git clone -q --bare --no-hardlinks "$ROOT" "$TMP/repo.git" || exit 1
git --git-dir="$TMP/repo.git" -c tag.gpgsign=false tag -a v2099.01.01.1 -m release "$VER" || exit 1
printf 'user = "%s:%s"\n' "$EMAIL" "$PW" > "$TMP/state/backstage.curl"
chmod 600 "$TMP/state/backstage.curl"
start_server() {
  env BACKSTAGE_VERSION="$VER" BACKSTAGE_STATIC_ROOT="$DIR/site" BACKSTAGE_ORIGIN="$ORIGIN" PORT="$PORT" \
    BACKSTAGE_SESSION_SECRET="$SECRET" BACKSTAGE_OPERATORS_PATH="$TMP/state/operators.json" \
    BACKSTAGE_TRUST_PROXY=loopback BACKSTAGE_REQUIRE_SESSION=1 \
    bun "$DIR/server.js" > "$TMP/state/server.log" 2>&1 &
  SERVER=$!
  local i
  for i in $(seq 1 50); do curl -q -s -o /dev/null "http://127.0.0.1:${PORT}/backstage/sign-in" && return 0; sleep 0.1; done
  return 1
}
start_server || { echo 'Backstage failed to start'; exit 1; }
docker run --pull=never -d --name "$NAME" --add-host=host.docker.internal:host-gateway \
  -p "127.0.0.1:${TLS}:443" -v "$TMP/conf:/etc/nginx/conf.d:ro" nginx:1.27-alpine >/dev/null || exit 1
sleep 1
export BACKSTAGE_CURL_CONFIG="$TMP/state/backstage.curl" MONITOR_REPO="$TMP/repo.git" MONITOR_URL="$ORIGIN"
export MONITOR_RESOLVE="${HOST}:${TLS}:127.0.0.1" CURL_CA_BUNDLE="$TMP/conf/cert.pem" MONITOR_ALERT_KIND=teams
export MONITOR_STATE_DIR="$TMP/state/monitor" VERIFY_SLEEP=0 VERIFY_ATTEMPTS=1
run() { rc=0; out="$(bash "$ROOT/.deploy/monitor.sh" --dry-run 2>&1)" || rc=$?; }
run
[[ $rc -eq 0 ]] && ok 'healthy run exits 0' || nope "healthy run: $out"
kill "$SERVER"; wait "$SERVER" 2>/dev/null || true; SERVER=''
run
[[ $rc -eq 1 && $out == *'FAIL M2'* && $out == *'FAIL M4'* ]] && ok 'stopped Backstage fails M2 and M4' || nope "stopped Backstage: $out"
start_server || exit 1
git --git-dir="$TMP/repo.git" -c tag.gpgsign=false tag -a v2099.01.01.2 -m wrong-version "${VER}^" || exit 1
run
[[ $rc -eq 1 && $out == *'FAIL M4'* ]] && ok 'newer tag on wrong commit fails M4' || nope "wrong version: $out"
git --git-dir="$TMP/repo.git" tag -d v2099.01.01.2 >/dev/null
make_cert 7 || exit 1
docker exec "$NAME" nginx -s reload >/dev/null 2>&1 || exit 1
sleep 1
run
[[ $rc -eq 1 && $out == *'FAIL M5'* ]] && ok 'seven-day certificate fails M5' || nope "expiring cert: $out"
make_cert 30 || exit 1
docker exec "$NAME" nginx -s reload >/dev/null 2>&1 || exit 1
# The 401 is internally redirected to the named location, so inject at both locations.
sed -i.bak '/^location \^~ \/api\/backstage\/ {$/a\
    add_header WWW-Authenticate '\''Basic realm="x"'\'' always;
' "$TMP/conf/snippet.inc"
sed -i.bak '/^location @backstage_api_401 {$/a\
    add_header WWW-Authenticate '\''Basic realm="x"'\'' always;
' "$TMP/conf/snippet.inc"
docker exec "$NAME" nginx -t >/dev/null 2>&1 && docker exec "$NAME" nginx -s reload >/dev/null 2>&1 || exit 1
sleep 1
run
[[ $rc -eq 1 && $out == *'FAIL M3'* ]] && ok 'WWW-Authenticate on anonymous API fails M3' || nope "WWW-Authenticate: $out"
echo "monitor-docker: ${pass} passed, ${fail} failed"
[[ $fail -eq 0 ]]
