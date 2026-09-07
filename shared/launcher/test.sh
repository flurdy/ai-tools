#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
CL_GATHER="$ROOT/claude/launcher/cl-gather"
PL_GATHER="$ROOT/pi/launcher/pl-gather"
CL_MKWORKTREE="$ROOT/claude/launcher/cl-mkworktree"
PL_MKWORKTREE="$ROOT/pi/launcher/pl-mkworktree"
PL_FUNCTION="$ROOT/pi/launcher/pl.fish"
CL_FUNCTION="$ROOT/claude/launcher/cl.fish"

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

# The Pi frontend pins a stable launcher baseline so temporary model-tier routes
# in other sessions cannot leak into a new launch through Pi's persisted defaults.
fish -n "$PL_FUNCTION"
fish -n "$CL_FUNCTION"
pl_help=$(HOME="$home" fish -c 'source "$argv[1]"; pl --help' "$PL_FUNCTION")
cl_help=$(HOME="$home" fish -c 'source "$argv[1]"; cl --help' "$CL_FUNCTION")
printf '%s\n' "$pl_help" | grep -q 'ctrl-p=mode ' || fail "Pi help did not label Ctrl-P as mode"
printf '%s\n' "$cl_help" | grep -q 'ctrl-p=mode ' || fail "Claude help did not label Ctrl-P as mode"
nonrepo="$tmp/nonrepo"
mkdir -p "$nonrepo"
pl_default=$(HOME="$home" fish -c 'source "$argv[1]"; cd "$argv[2]"; pl --dry-run' "$PL_FUNCTION" "$nonrepo" 2>/dev/null)
printf '%s\n' "$pl_default" | grep -qF 'pi --model openai-codex/gpt-5.6-sol --thinking high' \
  || fail "Pi launcher fallback defaults missing"

mkdir -p "$home/.pi/agent"
cat > "$home/.pi/agent/pl-launcher.json" <<'EOF'
{
  "defaultModel": "openai-codex/gpt-5.6-terra",
  "defaultThinking": "medium"
}
EOF
pl_configured=$(HOME="$home" fish -c 'source "$argv[1]"; cd "$argv[2]"; pl --dry-run' "$PL_FUNCTION" "$nonrepo" 2>/dev/null)
printf '%s\n' "$pl_configured" | grep -qF 'pi --model openai-codex/gpt-5.6-terra --thinking medium' \
  || fail "Pi launcher config defaults ignored"
pl_override=$(HOME="$home" fish -c 'source "$argv[1]"; cd "$argv[2]"; pl --dry-run --model=anthropic/claude-sonnet-5 --thinking=medium' "$PL_FUNCTION" "$nonrepo" 2>/dev/null)
printf '%s\n' "$pl_override" | grep -qF 'pi --model anthropic/claude-sonnet-5 --thinking medium' \
  || fail "Pi launcher overrides ignored"

# The Pi launcher injects Atlassian credentials only into the child process. It
# reuses the private metadata consumed by jira-mcp and resolves the token from
# the keyring without printing it, putting it in argv, or leaking it afterward.
cat > "$bin/pi" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > "$PI_CAPTURE.args"
env | grep '^ATLASSIAN_' | sort > "$PI_CAPTURE.env" || :
EOF
cat > "$bin/secret-api-key" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > "$KEYRING_LOG"
[ "${SECRET_FAIL:-0}" != 1 ] || exit 1
printf 'fake-atlassian-token\n'
EOF
chmod +x "$bin/pi" "$bin/secret-api-key"
mkdir -p "$home/.dotprivate"
cat > "$home/.dotprivate/jira-mcp.env" <<'EOF'
ATLASSIAN_SITE_NAME=example-site
ATLASSIAN_USER_EMAIL=launcher-test@example.com
JIRA_MCP_KEYRING_PROJECT=example-project
EOF
TEST_PATH="$bin:/usr/bin:/bin"
PI_CAPTURE="$tmp/pi-auth" KEYRING_LOG="$tmp/keyring.log" HOME="$home" PATH="$TEST_PATH" \
  fish -c 'source "$argv[1]"; cd "$argv[2]"; pl; set -q ATLASSIAN_API_TOKEN; and echo leaked; true' \
  "$PL_FUNCTION" "$nonrepo" >"$tmp/pl-auth.out" 2>"$tmp/pl-auth.err"
