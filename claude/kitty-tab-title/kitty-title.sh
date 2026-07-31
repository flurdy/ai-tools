#!/usr/bin/env bash

EVENT="$1"
PAYLOAD=$(cat)
LOG_FILE=${CLAUDE_KITTY_TITLE_LOG:-/tmp/claude-kitty-title.log}
{
  printf '%s event=%s ' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$EVENT"
  printf '%s' "$PAYLOAD" | python3 -c "import sys,json; d=json.load(sys.stdin); print('cwd=' + d.get('cwd','') + ' tool=' + d.get('tool_name',''))" 2>/dev/null || true
} >> "$LOG_FILE" 2>/dev/null || true

CWD=$(printf '%s' "$PAYLOAD" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('cwd',''))" 2>/dev/null)
SESSION_ID=$(printf '%s' "$PAYLOAD" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null)
TRANSCRIPT_PATH=$(printf '%s' "$PAYLOAD" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('transcript_path',''))" 2>/dev/null)
[ -z "$CWD" ] && CWD="$PWD"

GIT_ROOT=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null || true)
GIT_COMMON_DIR=$(git -C "$CWD" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
BRANCH=$(git -C "$CWD" branch --show-current 2>/dev/null || true)

if [ -n "$GIT_ROOT" ]; then
  if [ -n "$GIT_COMMON_DIR" ]; then
    REPO_DIR=$(dirname "$GIT_COMMON_DIR")
    REPO=$(basename "$REPO_DIR")
  else
    REPO=$(basename "$GIT_ROOT")
  fi
  MARK=""
else
  REPO=$(basename "$CWD")
  MARK="󰉋"
fi
[ -z "$REPO" ] && REPO="claude"

display_repo() {
  printf '%s' "${KITTY_TITLE_REPO_ALIAS:-$1}"
}

session_name() {
  [ -n "$SESSION_ID" ] && [ -n "$TRANSCRIPT_PATH" ] || return

  python3 - "$TRANSCRIPT_PATH" "$SESSION_ID" <<'PY'
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import secrets
import stat as stat_module
import sys

MAX_LENGTH = 24
transcript = Path(sys.argv[1])
session_id = sys.argv[2]


def keep_character(character: str) -> bool:
    code_point = ord(character)
    if 0x30 <= code_point <= 0x39 or 0x41 <= code_point <= 0x5A or 0x61 <= code_point <= 0x7A:
        return True
    if code_point <= 0xBF:
        return False
    if (
        code_point == 0x034F
        or 0x0600 <= code_point <= 0x0605
        or code_point == 0x061C
        or code_point == 0x06DD
        or code_point == 0x070F
        or 0x0890 <= code_point <= 0x0891
        or code_point == 0x08E2
        or 0x115F <= code_point <= 0x1160
        or 0x17B4 <= code_point <= 0x17B5
        or 0x180B <= code_point <= 0x180F
        or 0x2000 <= code_point <= 0x206F
        or 0x2190 <= code_point <= 0x303F
        or code_point == 0x3164
        or 0xD800 <= code_point <= 0xDFFF
        or 0xFE00 <= code_point <= 0xFE0F
        or code_point == 0xFEFF
        or code_point == 0xFFA0
        or 0xFFF0 <= code_point <= 0xFFFF
        or code_point == 0x110BD
        or code_point == 0x110CD
        or 0x13430 <= code_point <= 0x1343F
        or 0x1BCA0 <= code_point <= 0x1BCAF
        or 0x1D173 <= code_point <= 0x1D17A
        or 0x1F000 <= code_point <= 0x1FAFF
        or 0xE0000 <= code_point <= 0xE0FFF
        or 0xFDD0 <= code_point <= 0xFDEF
        or (code_point & 0xFFFF) >= 0xFFFE
    ):
        return False
    return True


def normalize(value: str) -> str:
    parts: list[str] = []
    separator = False
    for character in value:
        if keep_character(character):
            if separator and parts:
                parts.append("-")
            parts.append(character)
            separator = False
        else:
            separator = bool(parts)
    return "".join(parts)[:MAX_LENGTH].rstrip("-")


if not re.fullmatch(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", session_id):
    raise SystemExit
if transcript.name != f"{session_id}.jsonl" or not transcript.is_file():
    raise SystemExit

try:
    stat = transcript.stat()
except OSError:
    raise SystemExit

default_cache_dir = Path(os.environ.get("XDG_RUNTIME_DIR", f"/tmp/ai-tools-kitty-{os.getuid()}"))
cache_dir = Path(os.environ.get("CLAUDE_KITTY_TITLE_CACHE_DIR", str(default_cache_dir)))
try:
    cache_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    cache_dir_stat = cache_dir.lstat()
    if (
        not stat_module.S_ISDIR(cache_dir_stat.st_mode)
        or cache_dir_stat.st_uid != os.getuid()
        or cache_dir_stat.st_mode & 0o077
    ):
        raise SystemExit
except OSError:
    raise SystemExit
cache_path = cache_dir / f"kitty-title-claude-{session_id}.json"
cache_keys = {"version", "path", "device", "inode", "offset", "mtime_ns", "title", "title_offset"}
max_record_bytes = 1024 * 1024
start = 0
title = ""
title_offset: int | None = None


def title_at(offset: int) -> str | None:
    try:
        with transcript.open("rb") as source:
            source.seek(offset)
            raw_line = source.readline(max_record_bytes + 1)
    except OSError:
        return None
    if len(raw_line) > max_record_bytes or not raw_line.endswith(b"\n"):
        return None
    try:
        entry = json.loads(raw_line)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if (
        not isinstance(entry, dict)
        or entry.get("type") != "custom-title"
        or entry.get("sessionId") != session_id
        or not isinstance(entry.get("customTitle"), str)
    ):
        return None
    return normalize(entry["customTitle"])


try:
    cache_stat = cache_path.lstat()
    if (
        stat_module.S_ISREG(cache_stat.st_mode)
        and cache_stat.st_uid == os.getuid()
        and not cache_stat.st_mode & 0o077
    ):
        cached = json.loads(cache_path.read_text())
        offset = cached.get("offset") if isinstance(cached, dict) else None
        cached_title_offset = cached.get("title_offset") if isinstance(cached, dict) else None
        schema_valid = (
            isinstance(cached, dict)
            and set(cached) == cache_keys
            and type(cached.get("version")) is int
            and cached.get("version") == 1
            and isinstance(cached.get("path"), str)
            and type(cached.get("device")) is int
            and type(cached.get("inode")) is int
            and type(offset) is int
            and type(cached.get("mtime_ns")) is int
            and isinstance(cached.get("title"), str)
            and (cached_title_offset is None or type(cached_title_offset) is int)
        )
        if schema_valid and (
            cached["path"] == str(transcript)
            and cached["device"] == stat.st_dev
            and cached["inode"] == stat.st_ino
            and 0 <= offset <= stat.st_size
        ):
            boundary_valid = offset == 0
            if offset > 0:
                with transcript.open("rb") as source:
                    source.seek(offset - 1)
                    boundary_valid = source.read(1) == b"\n"
            normalized_cached_title = normalize(cached["title"])
            source_valid = normalized_cached_title == cached["title"]
            if normalized_cached_title:
                source_valid = (
                    source_valid
                    and type(cached_title_offset) is int
                    and 0 <= cached_title_offset < offset
                    and title_at(cached_title_offset) == normalized_cached_title
                )
            else:
                source_valid = source_valid and cached_title_offset is None
            if boundary_valid and source_valid:
                start = offset
                title = normalized_cached_title
                title_offset = cached_title_offset
                if start == stat.st_size and cached["mtime_ns"] != stat.st_mtime_ns:
                    start = 0
                    title = ""
                    title_offset = None
except (OSError, ValueError, TypeError, json.JSONDecodeError):
    pass

safe_offset = start
try:
    with transcript.open("rb") as handle:
        handle.seek(start)
        while True:
            line_start = handle.tell()
            raw_line = handle.readline(max_record_bytes + 1)
            if not raw_line:
                break
            if len(raw_line) > max_record_bytes:
                contains_custom_title = b"custom-title" in raw_line
                complete = raw_line.endswith(b"\n")
                while not complete:
                    chunk = handle.readline(65536)
                    if not chunk:
                        break
                    contains_custom_title = contains_custom_title or b"custom-title" in chunk
                    complete = chunk.endswith(b"\n")
                if not complete:
                    break
                safe_offset = handle.tell()
                if contains_custom_title:
                    title = ""
                    title_offset = None
                continue
            if not raw_line.endswith(b"\n"):
                break
            safe_offset = handle.tell()
            try:
                entry = json.loads(raw_line)
            except (UnicodeDecodeError, json.JSONDecodeError):
                if b"custom-title" in raw_line:
                    title = ""
                    title_offset = None
                continue
            if not isinstance(entry, dict) or entry.get("type") != "custom-title":
                continue
            if entry.get("sessionId") != session_id or not isinstance(entry.get("customTitle"), str):
                title = ""
                title_offset = None
                continue
            title = normalize(entry["customTitle"])
            title_offset = line_start if title else None
except OSError:
    raise SystemExit

try:
    end_stat = transcript.stat()
except OSError:
    raise SystemExit
record = {
    "version": 1,
    "path": str(transcript),
    "device": stat.st_dev,
    "inode": stat.st_ino,
    "offset": safe_offset,
    "mtime_ns": end_stat.st_mtime_ns,
    "title": title,
    "title_offset": title_offset,
}
temporary = cache_path.with_name(f".{cache_path.name}.{os.getpid()}.{secrets.token_hex(4)}")
try:
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        json.dump(record, output, separators=(",", ":"))
    temporary.replace(cache_path)
except OSError:
    temporary.unlink(missing_ok=True)

print(title)
PY
}

display_bead() {
  local bead="$1" marker=""
  if [[ "$bead" == ✓* ]]; then
    marker="✓"
    bead="${bead#✓}"
  fi
  bead="${bead#"$REPO"-}"
  printf '%s%s' "$marker" "$bead"
}

role_for_prompt() {
  case "$1" in
    /watch-release|/watch-release\ *|\$watch-release|\$watch-release\ *)
      printf '🚢-releases'
      ;;
    /watch-prs|/watch-prs\ *|\$watch-prs|\$watch-prs\ *)
      printf '👀-PRs'
      ;;
  esac
}

