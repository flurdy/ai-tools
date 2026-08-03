#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
STATUSLINE="$SCRIPT_DIR/statusline-command.sh"
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT

mkdir -p \
  "$TEST_ROOT/bin" \
  "$TEST_ROOT/workspace/.beads" \
  "$TEST_ROOT/workspace/nested" \
  "$TEST_ROOT/project/.git" \
  "$TEST_ROOT/project/.beads" \
  "$TEST_ROOT/project/infrastructure" \
  "$TEST_ROOT/project/repos/service/.beads" \
  "$TEST_ROOT/project/repos/service/nested" \
  "$TEST_ROOT/plain" \
  "$TEST_ROOT/fixtures"
printf '{}\n' > "$TEST_ROOT/project/workspace.json"
touch "$TEST_ROOT/project/README.md" "$TEST_ROOT/project/AGENTS.md" "$TEST_ROOT/project/Makefile"
cat > "$TEST_ROOT/bin/bd" <<'EOF'
#!/usr/bin/env bash
[ -f "$BD_FIXTURES/track-calls" ] && printf '%s\n' "${1:-}" >> "$BD_FIXTURES/calls"
if [ -f "$BD_FIXTURES/ignore-term" ]; then
  trap '' TERM
  sleep 10
fi
[ -f "$BD_FIXTURES/delay" ] && sleep "$(cat "$BD_FIXTURES/delay")"
case "${1:-}" in
  list) cat "$BD_FIXTURES/issues.json" ;;
  blocked) cat "$BD_FIXTURES/blocked.json" ;;
  *) exit 2 ;;
esac
EOF
chmod +x "$TEST_ROOT/bin/bd"
cat > "$TEST_ROOT/bin/project-workspace" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == "beads-counts" ]] || exit 2
[ -f "$PROJECT_WORKSPACE_FIXTURES/workspace-fail" ] && exit 1
cat "$PROJECT_WORKSPACE_FIXTURES/workspace-counts.json"
EOF
chmod +x "$TEST_ROOT/bin/project-workspace"
export BD_FIXTURES="$TEST_ROOT/fixtures"
export PROJECT_WORKSPACE_FIXTURES="$TEST_ROOT/fixtures"

cache_path() {
  local root=$1 key
  key=$(printf '%s' "$root" | cksum | tr -cd '0-9' | cut -c1-12)
  printf '/tmp/statusline-beads-%s' "$key"
}

clear_cache_for() {
  local root=$1 cache
  cache=$(cache_path "$root")
  rm -f "$cache" "$cache.lock" "$cache.tmp."*
  rm -rf "$cache.lock.d"
}

clear_cache() {
  clear_cache_for "$TEST_ROOT/workspace"
}

wait_for_cache() {
  local root=${1:-$TEST_ROOT/workspace} cache
  cache=$(cache_path "$root")
  for _ in {1..100}; do
    [ -f "$cache" ] && [ ! -e "$cache.lock.d" ] && return
    sleep 0.05
  done
  printf 'Timed out waiting for Beads cache\n' >&2
  exit 1
}

git_divergence_cache_path() {
  local root=$1 branch=$2 key
  key=$(printf '%s' "$root|$branch" | cksum | tr -cd '0-9' | cut -c1-12)
  printf '/tmp/statusline-git-divergence-%s' "$key"
}

clear_git_divergence_cache() {
  local root=$1 branch=$2 cache
  cache=$(git_divergence_cache_path "$root" "$branch")
  rm -f "$cache" "$cache.lock" "$cache.tmp."*
  rm -rf "$cache.lock.d"
}

wait_for_git_divergence_cache() {
  local root=$1 branch=$2 cache
  cache=$(git_divergence_cache_path "$root" "$branch")
  for _ in {1..100}; do
    [ -f "$cache" ] && [ ! -e "$cache.lock.d" ] && return
    sleep 0.05
  done
  printf 'Timed out waiting for Git divergence cache\n' >&2
  exit 1
}

clear_git_status_cache() {
  rm -f /tmp/statusline-git-cache-beads-statusline-test
}

render() {
  local cwd=$1 mode=${2:-table} command_path=${3:-$TEST_ROOT/bin:$PATH}
  jq -cn --arg cwd "$cwd" '{
    cwd: $cwd,
    model: {id: "claude-opus-4-8", display_name: "Opus"},
    cost: {total_cost_usd: 1.23, total_duration_ms: 65000},
    context_window: {used_percentage: 10},
    rate_limits: {
      five_hour: {used_percentage: 20},
      seven_day: {used_percentage: 30}
    },
    session_id: "beads-statusline-test"
  }' | env \
    PATH="$command_path" \
    COLUMNS=240 \
    LINES=60 \
    CLAUDE_STATUSLINE="$mode" \
    CLAUDE_STATUSLINE_PR=0 \
    CLAUDE_STATUSLINE_BEADS_TTL=30 \
    CLAUDE_STATUSLINE_BEADS_TIMEOUT=1 \
    bash "$STATUSLINE"
}