grep -qxF 'ATLASSIAN_DOMAIN=example-site.atlassian.net' "$tmp/pi-auth.env" || fail "Pi Atlassian domain missing"
grep -qxF 'ATLASSIAN_EMAIL=launcher-test@example.com' "$tmp/pi-auth.env" || fail "Pi Atlassian email missing"
grep -qxF 'ATLASSIAN_API_TOKEN=fake-atlassian-token' "$tmp/pi-auth.env" || fail "Pi Atlassian token missing"
grep -qxF 'lookup atlassian-api-token example-project' "$tmp/keyring.log" || fail "Pi Atlassian keyring lookup changed"
if grep -qF 'fake-atlassian-token' "$tmp/pi-auth.args" "$tmp/pl-auth.out" "$tmp/pl-auth.err"; then
  fail "Pi Atlassian token was exposed"
fi
if grep -qF 'leaked' "$tmp/pl-auth.out"; then fail "Pi Atlassian token leaked into the launcher shell"; fi

rm -f "$tmp/keyring.log"
SECRET_FAIL=1 PI_CAPTURE="$tmp/pi-auth-failed" KEYRING_LOG="$tmp/keyring.log" HOME="$home" PATH="$TEST_PATH" \
  fish -c 'source "$argv[1]"; cd "$argv[2]"; pl' "$PL_FUNCTION" "$nonrepo" \
  >"$tmp/pl-auth-failed.out" 2>"$tmp/pl-auth-failed.err"
[ -f "$tmp/pi-auth-failed.env" ] || fail "Pi did not launch after Atlassian keyring failure"
if grep -q '^ATLASSIAN_' "$tmp/pi-auth-failed.env"; then fail "Pi received partial Atlassian environment"; fi
if grep -qF 'fake-atlassian-token' "$tmp/pl-auth-failed.out" "$tmp/pl-auth-failed.err"; then
  fail "Pi Atlassian failure exposed a token"
fi

mv -f "$home/.dotprivate/jira-mcp.env" "$home/.dotprivate/jira-mcp.env.disabled"
rm -f "$tmp/keyring.log"
PI_CAPTURE="$tmp/pi-auth-missing" KEYRING_LOG="$tmp/keyring.log" HOME="$home" PATH="$TEST_PATH" \
  fish -c 'source "$argv[1]"; cd "$argv[2]"; pl' "$PL_FUNCTION" "$nonrepo" >/dev/null 2>&1
[ -f "$tmp/pi-auth-missing.env" ] || fail "Pi did not launch without Atlassian metadata"
if grep -q '^ATLASSIAN_' "$tmp/pi-auth-missing.env"; then fail "Pi received Atlassian environment without metadata"; fi
[ ! -e "$tmp/keyring.log" ] || fail "Missing Atlassian metadata triggered a keyring lookup"
mv -f "$home/.dotprivate/jira-mcp.env.disabled" "$home/.dotprivate/jira-mcp.env"

rm -f "$tmp/keyring.log"
PI_CAPTURE="$tmp/pi-auth-preset" KEYRING_LOG="$tmp/keyring.log" HOME="$home" PATH="$TEST_PATH" \
  ATLASSIAN_DOMAIN=preset.atlassian.net ATLASSIAN_EMAIL=preset@example.com ATLASSIAN_API_TOKEN=preset-token \
  fish -c 'source "$argv[1]"; cd "$argv[2]"; pl' "$PL_FUNCTION" "$nonrepo" >/dev/null 2>&1
grep -qxF 'ATLASSIAN_API_TOKEN=preset-token' "$tmp/pi-auth-preset.env" || fail "Preset Atlassian environment was not preserved"
[ ! -e "$tmp/keyring.log" ] || fail "Preset Atlassian environment triggered a keyring lookup"

rm -f "$tmp/keyring.log"
HOME="$home" PATH="$TEST_PATH" KEYRING_LOG="$tmp/keyring.log" \
  fish -c 'source "$argv[1]"; cd "$argv[2]"; pl --dry-run' "$PL_FUNCTION" "$nonrepo" >/dev/null 2>&1
[ ! -e "$tmp/keyring.log" ] || fail "Pi dry-run accessed the Atlassian keyring"