session_role() {
  [ -n "$SESSION_ID" ] || return

  local session_key role_file prompt role
  session_key=$(printf '%s' "$SESSION_ID" | tr -cd 'A-Za-z0-9._-')
  [ -n "$session_key" ] || return
  role_file="/tmp/kitty-role-claude-$session_key"

  if [ "$EVENT" = "UserPromptSubmit" ]; then
    prompt=$(printf '%s' "$PAYLOAD" | jq -r '.prompt // empty' 2>/dev/null)
    role=$(role_for_prompt "$prompt")
    [ -n "$role" ] && printf '%s' "$role" > "$role_file"
  fi

  [ -r "$role_file" ] && sed -E 's/[[:space:]]+/-/g' "$role_file"
}

short_branch() {
  local branch="$1"
  branch="${branch#worktree-}"
  branch="${branch#feature/}"
  branch="${branch#fix/}"
  branch="${branch#bugfix/}"
  branch="${branch#chore/}"

  case "$branch" in
    main|master|trunk|"") printf '' ;;
    pr-[0-9]*|PR-[0-9]*) printf '%s' "$(printf '%s' "$branch" | sed -E 's/^([Pp][Rr]-[0-9]+).*/\1/')" ;;
    [A-Za-z][A-Za-z]-[0-9]*|[A-Za-z][A-Za-z][A-Za-z]-[0-9]*) printf '%s' "$(printf '%s' "$branch" | sed -E 's/^([A-Za-z]+-[0-9]+).*/\1/')" ;;
    *-*) printf '%s' "${branch%%-*}" ;;
    *) printf '%s' "$branch" ;;
  esac
}

