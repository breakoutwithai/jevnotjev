#!/usr/bin/env bash
#
# [T1] The committed jevnotjev vhost is a static, proxy-free server for exactly one domain,
# and provision.sh installs it without restarting nginx or touching another tenant's cert.
#
# Hermetic: reads committed files only. No ssh, no network, no nginx binary required.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
CONF=".deploy/nginx-jevnotjev.conf"
PROV=".deploy/provision.sh"

pass=0; fail=0
ok()   { echo "  ok   - $1"; pass=$((pass+1)); }
nope() { echo "  FAIL - $1"; fail=$((fail+1)); }

echo "[T1] nginx vhost + provision contract"

# Session snippet recognition is a deploy safety boundary.
source .deploy/backstage-lib.sh
snippet="$(cat .deploy/backstage-nginx.conf)"
[[ "$(printf '%s\n' "$snippet" | backstage_snippet_auth)" == session ]] && ok "repo Backstage snippet is a session gate" || nope "repo Backstage snippet is not a session gate"
if printf '%s\n' "$snippet" | grep -Eq 'auth_basic|WWW-Authenticate|satisfy'; then nope "session snippet contains Basic gate or challenge"; else ok "session snippet has no Basic gate, challenge or satisfy"; fi
session='location ^~ /backstage/ { auth_request /_backstage_session; } location ^~ /api/backstage/ { auth_request /_backstage_session; } location = /_backstage_session { internal; proxy_pass http://127.0.0.1:3456/api/auth/session; }'
[[ "$(printf '%s\n' "$session" | backstage_snippet_auth)" == session ]] && ok "inline session layout parses" || nope "inline session layout rejected"
for variant in \
    "${session} location ^~ /api/auth/ { auth_basic off; }" \
    "${session/auth_request \/_backstage_session;/auth_request off;}" \
    "${session/auth_request \/_backstage_session;/auth_request \/other;}" \
    "${session/internal;/}" \
    "${session/proxy_pass http:\/\/127.0.0.1:3456\/api\/auth\/session;/}" \
    "${session/http:\/\/127.0.0.1:3456\/api\/auth\/session/http:\/\/127.0.0.1:3456\/api\/auth\/other}" \
    "${session/internal;/internal; return 204;}" \
    "${session/internal;/internal; location \/nested { return 204; }}" \
    "${session/location ^~ \/backstage\/ { auth_request \/_backstage_session;/location ^~ \/backstage\/ { satisfy any; allow all; auth_request \/_backstage_session;}" \
    "${session/location ^~ \/api\/backstage\/ { auth_request \/_backstage_session;/location ^~ \/api\/backstage\/ { allow all; auth_request \/_backstage_session;}" \
    "${session} location ^~ /api/auth/ { location /nested { auth_request /_backstage_session; } }"; do
    [[ "$(printf '%s\n' "$variant" | backstage_snippet_auth)" == unknown ]] && ok "mixed or evasive session layout refused" || nope "mixed or evasive session layout accepted"
done
[[ "$(printf '%s\n' '# auth_basic off;' "$session" | backstage_snippet_auth)" == session ]] && ok "commented Basic directive has no effect" || nope "comment changed session classification"
for route in /backstage/sign-in /api/auth/password /api/auth/sign-out /api/auth/google /api/auth/google/callback; do
    block="$(printf '%s\n' "$snippet" | sed -n "\\|^location = ${route} {|,/^}/p")"
    [[ "$block" == *"proxy_pass http://127.0.0.1:3456${route};"* && "$block" == *'proxy_set_header Host $host;'* && "$block" == *'proxy_set_header X-Backstage-Client-IP $remote_addr;'* ]] \
        && ok "exact ${route} normalises target and forwards trusted headers" || nope "unsafe ${route} proxy location"
    if [[ "$route" == /api/auth/google/callback ]]; then
        [[ "$block" == *'access_log off;'* ]] && ok "OAuth callback omits code from access log" || nope "OAuth callback logs code"
    else
        [[ "$block" != *'access_log off;'* ]] && ok "${route} keeps access log" || nope "${route} disables access log"
    fi
done
[[ "$snippet" != *'location ^~ /api/auth/'* && "$snippet" == *'next=$request_uri;'* && "$snippet" != *'next=$uri;'* ]] \
    && ok "no raw auth prefix or decoded redirect target" || nope "raw auth prefix or decoded redirect target"