if HOME="$home" fish -c 'source "$argv[1]"; cd "$argv[2]"; pl --plan' "$PL_FUNCTION" "$nonrepo" 2>"$tmp/pl-unknown.err"; then
  fail "Pi launcher silently accepted --plan"
fi
grep -q 'ctrl-p' "$tmp/pl-unknown.err" || fail "Pi unknown-mode guidance missing"
if HOME="$home" fish -c 'source "$argv[1]"; cd "$argv[2]"; cl --plan' "$CL_FUNCTION" "$nonrepo" 2>"$tmp/cl-unknown.err"; then
  fail "Claude launcher silently accepted --plan"
fi
grep -q 'ctrl-p' "$tmp/cl-unknown.err" || fail "Claude unknown-mode guidance missing"

git -C "$repo" init -q -b main
git -C "$repo" config user.name "Launcher Test"
git -C "$repo" config user.email launcher-test@example.com
printf 'base\n' > "$repo/file.txt"
git -C "$repo" add file.txt
git -C "$repo" commit -qm init

# Continue/resume keeps the model recorded in that session unless the caller
# explicitly asks to override it.
mkdir -p "$home/.pi/bin"
cat > "$home/.pi/bin/pl-gather" <<EOF
#!/usr/bin/env bash
printf 'worktree\t%s\tmain\tcontinue\t\n' '$repo'
EOF
chmod +x "$home/.pi/bin/pl-gather"
pl_continue=$(HOME="$home" fish -c 'source "$argv[1]"; cd "$argv[2]"; pl --dry-run' "$PL_FUNCTION" "$repo")
printf '%s\n' "$pl_continue" | grep -qxF 'pi --continue' || fail "Pi continue model was overridden"
pl_continue_override=$(HOME="$home" fish -c 'source "$argv[1]"; cd "$argv[2]"; pl --dry-run --model=anthropic/claude-sonnet-5 --thinking=medium' "$PL_FUNCTION" "$repo")
printf '%s\n' "$pl_continue_override" | grep -qxF 'pi --model anthropic/claude-sonnet-5 --thinking medium --continue' \
  || fail "Pi continue override was ignored"

cat > "$home/.pi/bin/pl-gather" <<EOF
#!/usr/bin/env bash
printf 'worktree\\t%s\\tmain\\tcontinue\\t\\tplan\\n' '$repo'
EOF
pl_plan=$(HOME="$home" fish -c 'source "$argv[1]"; cd "$argv[2]"; pl --dry-run' "$PL_FUNCTION" "$repo")
printf '%s\n' "$pl_plan" | grep -qxF 'pi --plan --continue' || fail "Pi picker plan mode was ignored"
cat > "$home/.pi/bin/pl-gather" <<EOF
#!/usr/bin/env bash
printf 'worktree\\t%s\\tmain\\tcontinue\\t\\timplement\\n' '$repo'
EOF
pl_implement=$(HOME="$home" fish -c 'source "$argv[1]"; cd "$argv[2]"; pl --dry-run' "$PL_FUNCTION" "$repo")
printf '%s\n' "$pl_implement" | grep -qxF 'pi --implement --continue' || fail "Pi picker implement mode was ignored"
cat > "$home/.pi/bin/pl-gather" <<EOF
#!/usr/bin/env bash
printf 'worktree\\t%s\\tmain\\tcontinue\\t\\trestore\\n' '$repo'
EOF
pl_restore=$(HOME="$home" fish -c 'source "$argv[1]"; cd "$argv[2]"; pl --dry-run' "$PL_FUNCTION" "$repo")
printf '%s\n' "$pl_restore" | grep -qxF 'pi --continue' || fail "Pi picker restore mode overrode the saved mode"

