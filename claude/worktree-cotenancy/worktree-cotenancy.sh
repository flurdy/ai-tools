#!/usr/bin/env bash
# Detects when more than one live Claude Code session shares a linked git worktree.
#
# Claude Code's exit dialog offers "Remove worktree", which unlocks the worktree,
# runs `git worktree remove --force` and deletes the branch. It has no notion of a
# second session attached to the same path, so exiting one session can delete the
# working directory of another and discard its commits. Nothing outside Claude Code
# can block that removal: /exit is not a tool, so PreToolUse never sees it, and
# SessionEnd cannot veto. This guard makes the hazard visible instead — at session
# start, and continuously in the statusline via `count`.
#
# Modes:
#   register  SessionStart hook. Records a lease and warns about existing co-tenants.
#   release   SessionEnd hook. Drops this session's lease.
#   count     Prints the number of live sessions holding the worktree at $1 (or $PWD).
#   list      Prints one "pid session started" line per live lease, for debugging.

set -uo pipefail

LEASE_ROOT="${CLAUDE_WORKTREE_LEASE_DIR:-$HOME/.claude/worktree-leases}"

# --- Process liveness ---------------------------------------------------------
# A lease records pid plus that process's kernel start time, so a recycled pid
# never reads as the original session. Non-Linux systems have no /proc: start
# time is unavailable, and liveness degrades to a plain pid check.

proc_field_after_comm() {
  # /proc/<pid>/stat fields from 3 (state) onwards. comm is parenthesised and may
  # contain spaces, so everything up to the last ')' is dropped first.
  local pid=$1 index=$2 stat
  stat=$(< "/proc/$pid/stat") 2>/dev/null || return 1
  stat=${stat##*') '}
  # shellcheck disable=SC2086
  set -- $stat
  [ "$#" -ge "$index" ] || return 1
  printf '%s' "${!index}"
}

process_start_time() {
  proc_field_after_comm "$1" 20
}

process_parent() {
  proc_field_after_comm "$1" 2
}

process_is_live() {
  local pid=$1 recorded=$2 current
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [ -n "$recorded" ] || return 0
  current=$(process_start_time "$pid") || return 0
  [ "$current" = "$recorded" ]
}

# The hook may be spawned through a shell wrapper, whose pid dies immediately and
# would make the lease look stale at once. Walk up to the first non-shell ancestor,
# which is the Claude Code process however it was installed.
owner_pid() {
  local pid=$PPID depth=0 comm
  while [ "${pid:-0}" -gt 1 ] && [ "$depth" -lt 12 ]; do
    comm=$(< "/proc/$pid/comm") 2>/dev/null || break
    case "$comm" in
      sh|bash|dash|zsh|fish|ksh|env|timeout) ;;
      *) printf '%s' "$pid"; return 0 ;;
    esac
    pid=$(process_parent "$pid") || break
    depth=$((depth + 1))
  done
  printf '%s' "$PPID"
}

# --- Lease store --------------------------------------------------------------

worktree_root() {
  local dir=$1 top
  top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || return 1
  [ -n "$top" ] || return 1
  cd "$top" 2>/dev/null && pwd -P
}

# True only for a linked worktree: its per-worktree git dir differs from the shared
# common dir. Both are resolved to absolute form first, because from a subdirectory
# of an ordinary repo --git-common-dir is relative and would otherwise false-flag.
is_linked_worktree() {
  local dir=$1 gitdir commondir
  gitdir=$(git -C "$dir" rev-parse --path-format=absolute --git-dir 2>/dev/null) || return 1
  commondir=$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  [ -n "$gitdir" ] && [ "$gitdir" != "$commondir" ]
}

lease_dir() {
  local root=$1 key
  key=$(printf '%s' "$root" | cksum | tr -cd '0-9' | cut -c1-12)
  printf '%s/%s' "$LEASE_ROOT" "$key"
}

# Emits "session pid started" for every live lease on $1, dropping dead ones as it
# goes. Leases naming a different worktree are ignored, so a key collision between
# two paths cannot inflate the count. One Claude process can hold several sessions
# (resume, compact, in-process children) and only counts once: the risk is a second
# process, since that is what drives its own exit dialog.
live_leases() {
  local root=$1 dir lease session pid started leased
  local -A counted=()
  dir=$(lease_dir "$root")
  [ -d "$dir" ] || return 0
  for lease in "$dir"/*; do
    [ -f "$lease" ] || continue
    pid="" started="" leased=""
    while IFS='=' read -r key value; do
      case "$key" in
        pid) pid=$value ;;
        started) started=$value ;;
        worktree) leased=$value ;;
      esac
    done < "$lease"
    if [ "$leased" != "$root" ]; then
      continue
    fi
    if ! process_is_live "$pid" "$started"; then
      rm -f "$lease"
      continue
    fi
    [ -n "${counted[$pid]:-}" ] && continue
    counted[$pid]=1
    session=${lease##*/}
    printf '%s %s %s\n' "$session" "$pid" "$started"
  done
  rmdir "$dir" 2>/dev/null
  return 0
}

