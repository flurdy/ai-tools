#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GUARD="$SCRIPT_DIR/worktree-cotenancy.sh"
TEST_ROOT=$(mktemp -d)
export CLAUDE_WORKTREE_LEASE_DIR="$TEST_ROOT/leases"
PEER_PID=""
trap 'rm -rf "$TEST_ROOT"; [ -n "$PEER_PID" ] && kill "$PEER_PID" 2>/dev/null; true' EXIT

git init -q "$TEST_ROOT/repo"
git -C "$TEST_ROOT/repo" config user.email test@example.com
git -C "$TEST_ROOT/repo" config user.name Test
git -C "$TEST_ROOT/repo" commit -q --allow-empty -m init
git -C "$TEST_ROOT/repo" worktree add -q "$TEST_ROOT/wt" -b feature
MAIN="$TEST_ROOT/repo"
WT=$(cd "$TEST_ROOT/wt" && pwd -P)

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

assert_equals() {
  local actual=$1 expected=$2 what=$3
  [ "$actual" = "$expected" ] || fail "$what: expected '$expected', got '$actual'"
}

assert_contains() {
  local output=$1 expected=$2
  [[ "$output" == *"$expected"* ]] || fail "Expected output to contain: $expected"
}

hook_input() {
  printf '{"session_id":"%s","cwd":"%s","hook_event_name":"SessionStart"}' "$1" "$2"
}

lease_dir_for() {
  local key
  key=$(printf '%s' "$1" | cksum | tr -cd '0-9' | cut -c1-12)
  printf '%s/%s' "$CLAUDE_WORKTREE_LEASE_DIR" "$key"
}

seed_lease() {
  local session=$1 pid=$2 root=$3 dir started
  dir=$(lease_dir_for "$root")
  mkdir -p "$dir"
  started=$(awk '{ sub(/^.*\) /, ""); print $20 }' "/proc/$pid/stat" 2>/dev/null || true)
  printf 'pid=%s\nsession=%s\nworktree=%s\nstarted=%s\n' "$pid" "$session" "$root" "$started" > "$dir/$session"
}

# A worktree with no sessions registered counts zero, and so does the main checkout.
assert_equals "$(bash "$GUARD" count "$WT")" "0" "empty worktree count"
assert_equals "$(bash "$GUARD" count "$MAIN")" "0" "main checkout count"

# A lone session registers a lease and stays quiet.
output=$(hook_input session-a "$WT" | bash "$GUARD" register)
assert_equals "$output" "" "single session output"
assert_equals "$(bash "$GUARD" count "$WT")" "1" "single session count"
[ -f "$(lease_dir_for "$WT")/session-a" ] || fail "Expected a lease file for session-a"

# A second live session in the same worktree is the hazard: warn, and tell the
# model not to remove the worktree.
sleep 60 &
PEER_PID=$!
seed_lease session-peer "$PEER_PID" "$WT"
output=$(hook_input session-a "$WT" | bash "$GUARD" register)
assert_contains "$output" "[worktree-cotenancy] 2 live Claude sessions share this worktree"
assert_contains "$output" "branch feature"
assert_contains "$output" "session-peer(pid $PEER_PID)"
assert_contains "$output" "Keep worktree"
assert_contains "$output" "additionalContext"
assert_equals "$(bash "$GUARD" count "$WT")" "2" "two session count"

# Sessions that died without releasing must not keep warning forever.
kill "$PEER_PID" 2>/dev/null || true
wait "$PEER_PID" 2>/dev/null || true
PEER_PID=""
assert_equals "$(bash "$GUARD" count "$WT")" "1" "count after peer died"
[ -f "$(lease_dir_for "$WT")/session-peer" ] && fail "Expected the dead lease to be collected"

# A recycled pid is not the original session: the recorded start time rules it out.
seed_lease session-recycled "$$" "$WT"
sed -i 's/^started=.*/started=1/' "$(lease_dir_for "$WT")/session-recycled"
assert_equals "$(bash "$GUARD" count "$WT")" "1" "count ignoring recycled pid"

# A lease naming a different worktree never counts, so a key collision cannot
# inflate the total.
dir=$(lease_dir_for "$WT")
mkdir -p "$dir"
printf 'pid=%s\nsession=elsewhere\nworktree=/somewhere/else\nstarted=\n' "$$" > "$dir/session-elsewhere"
assert_equals "$(bash "$GUARD" count "$WT")" "1" "count ignoring foreign worktree lease"
rm -f "$dir/session-elsewhere"

# Releasing drops the lease.
hook_input session-a "$WT" | bash "$GUARD" release
assert_equals "$(bash "$GUARD" count "$WT")" "0" "count after release"

# The main checkout is never at risk from the exit dialog, so it takes no lease.
output=$(hook_input session-main "$MAIN" | bash "$GUARD" register)
assert_equals "$output" "" "main checkout output"
[ -d "$(lease_dir_for "$MAIN")" ] && fail "Expected no lease directory for the main checkout"

# Background and daemon sessions never reach the exit dialog, so they take no lease.
output=$(hook_input session-bg "$WT" | CLAUDE_CODE_SESSION_KIND=bg bash "$GUARD" register)
assert_equals "$output" "" "background session output"
assert_equals "$(bash "$GUARD" count "$WT")" "0" "background session count"

# Several sessions of one Claude process (resume, compact, in-process children)
# are one co-tenant, not many.
sleep 60 &
PEER_PID=$!
seed_lease session-one "$PEER_PID" "$WT"
seed_lease session-two "$PEER_PID" "$WT"
assert_equals "$(bash "$GUARD" count "$WT")" "1" "count deduplicated by process"
output=$(hook_input session-three "$WT" | bash "$GUARD" register)
assert_contains "$output" "2 live Claude sessions share this worktree"
kill "$PEER_PID" 2>/dev/null || true
wait "$PEER_PID" 2>/dev/null || true
PEER_PID=""
rm -rf "$(lease_dir_for "$WT")"

# A directory outside any repository is not a worktree.
mkdir -p "$TEST_ROOT/plain"
assert_equals "$(bash "$GUARD" count "$TEST_ROOT/plain")" "0" "non-repository count"
output=$(hook_input session-plain "$TEST_ROOT/plain" | bash "$GUARD" register)
assert_equals "$output" "" "non-repository output"

# Session ids arrive from outside and land in a path, so separators are stripped
# and leading dots removed — a dotted name would hide the lease from the store.
output=$(hook_input "../escape/id" "$WT" | bash "$GUARD" register)
[ -f "$(lease_dir_for "$WT")/escapeid" ] || fail "Expected the session id to be sanitised"
assert_equals "$(bash "$GUARD" count "$WT")" "1" "sanitised session count"

printf 'All worktree-cotenancy tests passed\n'