mkdir -p "$home/.claude/bin"
cat > "$home/.claude/bin/cl-gather" <<EOF
#!/usr/bin/env bash
printf 'main\\t%s\\tmain\\tnew\\t\\tplan\\n' '$repo'
EOF
chmod +x "$home/.claude/bin/cl-gather"
cl_plan=$(HOME="$home" fish -c 'source "$argv[1]"; cd "$argv[2]"; cl --dry-run' "$CL_FUNCTION" "$repo")
printf '%s\n' "$cl_plan" | grep -qxF 'claude --permission-mode plan' || fail "Claude picker plan mode was ignored"
cat > "$home/.claude/bin/cl-gather" <<EOF
#!/usr/bin/env bash
printf 'main\\t%s\\tmain\\tnew\\t\\tauto\\n' '$repo'
EOF
cl_auto=$(HOME="$home" fish -c 'source "$argv[1]"; cd "$argv[2]"; cl --dry-run' "$CL_FUNCTION" "$repo")
printf '%s\n' "$cl_auto" | grep -qxF 'claude --permission-mode auto' || fail "Claude picker auto mode was ignored"
cat > "$home/.claude/bin/cl-gather" <<EOF
#!/usr/bin/env bash
printf 'main\\t%s\\tmain\\tnew\\t\\trestore\\n' '$repo'
EOF
cl_restore=$(HOME="$home" fish -c 'source "$argv[1]"; cd "$argv[2]"; cl --dry-run' "$CL_FUNCTION" "$repo")
printf '%s\n' "$cl_restore" | grep -qxE 'claude[[:space:]]*' || fail "Claude picker restore mode overrode the saved mode"

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
if [ "${GH_FAIL:-}" = 1 ]; then
  exit 1
fi
count=0
[ ! -f "$GH_COUNT" ] || count=$(cat "$GH_COUNT")
printf '%s\n' "$((count + 1))" > "$GH_COUNT"
printf 'feature/a\t12\tapproved\n'
EOF
cat > "$bin/fzf" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" > "$FZF_LOG"
for argument in "$@"; do
  case "$argument" in
    --bind=ctrl-p:transform-header\(*)
      transform=${argument#--bind=ctrl-p:transform-header(}
      transform=${transform%)}
      for ((i = 0; i < ${FZF_TOGGLE_COUNT:-0}; i += 1)); do
        "${SHELL:-/bin/sh}" -c "$transform" >/dev/null 2>&1 || true
      done
      ;;
  esac
done
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

# A failed cold-cache refresh must not try to redirect stdin from a missing file.
failed_pr_output=$(cd "$repo" && HOME="$home" XDG_CACHE_HOME="$tmp/failed-cache" \
  GH_FAIL=1 PATH="$TEST_PATH" "$PL_GATHER" --list 2>&1)
printf '%s\n' "$failed_pr_output" | grep -q $'\tmain\t' || fail "failed PR refresh hid main row"
if printf '%s\n' "$failed_pr_output" | grep -q 'No such file or directory'; then
  fail "failed PR refresh read a missing cache file"
fi

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

# The picker mode is a stateful Ctrl-P cycle that does not close fzf. Restore
# preserves a resumed session's saved mode; the other values are explicit.
mode_file="$tmp/launch-mode"
printf 'restore\n' > "$mode_file"
mode_header=$("$PL_GATHER" --agent=pi --toggle-mode-file="$mode_file")
[ "$(cat "$mode_file")" = plan ] || fail "Pi mode toggle did not select plan"
printf '%s\n' "$mode_header" | grep -q 'mode=plan' || fail "Pi mode header did not show plan"
printf '%s\n' "$mode_header" | grep -q 'ctrl-p=mode' || fail "Pi picker did not label Ctrl-P as mode"
mode_header=$("$PL_GATHER" --agent=pi --toggle-mode-file="$mode_file")
[ "$(cat "$mode_file")" = implement ] || fail "Pi mode toggle did not select implement"
printf '%s\n' "$mode_header" | grep -q 'mode=implement' || fail "Pi mode header did not show implement"
mode_header=$("$PL_GATHER" --agent=pi --toggle-mode-file="$mode_file")
[ "$(cat "$mode_file")" = restore ] || fail "Pi mode toggle did not return to restore"
printf '%s\n' "$mode_header" | grep -q 'mode=restore' || fail "Pi mode header did not show restore"

ln -s "$mode_file" "$tmp/mode-link"
if "$PL_GATHER" --agent=pi --toggle-mode-file="$tmp/mode-link" >/dev/null 2>&1; then fail "symlinked mode state was accepted"; fi

