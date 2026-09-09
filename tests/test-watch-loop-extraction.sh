#!/usr/bin/env bash
set -euo pipefail

root=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
readme="$root/README.md"
makefile="$root/Makefile"

[[ ! -e "$root/pi/watch-loop" ]] || {
	echo "pi/watch-loop remains owned by ai-tools" >&2
	exit 1
}
grep -Fq 'https://github.com/flurdy/pi-watch-loop' "$readme"
if grep -Fq 'pi/watch-loop' "$makefile"; then
	echo "ai-tools still installs the standalone watch loop" >&2
	exit 1
fi
if grep -Fq '(pi/watch-loop/)' "$readme"; then
	echo "ai-tools README still links to the removed source" >&2
	exit 1
fi

echo "Standalone watch-loop ownership contract: PASS"
