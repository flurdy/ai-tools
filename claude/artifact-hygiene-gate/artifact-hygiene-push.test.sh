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
git -C "$TEST_ROOT/repo" init -q
git -C "$TEST_ROOT/target" init -q
AUDIT="$HOME/.agents/skills/artifact-hygiene/scripts/artifact_hygiene.py"
PUSH="git -C $TEST_ROOT/target push"

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
r = {"schemaVersion": "artifact-hygiene/v1", "status": "complete",
     "coverage": [{"source": source, "status": "complete", "errors": [], "limits": []}
                  for source in ("working-tree", "branch-history", "custom-detectors")],
     "findings": [], "verdict": "clean"}
if kind == "partial":
    r["coverage"][0].update(status="partial", errors=["scanner-missing"])
    r.update(status="partial", verdict="partial")
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
  local command=$1 expected=$2 cwd=${3-$TEST_ROOT/repo}
  rm -f "$INVOCATION_FILE"
  python3 - "$command" "$cwd" > "$TEST_ROOT/input.json" <<'PY'
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

for input in 'not-json' '{}' '{"tool_input":{"command":[]}}' '{"tool_input":{"command":null}}'; do
  rm -f "$INVOCATION_FILE"
  status=0
  output=$(printf '%s' "$input" | bash "$GATE" 2>&1) || status=$?
  assert_equals "$status" 2 'malformed hook payload'
  [[ ! -e "$INVOCATION_FILE" ]] || fail 'Malformed hook payload invoked audit'
  assert_contains 'push denied'
done

for cwd in "$TEST_ROOT/repo" "$TEST_ROOT/target" '' . "$TEST_ROOT/missing"; do
  run_gate "$PUSH origin main" 0 "$cwd"
  assert_equals "$(< "$INVOCATION_FILE")" "$(cd "$TEST_ROOT/target" && pwd -P)" 'audit independent of payload cwd'
  assert_equals "$output" "artifact-hygiene passed 'git push' for $(cd "$TEST_ROOT/target" && pwd -P)" 'clean output'
done
run_gate "git --no-pager -C $TEST_ROOT/target push" 0
assert_equals "$(< "$INVOCATION_FILE")" "$(cd "$TEST_ROOT/target" && pwd -P)" 'ordered options audit cwd'

for command in \
  'git push origin main' \
  'git --no-pager push' \
  'git -C ../target push' \
  "cd $TEST_ROOT/target && git push" \
  "(cd $TEST_ROOT/target && git push)" \
  "pushd $TEST_ROOT/target; git push; popd" \
  'git status && git push' \
  "git -C $TEST_ROOT/target status && git push" \
  "git push && git -C $TEST_ROOT/target log" \
  "git -C $TEST_ROOT/missing push" \
  'git -C ../target -C . push' \
  'git -c core.worktree=../target push' \
  "git --git-dir=$TEST_ROOT/target/.git push" \
  'GIT_WORK_TREE=../target git push' \
  "git -C \$TARGET push" \
  "bash -c 'git push'" \
  $'git status\ngit push' \
  'git push; git push'; do
  run_gate "$command" 2
  [[ ! -e "$INVOCATION_FILE" ]] || fail "$command audited an unproven repository"
  assert_contains 'push repository could not be proven'
done

# The path grammar must reject syntax even when a literal decoy is a valid repo.
mkdir -p "$TEST_ROOT/'target'" "$TEST_ROOT/tar*"
git -C "$TEST_ROOT/'target'" init -q
git -C "$TEST_ROOT/tar*" init -q
for command in "git -C $TEST_ROOT/'target' push" "git -C $TEST_ROOT/tar* push" 'git -C ~another-user push'; do
  run_gate "$command" 2
  [[ ! -e "$INVOCATION_FILE" ]] || fail "$command audited shell syntax as a literal path"
  assert_contains 'push repository could not be proven'
done

for cwd in "$TEST_ROOT/repo" "$TEST_ROOT/target" '' . "$TEST_ROOT/missing"; do
  run_gate 'git push' 2 "$cwd"
  [[ ! -e "$INVOCATION_FILE" ]] || fail 'Unproven payload cwd invoked audit'
  assert_contains 'push repository could not be proven'
done

for variable in GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_CONFIG_COUNT; do
  export "$variable=fixture"
  run_gate "$PUSH" 2
  unset "$variable"
  [[ ! -e "$INVOCATION_FILE" ]] || fail 'Git environment override invoked audit'
  assert_contains 'push repository could not be proven'
done

mkdir -p "$TEST_ROOT/target/subdir"
run_gate "git -C $TEST_ROOT/target/subdir push" 0
assert_equals "$(< "$INVOCATION_FILE")" "$(cd "$TEST_ROOT/target" && pwd -P)" 'worktree root from subdirectory'

git -C "$TEST_ROOT/target" -c user.name=Fixture -c user.email=fixture@example.invalid commit --allow-empty -qm fixture
git -C "$TEST_ROOT/target" worktree add --detach -q "$TEST_ROOT/worktree" HEAD
run_gate "git -C $TEST_ROOT/worktree push origin HEAD:main" 0
assert_equals "$(< "$INVOCATION_FILE")" "$(cd "$TEST_ROOT/worktree" && pwd -P)" 'linked worktree not main checkout'

git init --bare -q "$TEST_ROOT/bare"
run_gate "git -C $TEST_ROOT/bare push" 2
[[ ! -e "$INVOCATION_FILE" ]] || fail 'Bare repository invoked worktree audit'

python3 -I "$SCRIPT_DIR/artifact-hygiene-report.test.py" "$GATE"

for severity in high medium low unknown; do
  report "$severity"
  run_gate "git -C $TEST_ROOT/target push" 2
  assert_contains "artifact-hygiene denied 'git push' for $(cd "$TEST_ROOT/target" && pwd -P)"
  assert_contains 'Run /artifact-hygiene'
  [[ "$output" != *fixture-category* ]] || fail 'Gate echoed report category text'
done
report info
run_gate "$PUSH" 0
assert_equals "$output" "artifact-hygiene passed 'git push' for $(cd "$TEST_ROOT/target" && pwd -P)" 'info-only output'

report partial
export AUDIT_STATUS=2
run_gate "$PUSH" 2
assert_contains 'audit helper failed or returned incomplete coverage'

report clean
export AUDIT_STATUS=3
run_gate "$PUSH" 2
assert_contains '(exit 3)'
export AUDIT_STATUS=0

chmod -x "$AUDIT"
run_gate "$PUSH" 2
assert_contains 'helper missing'
rm -f "$AUDIT"
run_gate "$PUSH" 2
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