printf 'restore\n' > "$mode_file"
mode_header=$("$CL_GATHER" --agent=claude --toggle-mode-file="$mode_file")
[ "$(cat "$mode_file")" = plan ] || fail "Claude mode toggle did not select plan"
printf '%s\n' "$mode_header" | grep -q 'ctrl-p=mode' || fail "Claude picker did not label Ctrl-P as mode"
"$CL_GATHER" --agent=claude --toggle-mode-file="$mode_file" >/dev/null
[ "$(cat "$mode_file")" = auto ] || fail "Claude mode toggle did not select auto"
"$CL_GATHER" --agent=claude --toggle-mode-file="$mode_file" >/dev/null
[ "$(cat "$mode_file")" = restore ] || fail "Claude mode toggle did not return to restore"

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
grep -qF -- 'ctrl-p:transform-header("$AI_LAUNCH_MODE_CALLBACK"' "$tmp/cl.args" || fail "Claude mode toggle binding is not value-independent"
grep -qF -- 'ctrl-p:transform-header("$AI_LAUNCH_MODE_CALLBACK"' "$tmp/pl.args" || fail "Pi mode toggle binding is not value-independent"
[ "$(printf '%s' "$claude_desc" | cut -f7)" = restore ] || fail "Claude restore mode missing"
[ "$(printf '%s' "$pi_desc" | cut -f7)" = restore ] || fail "Pi restore mode missing"
if grep -q ctrl-f "$tmp/pl.args"; then fail "Pi advertised unsupported fork action"; fi

# Exercise the actual fzf Ctrl-P binding and ensure its descriptor reaches each
# Fish frontend. The private mode file must be removed when the picker returns.
ln -sfn "$PL_GATHER" "$home/.pi/bin/pl-gather"
ln -sfn "$CL_GATHER" "$home/.claude/bin/cl-gather"

# --list preserves both successful rows and the real gather's no-context status.
pl_list=$(cd "$repo" && HOME="$home" XDG_CACHE_HOME="$tmp/cache" \
  GH_COUNT="$tmp/gh-count" PATH="$TEST_PATH" \
  fish -c 'source "$argv[1]"; pl --list' "$PL_FUNCTION")
[ "$pl_list" = "$pl_rows" ] || fail "Pi --list changed successful gather output"
list_status=0
(cd "$nonrepo" && HOME="$home" PATH="$TEST_PATH" \
  fish -c 'source "$argv[1]"; pl --list' "$PL_FUNCTION") >"$tmp/pl-list.out" || list_status=$?
[ "$list_status" -eq 1 ] || fail "Pi --list swallowed no-context failure: $list_status"
[ ! -s "$tmp/pl-list.out" ] || fail "Pi --list launched instead of listing"

mode_tmp="$tmp/mode (1)'"$'\n'" f i\$les"
mkdir -p "$mode_tmp"
fish_path=$(command -v fish)
pl_toggle=$(cd "$repo" && HOME="$home" TMPDIR="$mode_tmp" SHELL="$fish_path" PATH="$TEST_PATH" FZF_LOG="$tmp/pl-toggle.args" FZF_TOGGLE_COUNT=1 \
  fish -c 'source "$argv[1]"; pl --dry-run' "$PL_FUNCTION")
printf '%s\n' "$pl_toggle" | grep -q -- '--plan' || fail "Pi Ctrl-P did not reach Fish mode translation: $pl_toggle"
cl_toggle=$(cd "$repo" && HOME="$home" TMPDIR="$mode_tmp" SHELL="$fish_path" PATH="$TEST_PATH" FZF_LOG="$tmp/cl-toggle.args" FZF_TOGGLE_COUNT=1 \
  fish -c 'source "$argv[1]"; cl --dry-run' "$CL_FUNCTION")
printf '%s\n' "$cl_toggle" | grep -qF 'claude --permission-mode plan' || fail "Claude Ctrl-P did not reach Fish mode translation: $cl_toggle"
if find "$tmp" -name 'ai-launch-mode.*' -print -quit | grep -q .; then fail "picker mode tempfile was not cleaned up"; fi
touch "$tmp/not-a-directory"
if (cd "$repo" && HOME="$home" TMPDIR="$tmp/not-a-directory" PATH="$TEST_PATH" "$PL_GATHER" --agent=pi >/dev/null 2>&1); then
  fail "picker continued after mode tempfile creation failed"
fi

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
