#!/usr/bin/env bash
#
# Shared configuration for jevnotjev static-site deploys.
# Sourced by deploy.sh, preflight.sh and provision.sh - do not execute directly.
#
# Forked from breakoutwithai lakelife `.deploy/` (same host), cut down for a plain static
# folder: no build, no PM2, no port, no .env, no data/ persistence. nginx serves `site/`
# straight from disk.
#
# TARGET: breakout-apps (178.62.69.200). SHARED HOST with several other vhosts. The tenant
# list is NOT written down here on purpose: deploy.sh and provision.sh read the server_names
# from /etc/nginx/sites-enabled at run time and probe each one before and after, so a
# co-tenant added next week is covered without editing this file.

readonly SERVER_HOST="${JEVNOTJEV_SERVER_HOST:-178.62.69.200}"
readonly SERVER_USER="${JEVNOTJEV_SERVER_USER:-root}"
readonly SERVER="${SERVER_USER}@${SERVER_HOST}"

readonly SSH_KEY="${JEVNOTJEV_SSH_KEY:-$HOME/.ssh/cc-os-vanilla-audit-20260504}"

# DEPLOY_PATH is the SERVED path (nginx `root`) and is a SYMLINK into RELEASES_ROOT.
# Activation is an atomic symlink swap, so a request sees the whole old release or the
# whole new one, never a half-copied index.html next to a new data.js.
readonly DEPLOY_PATH="/var/www/jevnotjev"
readonly RELEASES_ROOT="/var/www/jevnotjev-releases"
# Releases retained on the box (active + previous are always protected on top of this).
readonly KEEP_RELEASES=3

readonly DOMAIN="jevnotjev.breakoutwithai.com"
readonly HEALTH_URL="https://${DOMAIN}"

# The committed folder that IS the site. Only files git tracks under it ship.
readonly SITE_DIR="site"

# site/backstage/ belongs to the Backstage module (served by its own service behind Basic Auth).
# The static module is site/ minus this prefix: ship.sh's drift pathspec and deploy.sh's served-path
# verification both read it from here.
readonly BACKSTAGE_SITE_PREFIX="backstage/"

# The committed vhost source, installed once by provision.sh.
readonly VHOST_SRC=".deploy/nginx-jevnotjev.conf"
readonly VHOST_AVAILABLE="/etc/nginx/sites-available/${DOMAIN}"
readonly VHOST_ENABLED="/etc/nginx/sites-enabled/${DOMAIN}"

readonly SSH_OPTS="-i ${SSH_KEY} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -o BatchMode=yes"

# Every verification curl hits the box we JUST MUTATED, not whatever DNS answers. `--resolve`
# keeps SNI and the Host header correct while pinning the TCP connection to SERVER_HOST.
readonly CURL_PIN="--resolve ${DOMAIN}:443:${SERVER_HOST}"

readonly RED=$'\033[0;31m'
readonly GREEN=$'\033[0;32m'
readonly YELLOW=$'\033[1;33m'
readonly BLUE=$'\033[0;34m'
readonly NC=$'\033[0m'

log_info()    { echo "${BLUE}[INFO]${NC} $1"; }
log_success() { echo "${GREEN}[ OK ]${NC} $1"; }
log_warn()    { echo "${YELLOW}[WARN]${NC} $1"; }
log_error()   { echo "${RED}[FAIL]${NC} $1" >&2; }
fail()        { log_error "$1"; exit 1; }

remote() { ssh ${SSH_OPTS} "${SERVER}" "$@"; }
