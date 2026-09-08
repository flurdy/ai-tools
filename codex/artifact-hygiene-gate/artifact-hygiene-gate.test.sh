#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
SOURCE=$(cd "$SCRIPT_DIR/../../claude/artifact-hygiene-gate" && pwd -P)/artifact-hygiene-push.sh
SOURCE_TEST=$(dirname "$SOURCE")/artifact-hygiene-push.test.sh
mkdir -p "$SCRIPT_DIR/../../.artifacts"
TEST_ROOT=$(mktemp -d "$SCRIPT_DIR/../../.artifacts/codex-artifact-hygiene-gate.XXXXXX")
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() { printf '%s\n' "$1" >&2; exit 1; }
assert_equals() { [[ "$1" == "$2" ]] || fail "$3: expected '$2', got '$1'"; }

[[ -x "$SOURCE" ]] || fail 'Expected the canonical Claude gate script to be executable'
[[ -x "$SOURCE_TEST" ]] || fail 'Expected the canonical gate fixture suite to be executable'

fragment_command=$(python3 - "$SCRIPT_DIR/hooks.artifact-hygiene-gate.fragment.json" <<'PY'
import json
import sys
with open(sys.argv[1]) as f:
    fragment = json.load(f)
assert list(fragment) == ["hooks"]
assert list(fragment["hooks"]) == ["PreToolUse"]
groups = fragment["hooks"]["PreToolUse"]
assert len(groups) == 1 and groups[0]["matcher"] == "Bash"
hooks = groups[0]["hooks"]
assert len(hooks) == 1
hook = hooks[0]
assert hook["type"] == "command"
assert hook["timeout"] == 300
assert set(hook) == {"type", "command", "timeout"}
print(hook["command"])
PY
)
assert_equals "$fragment_command" 'bash ~/.codex/hooks/artifact-hygiene-push.sh' 'fragment command'

make -s -C "$SCRIPT_DIR" install "CODEX_DIR=$TEST_ROOT/codex install"
installed="$TEST_ROOT/codex install/hooks/artifact-hygiene-push.sh"
assert_equals "$(readlink "$installed")" "$SOURCE" 'installed link'
[[ -x "$installed" ]] || fail 'Installed hook does not resolve to an executable'
make -s -C "$SCRIPT_DIR" install "CODEX_DIR=$TEST_ROOT/codex install"

GATE="$installed" bash "$SOURCE_TEST"

printf 'All Codex artifact-hygiene gate tests passed\n'