# --- Hook input ---------------------------------------------------------------

read_hook_field() {
  local payload=$1 field=$2 value
  if command -v jq >/dev/null 2>&1; then
    value=$(printf '%s' "$payload" | jq -r --arg f "$field" '.[$f] // empty' 2>/dev/null)
  else
    value=$(printf '%s' "$payload" | sed -n "s/.*\"$field\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1)
  fi
  printf '%s' "$value"
}

# Session ids reach the filesystem as lease names, so anything outside a safe set
# is folded away rather than trusted. Leading dots go too: they would hide the
# lease from the glob that reads the store, and "." and ".." are not names at all.
safe_session_id() {
  local raw=$1 clean
  clean=$(printf '%s' "$raw" | tr -cd 'A-Za-z0-9._-')
  while [ "${clean:0:1}" = "." ]; do clean=${clean#.}; done
  printf '%s' "${clean:0:128}"
}

json_escape() {
  local text=$1
  text=${text//\\/\\\\}
  text=${text//\"/\\\"}
  text=${text//$'\n'/\\n}
  printf '%s' "$text"
}

emit_warning() {
  local message=$1 context=$2
  printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' \
    "$(json_escape "$message")" "$(json_escape "$context")"
}

# --- Modes --------------------------------------------------------------------

mode_register() {
  local payload session cwd root dir pid started branch peers count
  payload=$(cat)

  # Background and daemon sessions never reach the exit dialog, so they neither
  # endanger a worktree nor need warning about one. (CLAUDE_CODE_CHILD_SESSION is
  # no use here: it is exported into tool environments generally, not just to
  # child sessions. In-process children are folded in by owner pid instead.)
  case "${CLAUDE_CODE_SESSION_KIND:-}" in bg|daemon|daemon-worker) return 0 ;; esac

  cwd=$(read_hook_field "$payload" cwd)
  [ -n "$cwd" ] || cwd=$PWD
  [ -d "$cwd" ] || return 0
  is_linked_worktree "$cwd" || return 0
  root=$(worktree_root "$cwd") || return 0

  session=$(safe_session_id "$(read_hook_field "$payload" session_id)")
  [ -n "$session" ] || session="unknown-$$"

  pid=$(owner_pid)
  started=$(process_start_time "$pid")
  dir=$(lease_dir "$root")
  mkdir -p "$dir" 2>/dev/null || return 0
  printf 'pid=%s\nsession=%s\nworktree=%s\nstarted=%s\n' \
    "$pid" "$session" "$root" "$started" > "$dir/$session.tmp.$$" 2>/dev/null || return 0
  mv -f "$dir/$session.tmp.$$" "$dir/$session" 2>/dev/null || return 0

  peers=$(live_leases "$root" | awk -v self="$pid" '$2 != self')
  [ -n "$peers" ] || return 0
  count=$(( $(printf '%s\n' "$peers" | wc -l) + 1 ))

  branch=$(git -C "$root" symbolic-ref --short -q HEAD 2>/dev/null)
  emit_warning \
    "[worktree-cotenancy] $count live Claude sessions share this worktree ($root${branch:+, branch $branch}). Choosing \"Remove worktree\" when any of them exits deletes this directory and force-deletes the branch, discarding the other sessions' commits and uncommitted work. Choose \"Keep worktree\" at /exit. Other sessions: $(printf '%s' "$peers" | awk '{printf "%s(pid %s) ", $1, $2}')" \
    "Another live Claude Code session is working in this same worktree ($root). Claude Code's exit dialog cannot see it: selecting \"Remove worktree\" removes the directory with git worktree remove --force and deletes the branch, destroying the other session's work. Never remove this worktree, and if the user exits, tell them to choose \"Keep worktree\"."
}

mode_release() {
  local payload session cwd root dir
  payload=$(cat)
  cwd=$(read_hook_field "$payload" cwd)
  [ -n "$cwd" ] || cwd=$PWD
  [ -d "$cwd" ] || return 0
  root=$(worktree_root "$cwd") || return 0
  session=$(safe_session_id "$(read_hook_field "$payload" session_id)")
  [ -n "$session" ] || return 0
  dir=$(lease_dir "$root")
  rm -f "$dir/$session"
  live_leases "$root" >/dev/null
}

mode_count() {
  local dir=${1:-$PWD} root count
  root=$(worktree_root "$dir") || { printf '0\n'; return 0; }
  count=$(live_leases "$root" | wc -l)
  printf '%s\n' "$count"
}

mode_list() {
  local dir=${1:-$PWD} root
  root=$(worktree_root "$dir") || return 0
  live_leases "$root"
}

case "${1:-}" in
  register) mode_register ;;
  release)  mode_release ;;
  count)    mode_count "${2:-$PWD}" ;;
  list)     mode_list "${2:-$PWD}" ;;
  *)
    printf 'usage: %s register|release|count [dir]|list [dir]\n' "${0##*/}" >&2
    exit 2
    ;;
esac
