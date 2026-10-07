#!/usr/bin/env bash
set -u
usage() { echo 'Usage: fresh-clone.sh --repo <path-or-url> --ref <ref> --out <dir> [-- driver flags]' >&2; exit 2; }
repo=https://github.com/breakoutwithai/jevnotjev.git
ref=main
out=
while (($#)); do
  case "$1" in
    --repo|--ref|--out)
      (($# >= 2)) || usage
      case "$1" in --repo) repo=$2;; --ref) ref=$2;; --out) out=$2;; esac
      shift 2;;
    --) shift; break;;
    *) usage;;
  esac
done
[[ -n "$out" ]] || usage
mkdir -p "$out" || exit 1
out=$(cd "$out" && pwd -P) || exit 1
work=$(mktemp -d) || exit 1
clone=$work/clone
server_pid=
cleanup() {
  if [[ -n "$server_pid" ]]; then kill -- -"$server_pid" 2>/dev/null || kill "$server_pid" 2>/dev/null || :; fi
  rm -rf "$work"
}
trap cleanup EXIT
if ! git clone --no-local --quiet "$repo" "$clone"; then exit 1; fi
case "$out/" in "$clone/"*) echo 'Output must be outside clone' >&2; exit 2;; esac
if ! git -C "$clone" checkout --quiet --detach "origin/$ref" 2>/dev/null; then
  git -C "$clone" checkout --quiet --detach "$ref" || exit 1
fi
sha=$(git -C "$clone" rev-parse HEAD) || exit 1
printf 'clone: %s @ %s\n' "$repo" "$sha"
cd "$clone" || exit 1
bash -c "${UAT_INSTALL_CMD:-bun install --frozen-lockfile}" || exit $?
port=${UAT_PORT:-3456}
export PORT="$port" BACKSTAGE_ORIGIN="http://localhost:$port"
health=${UAT_HEALTH_URL:-http://localhost:$port/api/backstage/health}
# A server already answering on the port would be tested instead of the clone's build.
if [[ "$health" != skip ]] && curl -s -o /dev/null --max-time 2 "$health" 2>/dev/null; then
  echo "Port $port already serves $health; stop that server or set UAT_PORT" >&2; exit 1
fi
start=${UAT_START_CMD:-bun run backstage:start}
set -m
bash -c "$start" > "$out/server.log" 2>&1 &
server_pid=$!
if [[ "$health" != skip ]]; then
  ready=false
  for ((i=0;i<90;i++)); do
    if [[ $(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$health" 2>/dev/null) == 200 ]]; then ready=true; break; fi
    if ! kill -0 "$server_pid" 2>/dev/null; then echo 'Server exited before health check' >&2; exit 1; fi
    sleep 1
  done
  [[ "$ready" == true ]] || { echo 'Server health check timed out' >&2; exit 1; }
fi
marker=$work/driver-start
touch "$marker" || exit 1
if [[ -n "${UAT_DRIVER_CMD:-}" ]]; then
  bash -c "$UAT_DRIVER_CMD" -- "$@"
  driver_status=$?
else
  bun scripts/uat/backstage-happy-path.ts --base "http://localhost:$port" --out "$out" --clone-sha "$sha" "$@"
  driver_status=$?
fi
validation_status=0
while IFS= read -r -d '' csv; do
  # Print only the verdict line: a diagnostic can quote a cell, and this script never sees the keys to redact them.
  if validation=$(bun run validate "$csv" 2>&1); then validation_rc=0; else validation_rc=1; validation_status=1; fi
  printf '%s\n' "$validation" | grep -E '^(VALID|INVALID) rows=[0-9]+ cases=[0-9]+ errors=[0-9]+ gaps=[0-9]+$' || printf 'validate exit %s\n' "$validation_rc"
done < <(find "$out" -name records.csv -type f -newer "$marker" -print0)
if ! status=$(git -C "$clone" status --porcelain --untracked-files=all); then
  echo 'git status failed for clone' >&2
  exit 1
fi
if [[ -n "$status" ]]; then printf '%s\n' "$status"; exit 1; fi
printf 'git status --porcelain: empty\n'
if ((driver_status != 0)); then exit "$driver_status"; fi
exit "$validation_status"