session_bead() {
  case "$BRANCH" in
    main|master|trunk|"") ;;
    *) return ;;
  esac

  local beads_root="$CWD"
  while [ "$beads_root" != "/" ] && [ ! -d "$beads_root/.beads" ]; do
    beads_root=$(dirname "$beads_root")
  done
  [ -d "$beads_root/.beads" ] || return

  local issues_file="$beads_root/.beads/issues.jsonl"
  [ -r "$issues_file" ] || return
  local interactions_file="$beads_root/.beads/interactions.jsonl"
  if [ -r "$interactions_file" ]; then
    local issues_mtime interactions_mtime
    issues_mtime=$(stat -c %Y "$issues_file" 2>/dev/null || echo 0)
    interactions_mtime=$(stat -c %Y "$interactions_file" 2>/dev/null || echo 0)
    [ $((interactions_mtime - issues_mtime)) -gt 10 ] && return
  fi

  local session_key state_file evidence candidates candidate count status
  session_key=${SESSION_ID:-$(printf '%s' "$CWD|$PPID" | cksum | cut -d' ' -f1)}
  session_key=$(printf '%s' "$session_key" | tr -cd 'A-Za-z0-9._-')
  state_file="/tmp/kitty-bead-session-$session_key"

  evidence=$(printf '%s' "$PAYLOAD" | jq -r '
    [
      .prompt?,
      .tool_input.command?,
      .tool_input.args?,
      .tool_input.issue_id?,
      .tool_input.id?
    ] | map(select(type == "string")) | join("\n")
  ' 2>/dev/null)

  candidates=$(printf '%s' "$evidence" \
    | grep -Eo '[A-Za-z][A-Za-z0-9_-]*-[A-Za-z0-9]+([.][0-9]+)?' \
    | awk '!seen[$0]++' || true)
  candidate=""
  count=0
  while IFS= read -r bead; do
    [ -z "$bead" ] && continue
    if jq -e --arg id "$bead" 'select(.id == $id)' "$issues_file" >/dev/null 2>&1; then
      candidate="$bead"
      count=$((count + 1))
    fi
  done <<< "$candidates"

  if [ "$count" -eq 1 ]; then
    printf '%s' "$candidate" > "$state_file"
  elif [ -s "$state_file" ]; then
    candidate=$(cat "$state_file")
  else
    candidates=$(jq -r 'select(.status == "in_progress") | .id' "$issues_file" 2>/dev/null)
    count=$(printf '%s\n' "$candidates" | sed '/^$/d' | wc -l)
    if [ "$count" -eq 1 ]; then
      candidate=$(printf '%s\n' "$candidates" | sed -n '1p')
      printf '%s' "$candidate" > "$state_file"
    elif [ "$count" -eq 0 ]; then
      candidate=$(jq -rs '
        map(select(.status == "closed"))
        | sort_by(.closed_at // .updated_at // "")
        | last.id // empty
      ' "$issues_file" 2>/dev/null)
      [ -n "$candidate" ] && printf '%s' "$candidate" > "$state_file"
    else
      candidate=""
    fi
  fi

  [ -z "$candidate" ] && return
  status=$(jq -r --arg id "$candidate" 'select(.id == $id) | .status' "$issues_file" 2>/dev/null)
  [ "$status" = "closed" ] && candidate="✓$candidate"
  printf '%s' "$candidate"
}

BRANCH_SHORT=$(short_branch "$BRANCH")
REPO_DISPLAY=$(display_repo "$REPO")
SESSION_NAME=$(session_name)
ROLE=$(session_role)
LABEL="$MARK-$REPO_DISPLAY"
if [ -n "$SSH_TTY" ]; then
  REMOTE_PREFIX="🌐"
  [ -n "$KITTY_TITLE_HOST_ALIAS" ] && REMOTE_PREFIX="$REMOTE_PREFIX$KITTY_TITLE_HOST_ALIAS/"
  LABEL="$REMOTE_PREFIX·$LABEL"
fi
if [ -n "$SESSION_NAME" ]; then
  LABEL="$LABEL/$SESSION_NAME"
elif [ -n "$BRANCH_SHORT" ]; then
  LABEL="$LABEL/$BRANCH_SHORT"
else
  BEAD=$(session_bead)
  [ -n "$BEAD" ] && LABEL="$LABEL/$(display_bead "$BEAD")"
fi
[ -z "$SESSION_NAME" ] && [ -n "$ROLE" ] && LABEL="$LABEL·$ROLE"

case "$EVENT" in
  SessionStart)
    TITLE="$LABEL·🌱"
    ;;
  UserPromptSubmit)
    TITLE="$LABEL·💭"
    ;;
  PreToolUse)
    TITLE="$LABEL·⚙️"
    ;;
  PostToolUse)
    TITLE="$LABEL·💭"
    ;;
  Stop)
    TITLE="$LABEL·✅"
    ;;
  PermissionRequest)
    TOOL=$(echo "$PAYLOAD" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_name',''))" 2>/dev/null)
    case "$TOOL" in
      AskUserQuestion) TITLE="$LABEL·❔" ;;
      *) TITLE="$LABEL·❓" ;;
    esac
    ;;
  Notification)
    # Passive Claude notifications are usually recaps/timing noise; keep the previous useful tab state.
    exit 0
    ;;
  PreCompact)
    TITLE="$LABEL·🧹"
    ;;
  *)
    TITLE="$LABEL"
    ;;
esac

set_kitty_tab_title() {
  if [ -n "$SSH_TTY" ]; then
    local command
    command=$(jq -cn --arg title "$TITLE" \
      '{cmd:"set-tab-title",version:[0,26,0],no_response:true,payload:{title:$title}}')
    printf '\eP@kitty-cmd%s\e\\' "$command" > "$SSH_TTY"
  elif command -v kitten >/dev/null 2>&1; then
    kitten @ set-tab-title "$TITLE" >/dev/null 2>&1 \
      || kitten @ --to unix:@kitty set-tab-title "$TITLE" >/dev/null 2>&1
  fi
}

# Hooks run with captured stdout, so keep title writes quiet.
set_kitty_tab_title 2>/dev/null || true

# Fallback for kitty without remote control enabled.
(
  exec 2>/dev/null
  TITLE_TTY=${SSH_TTY:-/dev/tty}
  printf "\e]30;%s\a" "$TITLE" > "$TITLE_TTY" || true
  printf "\e]2;%s\a" "$TITLE" > "$TITLE_TTY" || true
) || true
