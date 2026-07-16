#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CL_GATHER="$ROOT/claude/launcher/cl-gather"
PL_GATHER="$ROOT/pi/launcher/pl-gather"
CL_MKWORKTREE="$ROOT/claude/launcher/cl-mkworktree"
PL_MKWORKTREE="$ROOT/pi/launcher/pl-mkworktree"

if [ "${BASH_VERSINFO[0]}" -lt 4 ]; then
  echo "launcher tests require Bash 4+" >&2
  exit 1
fi

fail() { echo "launcher test failed: $*" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
repo="$tmp/project"
home="$tmp/home"
bin="$tmp/bin"
mkdir -p "$repo" "$home" "$bin"

git -C "$repo" init -q -b main
git -C "$repo" config user.name "Launcher Test"
git -C "$repo" config user.email launcher-test@example.com
printf 'base\n' > "$repo/file.txt"
git -C "$repo" add file.txt
git -C "$repo" commit -qm init

mkdir -p \
  "$repo/.claude" \
  "$repo/.pi" \
  "$repo/node_modules" \
  "$repo/packages/pkg/node_modules"
printf '{}\n' > "$repo/.claude/settings.local.json"
printf '{"pi":true}\n' > "$repo/.pi/settings.json"
printf '{"local":true}\n' > "$repo/.pi/settings.local.json"

# Fake optional dependencies to keep the test offline and make picker behavior
# observable.
cat > "$bin/gh" <<'EOF'
#!/usr/bin/env bash
count=0
[ ! -f "$GH_COUNT" ] || count=$(cat "$GH_COUNT")
printf '%s\n' "$((count + 1))" > "$GH_COUNT"
printf 'feature/a\t12\tapproved\n'
EOF
cat > "$bin/fzf" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$FZF_LOG"
IFS= read -r first
printf '%s\n%s\n' "${FZF_KEY:-}" "$first"
EOF
chmod +x "$bin/gh" "$bin/fzf"
TEST_PATH="$bin:/usr/bin:/bin"

# Both names use the same context engine and PR cache.
cl_rows=$(cd "$repo" && HOME="$home" XDG_CACHE_HOME="$tmp/cache" \
  GH_COUNT="$tmp/gh-count" PATH="$TEST_PATH" "$CL_GATHER" --list)
pl_rows=$(cd "$repo" && HOME="$home" XDG_CACHE_HOME="$tmp/cache" \
  GH_COUNT="$tmp/gh-count" PATH="$TEST_PATH" "$PL_GATHER" --list)
[ "$cl_rows" = "$pl_rows" ] || fail "provider context rows differ"
[ "$(cat "$tmp/gh-count")" = 1 ] || fail "providers did not share the PR cache"
printf '%s\n' "$cl_rows" | grep -q $'\tmain\t' || fail "main row missing"
printf '%s\n' "$cl_rows" | grep -q $'+ new worktree\tnew\t' || fail "new row missing"

# Handoff records include the time in field 15. The launcher displays it and
# sorts by the full timestamp, rather than the source script's filename order.
cat > "$tmp/handoff-list" <<EOF
#!/usr/bin/env bash
echo '---CURRENT-REPO---'
echo '$repo/.git'
echo '---HANDOFFS-DIR---'
echo '$home/.claude/handoffs'
echo '---HANDOFFS---'
echo '2026-07-15-early.md|2026-07-15|early|$repo|main|$repo/.git|Y||||||||00:30'
echo '2026-07-15-latest.md|2026-07-15|latest|$repo|main|$repo/.git|Y||||||||17:12'
echo '2026-07-15-middle.md|2026-07-15|middle|$repo|main|$repo/.git|Y||||||||04:31'
EOF
chmod +x "$tmp/handoff-list"
handoff_rows=$(cd "$repo" && HOME="$home" XDG_CACHE_HOME="$tmp/cache" \
  GH_COUNT="$tmp/gh-count" PATH="$TEST_PATH" AI_HANDOFF_LIST="$tmp/handoff-list" \
  "$PL_GATHER" --list | awk -F '\t' '$2 == "handoff" { print $1 }')
expected_handoffs=$(printf '%s\n' \
  "handoff: latest   (2026-07-15 17:12 · $repo)" \
  "handoff: middle   (2026-07-15 04:31 · $repo)" \
  "handoff: early   (2026-07-15 00:30 · $repo)")
[ "$handoff_rows" = "$expected_handoffs" ] || fail "handoffs were not timestamped and newest-first"

# Claude retains its fork capability; Pi does not advertise it.
claude_desc=$(cd "$repo" && HOME="$home" XDG_CACHE_HOME="$tmp/cache" \
  GH_COUNT="$tmp/gh-count" PATH="$TEST_PATH" FZF_LOG="$tmp/cl.args" \
  FZF_KEY=ctrl-f "$CL_GATHER")
pi_desc=$(cd "$repo" && HOME="$home" XDG_CACHE_HOME="$tmp/cache" \
  GH_COUNT="$tmp/gh-count" PATH="$TEST_PATH" FZF_LOG="$tmp/pl.args" \
  "$PL_GATHER")
[ "$(printf '%s' "$claude_desc" | cut -f4)" = fork ] || fail "Claude fork action missing"
[ "$(printf '%s' "$pi_desc" | cut -f4)" = new ] || fail "Pi default action changed"
grep -q -- '--expect=ctrl-n,ctrl-r,ctrl-f,ctrl-w' "$tmp/cl.args" || fail "Claude keys changed"
grep -q -- '--expect=ctrl-n,ctrl-r,ctrl-w' "$tmp/pl.args" || fail "Pi keys changed"
if grep -q ctrl-f "$tmp/pl.args"; then fail "Pi advertised unsupported fork action"; fi

# The documented cp install dereferences repo symlinks but preserves invocation
# names, so agent inference still works.
cp "$CL_GATHER" "$tmp/cl-gather"
cp "$PL_GATHER" "$tmp/pl-gather"
[ ! -L "$tmp/cl-gather" ] && [ ! -L "$tmp/pl-gather" ] || fail "cp preserved symlinks"
(cd "$repo" && HOME="$home" PATH=/usr/bin:/bin "$tmp/cl-gather" --list >/dev/null)
(cd "$repo" && HOME="$home" PATH=/usr/bin:/bin "$tmp/pl-gather" --list >/dev/null)

# Worktrees share a layout and receive setup for both agents.
parent="$tmp/layout with spaces/worktrees"
dest=$(cd "$repo" && HOME="$home" PATH=/usr/bin:/bin \
  AI_WORKTREE_PARENT="$parent" "$CL_MKWORKTREE" feature/a)
[ "$dest" = "$parent/feature-a" ] || fail "unexpected first worktree path"
[ -L "$dest/node_modules" ] || fail "root node_modules link missing"
[ -L "$dest/packages/pkg/node_modules" ] || fail "package node_modules link missing"
cmp -s "$repo/.claude/settings.local.json" "$dest/.claude/settings.local.json" || fail "Claude settings missing"
cmp -s "$repo/.pi/settings.json" "$dest/.pi/settings.json" || fail "Pi settings missing"
cmp -s "$repo/.pi/settings.local.json" "$dest/.pi/settings.local.json" || fail "Pi local settings missing"

# Branch-based reuse ignores a different requested parent and reprovisions setup.
rm "$dest/packages/pkg/node_modules" "$dest/.pi/settings.local.json"
reused=$(cd "$repo" && HOME="$home" PATH=/usr/bin:/bin \
  AI_WORKTREE_PARENT="$tmp/ignored" "$PL_MKWORKTREE" feature/a)
[ "$reused" = "$dest" ] || fail "existing branch worktree was not reused"
[ -L "$dest/packages/pkg/node_modules" ] || fail "reused worktree was not relinked"
cmp -s "$repo/.pi/settings.local.json" "$dest/.pi/settings.local.json" || fail "reused worktree was not reprovisioned"

# Existing parent discovery preserves spaces.
second=$(cd "$repo" && HOME="$home" PATH=/usr/bin:/bin "$PL_MKWORKTREE" feature/b)
[ "$second" = "$parent/feature-b" ] || fail "existing parent with spaces was not reused"

# Branches that collapse to the same slug must not reuse each other's worktree.
if collision_out=$(cd "$repo" && HOME="$home" PATH=/usr/bin:/bin \
  "$PL_MKWORKTREE" feature-a 2>"$tmp/collision.err"); then
  fail "slug collision succeeded: $collision_out"
fi
[ -z "$collision_out" ] || fail "slug collision printed a launch path"
grep -q 'destination collision' "$tmp/collision.err" || fail "slug collision diagnostic missing"

# A failed git worktree add must remain a failure and print no launch path.
mkdir -p "$parent/feature-c"
printf 'occupied\n' > "$parent/feature-c/file"
if failure_out=$(cd "$repo" && HOME="$home" PATH=/usr/bin:/bin \
  "$CL_MKWORKTREE" feature/c 2>"$tmp/failure.err"); then
  fail "failed worktree creation returned success: $failure_out"
fi
[ -z "$failure_out" ] || fail "failed worktree creation printed a launch path"
grep -q 'failed to create worktree' "$tmp/failure.err" || fail "failure diagnostic missing"

printf 'launcher tests: ok\n'
