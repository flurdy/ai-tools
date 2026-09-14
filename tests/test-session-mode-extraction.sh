#!/usr/bin/env bash
set -euo pipefail
root=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
[[ ! -e "$root/pi/session-mode" ]] || { echo "pi/session-mode remains owned by ai-tools" >&2; exit 1; }
grep -Fq 'https://github.com/flurdy/pi-session-mode' "$root/README.md"
if grep -Eq 'lease-observer|LeaseOccupancy|GUARD_OCCUPANCY' "$root/pi/statusline/pi-statusline.ts" "$root/pi/statusline/session-guard.ts"; then
	echo "Statusline still depends on worktree occupancy inspection" >&2
	exit 1
fi
if grep -Fq '$(CURDIR)/pi/session-mode' "$root/Makefile" || grep -Fq '(pi/session-mode/)' "$root/README.md"; then
	echo "ai-tools still installs or documents the removed implementation" >&2
	exit 1
fi
echo "Standalone session-mode ownership contract: PASS"
