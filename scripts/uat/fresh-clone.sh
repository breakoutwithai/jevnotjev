#!/usr/bin/env bash
set -euo pipefail

while (($#)); do
  case "$1" in
    --repo|--ref|--out)
      if (($# < 2)); then exit 2; fi
      shift 2
      ;;
    *) shift ;;
  esac
done
exit 0