page="$(printf '%s\n' "$snippet" | sed -n '\|^location \^~ /backstage/ {|,/^}/p')"
[[ "$page" == *'proxy_set_header X-Backstage-Client-IP $remote_addr;'* ]] && ok "gated page overwrites client address" || nope "gated page trusts visitor address"

if [[ ! -f "$CONF" ]]; then
    nope "missing committed vhost at ${CONF}"
    echo "[T1] passed=${pass} failed=${fail}"; exit 1
fi

# Strip comments so a commented-out directive cannot satisfy the contract.
src="$(sed 's/#.*//' "$CONF")"

# Extract one location block by its exact opening line (regex on the text after `location`).
block() {
    printf '%s\n' "$src" | awk -v pat="$1" '
        $0 ~ "^[[:space:]]*location[[:space:]]+" pat "[[:space:]]*\\{" { grab=1 }
        grab { print }
        grab && /}/ { exit }'
}

names="$(printf '%s\n' "$src" | awk '$1=="server_name"{for(i=2;i<=NF;i++){n=$i; gsub(/;/,"",n); print n}}' | sort -u)"
[[ "$names" == "jevnotjev.breakoutwithai.com" ]] \
    && ok "server_name is exactly jevnotjev.breakoutwithai.com" \
    || nope "server_name set is '$(printf '%s' "$names" | tr '\n' ' ')'"

printf '%s\n' "$src" | grep -Eq '^[[:space:]]*root[[:space:]]+/var/www/jevnotjev;' \
    && ok "server root is /var/www/jevnotjev (the swapped symlink)" \
    || nope "server root is not /var/www/jevnotjev"

printf '%s\n' "$src" | grep -Eq 'proxy_pass|fastcgi_pass|uwsgi_pass|grpc_pass' \
    && nope "the vhost proxies somewhere - a static site must not" \
    || ok "no proxy_pass / fastcgi_pass anywhere"

root_block="$(block '/')"
printf '%s\n' "$root_block" | grep -Eq 'try_files[[:space:]]+\$uri[[:space:]]+\$uri/[[:space:]]+=404;' \
    && ok "location / uses try_files \$uri \$uri/ =404" \
    || nope "location / lacks try_files \$uri \$uri/ =404"
printf '%s\n' "$root_block" | grep -q 'Cache-Control "no-cache"' \
    && ok "location / (html, data.js) revalidates: Cache-Control no-cache" \
    || nope "location / has no no-cache header - a deploy could be hidden by browser caches"

sha_block="$(block '= /DEPLOYED_SHA')"
printf '%s\n' "$sha_block" | grep -q 'Cache-Control "no-store"' \
    && ok "/DEPLOYED_SHA is served no-store (the deploy check never reads a cached answer)" \
    || nope "/DEPLOYED_SHA location missing or not no-store"

img_block="$(printf '%s\n' "$src" | awk '/^[[:space:]]*location[[:space:]]+~\*.*png/ {g=1} g {print} g && /}/ {exit}')"
printf '%s\n' "$img_block" | grep -q 'max-age=' \
    && ok "images carry a max-age cache header" \
    || nope "no image cache header found"

printf '%s\n' "$src" | grep -Eq '^[[:space:]]*location[[:space:]]+\^~[[:space:]]+/\.well-known/acme-challenge/' \
    && ok "ACME location is ^~ (a regex dotfile deny cannot shadow renewals)" \
    || nope "ACME location missing or not ^~ - the dotfile deny would 403 certbot renewals"

printf '%s\n' "$src" | grep -Eq '^[[:space:]]*location[[:space:]]+~[[:space:]]+/\\\.[[:space:]]*\{' \
    && ok "dotfiles are denied" \
    || nope "no dotfile deny location"

# Regex locations match in file order: the dotfile deny must precede the image regex.
deny_line="$(printf '%s\n' "$src" | grep -nE 'location[[:space:]]+~[[:space:]]+/\\\.' | head -1 | cut -d: -f1)"
img_line="$(printf '%s\n' "$src" | grep -nE 'location[[:space:]]+~\*' | head -1 | cut -d: -f1)"
[[ -n "$deny_line" && -n "$img_line" && "$deny_line" -lt "$img_line" ]] \
    && ok "dotfile deny (line ${deny_line}) precedes the image regex (line ${img_line})" \
    || nope "dotfile deny at '${deny_line:-none}' does not precede image regex at '${img_line:-none}'"