assert_contains() {
  local output=$1 expected=$2
  if [[ "$output" != *"$expected"* ]]; then
    printf 'Expected output to contain: %s\n' "$expected" >&2
    exit 1
  fi
}

assert_not_contains() {
  local output=$1 unexpected=$2
  if [[ "$output" == *"$unexpected"* ]]; then
    printf 'Expected output not to contain: %s\n' "$unexpected" >&2
    exit 1
  fi
}

output=$(render "$TEST_ROOT/plain")
assert_not_contains "$output" "◉"

cat > "$BD_FIXTURES/issues.json" <<'EOF'
[
  {"status":"open","priority":0},
  {"status":"open","priority":2},
  {"status":"open","priority":2},
  {"status":"open","priority":4},
  {"status":"in_progress","priority":1},
  {"status":"in_progress","priority":4},
  {"status":"deferred","priority":3}
]
EOF
printf '[{"id":"blocked-1"}]\n' > "$BD_FIXTURES/blocked.json"
clear_cache
render "$TEST_ROOT/workspace/nested" >/dev/null
wait_for_cache
output=$(render "$TEST_ROOT/workspace/nested")
assert_contains "$output" "◉ P0:1 P2:2 P4:1 ◐2 ⛔1"
mapfile -t table_lines <<< "$output"
assert_not_contains "${table_lines[1]}" "◉"
assert_contains "${table_lines[3]}" "◉ P0:1 P2:2 P4:1 ◐2 ⛔1"
case "${table_lines[3]}" in
  *"◉ P0:1 P2:2 P4:1 ◐2 ⛔1"*'$1.23'*) ;;
  *) printf 'Expected Beads cell immediately before cost on row 2\n' >&2; exit 1 ;;
esac

cp -f "$SCRIPT_DIR/../../shared/project-workspace/tests/fixtures/beads-counts-partial.json" \
  "$PROJECT_WORKSPACE_FIXTURES/workspace-counts.json"
clear_cache_for "$TEST_ROOT/project"
render "$TEST_ROOT/project" >/dev/null
wait_for_cache "$TEST_ROOT/project"
output=$(render "$TEST_ROOT/project")
assert_contains "$output" "◉ P0:1 P4:2 ◐2 ⛔1 ⚠1"

cat > "$PROJECT_WORKSPACE_FIXTURES/workspace-counts.json" <<'EOF'
{"version":1,"openByPriority":[0,0,0,0,0],"inProgress":0,"blocked":0,"successfulSources":0,"unavailableSources":2,"diagnostics":["workspace: unavailable","service: unavailable"]}
EOF
clear_cache_for "$TEST_ROOT/project"
render "$TEST_ROOT/project" >/dev/null
wait_for_cache "$TEST_ROOT/project"
output=$(render "$TEST_ROOT/project")
assert_contains "$output" "◉ ? ⚠2"

printf '[{"status":"open","priority":3}]\n' > "$BD_FIXTURES/issues.json"
printf '[]\n' > "$BD_FIXTURES/blocked.json"
clear_cache_for "$TEST_ROOT/project/repos/service"
render "$TEST_ROOT/project/repos/service/nested" >/dev/null
wait_for_cache "$TEST_ROOT/project/repos/service"
output=$(render "$TEST_ROOT/project/repos/service/nested")
assert_contains "$output" "◉ P3:1"
assert_not_contains "$output" "P4:2"

clear_cache_for "$TEST_ROOT/project"
touch "$PROJECT_WORKSPACE_FIXTURES/workspace-fail"
render "$TEST_ROOT/project" >/dev/null
wait_for_cache "$TEST_ROOT/project"
output=$(render "$TEST_ROOT/project")
assert_not_contains "$output" "◉"
rm -f "$PROJECT_WORKSPACE_FIXTURES/workspace-fail"

printf '[]\n' > "$BD_FIXTURES/issues.json"
printf '[]\n' > "$BD_FIXTURES/blocked.json"
clear_cache
render "$TEST_ROOT/workspace" >/dev/null
wait_for_cache
output=$(render "$TEST_ROOT/workspace")
assert_contains "$output" "◉ 0"
assert_not_contains "$output" "◐"
assert_not_contains "$output" "⛔"

printf '{}\n' > "$BD_FIXTURES/issues.json"
clear_cache
render "$TEST_ROOT/workspace" >/dev/null
wait_for_cache
output=$(render "$TEST_ROOT/workspace")
assert_not_contains "$output" "◉"

