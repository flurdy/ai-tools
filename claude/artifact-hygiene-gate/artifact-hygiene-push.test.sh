#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
GATE=${GATE:-$SCRIPT_DIR/artifact-hygiene-push.sh}
mkdir -p "$SCRIPT_DIR/../../.artifacts"
TEST_ROOT=$(mktemp -d "$SCRIPT_DIR/../../.artifacts/artifact-hygiene-gate.XXXXXX")
trap 'rm -rf "$TEST_ROOT"' EXIT
export HOME="$TEST_ROOT/home"
export REPORT_FILE="$TEST_ROOT/report.json" INVOCATION_FILE="$TEST_ROOT/invocation"
export AUDIT_STATUS=0
mkdir -p "$HOME/.agents/skills/artifact-hygiene/scripts" "$TEST_ROOT/repo" "$TEST_ROOT/target"
AUDIT="$HOME/.agents/skills/artifact-hygiene/scripts/artifact_hygiene.py"

fail() { printf '%s\n' "$1" >&2; exit 1; }
assert_equals() { [[ "$1" == "$2" ]] || fail "$3: expected '$2', got '$1'"; }
assert_contains() { [[ "$output" == *"$1"* ]] || fail "Expected output to contain: $1"; }

[[ -x "$GATE" ]] || fail 'Expected executable promoted artifact-hygiene gate'

# Only the external audit is substituted; all hook parsing and decisions run normally.
cat > "$AUDIT" <<'HELPER'
#!/usr/bin/env bash
pwd -P > "$INVOCATION_FILE"
cat "$REPORT_FILE"
exit "$AUDIT_STATUS"
HELPER
chmod +x "$AUDIT"

report() {
  python3 - "$1" "$REPORT_FILE" <<'PY'
import json
import sys

kind, path = sys.argv[1:]
r = {"coverage": [{"source": "fixture", "status": "complete"}],
     "findings": [], "verdict": "clean"}
if kind == "partial":
    r["coverage"][0].update(status="partial", errors=["scanner-missing"])
    r["verdict"] = "partial"
elif kind != "clean":
    finding = {"category": "fixture-category"}
    if kind != "unknown":
        finding["severity"] = kind
    r["findings"] = [finding]
    r["verdict"] = "findings"
with open(path, "w") as f:
    json.dump(r, f)
PY
}

run_gate() {
  local command=$1 expected=$2
  rm -f "$INVOCATION_FILE"
  python3 - "$command" "$TEST_ROOT/repo" > "$TEST_ROOT/input.json" <<'PY'
import json
import sys
print(json.dumps({"tool_input": {"command": sys.argv[1]}, "cwd": sys.argv[2]}))
PY
  status=0
  output=$(bash "$GATE" < "$TEST_ROOT/input.json" 2>&1) || status=$?
  assert_equals "$status" "$expected" "$command exit status"
}

report clean
for command in 'git status' 'git pull' 'printf push' 'git pushy'; do
  run_gate "$command" 0
  [[ ! -e "$INVOCATION_FILE" ]] || fail 'Non-push command invoked audit'
  assert_equals "$output" '' 'non-push output'
done

run_gate 'git push origin main' 0
assert_equals "$(< "$INVOCATION_FILE")" "$(cd "$TEST_ROOT/repo" && pwd -P)" 'audit cwd'
assert_equals "$output" '' 'clean output'
run_gate "git -C $TEST_ROOT/target push" 0
assert_equals "$(< "$INVOCATION_FILE")" "$(cd "$TEST_ROOT/target" && pwd -P)" 'git -C audit cwd'
run_gate 'git --no-pager push' 0
[[ -e "$INVOCATION_FILE" ]] || fail 'Git option hid push'
run_gate 'git status && git push' 0
[[ -e "$INVOCATION_FILE" ]] || fail 'Chained push skipped audit'

for severity in high medium low unknown; do
  report "$severity"
  run_gate 'git push' 2
  assert_contains "artifact-hygiene denied 'git push'"
  assert_contains 'fixture-category'
  assert_contains 'verdict: findings'
done
report info
run_gate 'git push' 0
assert_equals "$output" '' 'info-only output'

report partial
export AUDIT_STATUS=2
run_gate 'git push' 2
assert_contains 'partial coverage: fixture:scanner-missing'
assert_contains 'verdict: partial'

report clean
export AUDIT_STATUS=3
run_gate 'git push' 2
assert_contains '(exit 3)'
export AUDIT_STATUS=0

chmod -x "$AUDIT"
run_gate 'git push' 2
assert_contains 'helper missing'
rm -f "$AUDIT"
run_gate 'git push' 2
assert_contains 'push denied'
run_gate 'git status' 0

python3 - "$SCRIPT_DIR/settings.artifact-hygiene-gate.fragment.json" <<'PY'
import json
import sys
with open(sys.argv[1]) as f:
    fragment = json.load(f)
assert fragment == {"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{
    "type": "command", "command": "bash ~/.claude/hooks/artifact-hygiene-push.sh",
    "timeout": 300}]}]}}
PY

make -s -C "$SCRIPT_DIR" install "CLAUDE_DIR=$TEST_ROOT/claude install"
assert_equals "$(readlink "$TEST_ROOT/claude install/hooks/artifact-hygiene-push.sh")" \
  "$SCRIPT_DIR/artifact-hygiene-push.sh" 'installed link'
make -s -C "$SCRIPT_DIR" install "CLAUDE_DIR=$TEST_ROOT/claude install"
[[ -x "$TEST_ROOT/claude install/hooks/artifact-hygiene-push.sh" ]] || fail 'Installed hook does not resolve'

printf 'All artifact-hygiene gate tests passed\n'