printf '%s\n' "$src" | grep -Eq '^[[:space:]]*listen[[:space:]]+(443|.*ssl)' \
    && nope "committed source declares TLS - certbot owns that, the source must stay HTTP-only" \
    || ok "committed source is HTTP-only (certbot adds :443)"

# Braces balance: a cheap structural sanity check in lieu of nginx -t.
opens="$(printf '%s' "$src" | tr -cd '{' | wc -c | tr -d ' ')"
closes="$(printf '%s' "$src" | tr -cd '}' | wc -c | tr -d ' ')"
[[ "$opens" == "$closes" ]] && ok "braces balance (${opens})" || nope "braces unbalanced: ${opens} open, ${closes} close"

# ------------------------------------------------------------------ provision.sh
psrc="$(grep -v '^[[:space:]]*#' "$PROV")"
printf '%s\n' "$psrc" | grep -Eq 'restart nginx|nginx restart|systemctl restart' \
    && nope "provision.sh restarts nginx - that drops every co-tenant's connections" \
    || ok "provision.sh never restarts nginx"
printf '%s\n' "$psrc" | grep -q 'systemctl reload nginx' \
    && ok "provision.sh reloads nginx" \
    || nope "provision.sh has no reload"
# Every reload is gated by an `nginx -t`: either `nginx -t && systemctl reload nginx` on the
# same line, or an `nginx -t` between the previous reload and this one.
# Only `remote` lines EXECUTE on the box: dry-run echoes and fail messages merely mention nginx -t.
exec_src="$(printf '%s\n' "$psrc" | grep -v '\[dry-run\]')"
ungated="$(printf '%s\n' "$exec_src" | awk '
    /remote .*systemctl reload nginx/ {
        if ($0 ~ /nginx -t && systemctl reload nginx/ || tested) { tested = 0; next }
        print NR; next
    }
    /remote .*nginx -t/ { tested = 1 }')"
reloads="$(printf '%s\n' "$exec_src" | grep -c 'remote .*systemctl reload nginx')"
[[ "$reloads" -gt 0 && -z "$ungated" ]] \
    && ok "each of the ${reloads} reload(s) is gated by a preceding nginx -t" \
    || nope "reload without a preceding nginx -t at source line(s): ${ungated:-<no reload found>}"
certbot_line="$(printf '%s\n' "$psrc" | grep 'certbot --nginx')"
if [[ "$certbot_line" == *'-d ${DOMAIN}'* && "$certbot_line" == *'--non-interactive'* && "$certbot_line" != *'--expand'* ]]; then
    ok "certbot issues a non-interactive cert for this domain only (no --expand)"
else
    nope "certbot line is not '-d \${DOMAIN} --non-interactive' without --expand: ${certbot_line}"
fi
printf '%s\n' "$psrc" | grep -q 'CERTBOT_EMAIL is not set' \
    && ok "a missing CERTBOT_EMAIL fails loudly" \
    || nope "no loud failure for a missing CERTBOT_EMAIL"

# Behavioural: an unknown argument must refuse before anything else runs (no ssh needed).
out="$(/bin/bash "$PROV" --dryrun 2>&1)"; rc=$?
[[ $rc -eq 2 && "$out" == *usage:* ]] \
    && ok "provision.sh --dryrun (typo) refuses with rc=2" \
    || nope "provision.sh accepted an unknown argument: rc=${rc}"

# deploy.sh must never touch nginx: the vhost is provision.sh's alone.
dsrc="$(grep -v '^[[:space:]]*#' .deploy/deploy.sh)"
printf '%s\n' "$dsrc" | grep -Eq 'systemctl|nginx -s|nginx -t|sites-enabled/[^*]|certbot' \
    && nope "deploy.sh mutates nginx or certs" \
    || ok "deploy.sh never reloads nginx or touches certs (reads sites-enabled only)"

echo
echo "[T1] passed=${pass} failed=${fail}"
[[ $fail -eq 0 ]]