printf '[]\n' > "$BD_FIXTURES/issues.json"
touch "$BD_FIXTURES/ignore-term"
clear_cache
render "$TEST_ROOT/workspace" >/dev/null
wait_for_cache
output=$(render "$TEST_ROOT/workspace")
assert_not_contains "$output" "◉"
rm -f "$BD_FIXTURES/ignore-term"

clear_cache
render "$TEST_ROOT/workspace" >/dev/null
wait_for_cache
output=$(CLAUDE_STATUSLINE_BEADS=0 render "$TEST_ROOT/workspace")
assert_not_contains "$output" "◉"

clear_cache
output=$(render "$TEST_ROOT/workspace" compact)
assert_not_contains "$output" "◉"
sleep 0.1
[ ! -e "$(cache_path "$TEST_ROOT/workspace")" ] || { printf 'Compact mode unexpectedly created a Beads cache\n' >&2; exit 1; }

clear_cache
output=$(render "$TEST_ROOT/workspace" table "/usr/bin:/bin")
assert_not_contains "$output" "◉"
[ ! -e "$(cache_path "$TEST_ROOT/workspace")" ] || { printf 'Missing bd unexpectedly created a Beads cache\n' >&2; exit 1; }

clear_cache
: > "$BD_FIXTURES/calls"
touch "$BD_FIXTURES/track-calls"
printf '0.2\n' > "$BD_FIXTURES/delay"
pids=()
for _ in {1..10}; do
  render "$TEST_ROOT/workspace" >/dev/null &
  pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid"; done
wait_for_cache
[ "$(wc -l < "$BD_FIXTURES/calls")" -eq 2 ] || { printf 'Concurrent renders started duplicate Beads refreshes\n' >&2; exit 1; }
rm -f "$BD_FIXTURES/track-calls" "$BD_FIXTURES/delay"

GIT_REMOTE="$TEST_ROOT/remote.git"
GIT_SEED="$TEST_ROOT/seed"
GIT_WORKSPACE="$TEST_ROOT/git-workspace"
git init --bare --initial-branch=main "$GIT_REMOTE" >/dev/null
git init --initial-branch=main "$GIT_SEED" >/dev/null
git -C "$GIT_SEED" config user.name "Statusline Test"
git -C "$GIT_SEED" config user.email "statusline@example.invalid"
printf 'one\n' > "$GIT_SEED/file.txt"
git -C "$GIT_SEED" add file.txt
git -C "$GIT_SEED" commit -m "initial" >/dev/null
git -C "$GIT_SEED" remote add origin "$GIT_REMOTE"
git -C "$GIT_SEED" push -u origin main >/dev/null
git clone "$GIT_REMOTE" "$GIT_WORKSPACE" >/dev/null

printf 'two\n' >> "$GIT_SEED/file.txt"
git -C "$GIT_SEED" commit -am "remote commit" >/dev/null
git -C "$GIT_SEED" push >/dev/null
git -C "$GIT_WORKSPACE" fetch origin >/dev/null
clear_git_status_cache
clear_git_divergence_cache "$GIT_WORKSPACE" main
output=$(render "$GIT_WORKSPACE")
assert_not_contains "$output" "⇣1"
wait_for_git_divergence_cache "$GIT_WORKSPACE" main
output=$(render "$GIT_WORKSPACE")
assert_contains "$output" "⇣1"
assert_not_contains "$output" "⇡"

# A checkout during a stale branch-status window must query the cache-keyed
# branch, not process-time HEAD.
git -C "$GIT_WORKSPACE" switch -c feature --track origin/main >/dev/null
printf 'main|0|0|0|0|\n' > /tmp/statusline-git-cache-beads-statusline-test
clear_git_divergence_cache "$GIT_WORKSPACE" main
render "$GIT_WORKSPACE" >/dev/null
wait_for_git_divergence_cache "$GIT_WORKSPACE" main
output=$(render "$GIT_WORKSPACE")
assert_contains "$output" "⇣1"
git -C "$GIT_WORKSPACE" switch main >/dev/null
clear_git_status_cache

# A zero count stays hidden after the local branch catches up.
git -C "$GIT_WORKSPACE" merge --ff-only '@{upstream}' >/dev/null
clear_git_status_cache
clear_git_divergence_cache "$GIT_WORKSPACE" main
render "$GIT_WORKSPACE" >/dev/null
wait_for_git_divergence_cache "$GIT_WORKSPACE" main
output=$(render "$GIT_WORKSPACE")
assert_not_contains "$output" "⇡"
assert_not_contains "$output" "⇣"

# A local-only commit renders ahead without behind.
git -C "$GIT_WORKSPACE" config user.name "Statusline Test"
git -C "$GIT_WORKSPACE" config user.email "statusline@example.invalid"
printf 'local\n' >> "$GIT_WORKSPACE/file.txt"
git -C "$GIT_WORKSPACE" commit -am "local commit" >/dev/null
clear_git_status_cache
clear_git_divergence_cache "$GIT_WORKSPACE" main
render "$GIT_WORKSPACE" >/dev/null
wait_for_git_divergence_cache "$GIT_WORKSPACE" main
output=$(render "$GIT_WORKSPACE")
assert_contains "$output" "⇡1"
assert_not_contains "$output" "⇣"

# Independent local and remote commits render both directions.
printf 'three\n' >> "$GIT_SEED/file.txt"
git -C "$GIT_SEED" commit -am "second remote commit" >/dev/null
git -C "$GIT_SEED" push >/dev/null
git -C "$GIT_WORKSPACE" fetch origin >/dev/null
clear_git_status_cache
clear_git_divergence_cache "$GIT_WORKSPACE" main
render "$GIT_WORKSPACE" >/dev/null
wait_for_git_divergence_cache "$GIT_WORKSPACE" main
output=$(render "$GIT_WORKSPACE")
assert_contains "$output" "⇡1 ⇣1"

# A branch without a configured upstream also stays hidden.
GIT_LOCAL="$TEST_ROOT/git-local"
git init --initial-branch=main "$GIT_LOCAL" >/dev/null
git -C "$GIT_LOCAL" config user.name "Statusline Test"
git -C "$GIT_LOCAL" config user.email "statusline@example.invalid"
printf 'local\n' > "$GIT_LOCAL/file.txt"
git -C "$GIT_LOCAL" add file.txt
git -C "$GIT_LOCAL" commit -m "local" >/dev/null
clear_git_status_cache
clear_git_divergence_cache "$GIT_LOCAL" main
render "$GIT_LOCAL" >/dev/null
wait_for_git_divergence_cache "$GIT_LOCAL" main
output=$(render "$GIT_LOCAL")
assert_not_contains "$output" "⇡"
assert_not_contains "$output" "⇣"

clear_git_divergence_cache "$GIT_WORKSPACE" main
clear_git_divergence_cache "$GIT_LOCAL" main
clear_git_status_cache

# Worktree co-tenancy: a second live session in the same worktree is flagged on
# the worktree cell, because that is when exiting can destroy the other session.
export CLAUDE_WORKTREE_LEASE_DIR="$TEST_ROOT/leases"
GIT_WORKTREE="$TEST_ROOT/git-worktree"
git -C "$GIT_LOCAL" worktree add -q "$GIT_WORKTREE" -b cotenancy
COTENANCY_PIDS=()
seed_cotenancy_lease() {
  local session=$1 pid=$2 root=$3 dir key started
  key=$(printf '%s' "$root" | cksum | tr -cd '0-9' | cut -c1-12)
  dir="$CLAUDE_WORKTREE_LEASE_DIR/$key"
  mkdir -p "$dir"
  started=$(awk '{ sub(/^.*\) /, ""); print $20 }' "/proc/$pid/stat" 2>/dev/null || true)
  printf 'pid=%s\nsession=%s\nworktree=%s\nstarted=%s\n' "$pid" "$session" "$root" "$started" > "$dir/$session"
}

sleep 60 & COTENANCY_PIDS+=("$!")
seed_cotenancy_lease session-one "${COTENANCY_PIDS[0]}" "$GIT_WORKTREE"
clear_git_status_cache
output=$(render "$GIT_WORKTREE")
assert_contains "$output" "🌳"
assert_not_contains "$output" "⚠"

sleep 60 & COTENANCY_PIDS+=("$!")
seed_cotenancy_lease session-two "${COTENANCY_PIDS[1]}" "$GIT_WORKTREE"
clear_git_status_cache
output=$(render "$GIT_WORKTREE")
assert_contains "$output" "⚠2"

clear_git_status_cache
output=$(CLAUDE_STATUSLINE_COTENANCY=0 render "$GIT_WORKTREE")
assert_contains "$output" "🌳"
assert_not_contains "$output" "⚠2"

# The main checkout shares the lease store but is never at risk.
clear_git_status_cache
output=$(render "$GIT_LOCAL")
assert_not_contains "$output" "⚠2"

for pid in "${COTENANCY_PIDS[@]}"; do
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
done
clear_git_status_cache
output=$(render "$GIT_WORKTREE")
assert_not_contains "$output" "⚠"

clear_git_status_cache
printf 'Claude statusline Beads, Git-divergence and worktree co-tenancy tests passed\n'
