# Claude Kitty Tab Title

Claude Code hook script for showing agent state in Kitty tab titles.

Named session:

```text
-agents/foreman-design·✅
```

Unnamed fallbacks:

```text
-ai-tools/feature·💭
-blc/GE-1793·⚙️
󰉋-scratch·✅
```

## Files

- `kitty-title.sh`: hook command.
- `settings.hooks.fragment.json`: Claude Code hook settings fragment.

## Install

```bash
mkdir -p ~/.claude
cp kitty-title.sh ~/.claude/kitty-title.sh
chmod +x ~/.claude/kitty-title.sh
```

Merge `settings.hooks.fragment.json` into `~/.claude/settings.json`.

Kitty must allow remote title updates. The longer explanation is in
<https://flurdy.com/docs/kitty-ai-tabs/>.

## Title precedence

The title contains:

1. a Git/directory glyph and repository name, respecting `KITTY_TITLE_REPO_ALIAS` for the
   repository segment only;
2. the normalized active custom title when the hook payload's session-scoped transcript contains
   one;
3. otherwise, the existing shortened branch or main/trunk Beads task followed by the persistent
   `/watch-release` or `/watch-prs` role when present; and
4. the lifecycle state emoji.

Session names use the shared, version-independent Kitty normalization contract. ASCII and common
Unicode punctuation, terminal controls, invisible formatting characters, and symbol/emoji ranges
collapse to `-`; remaining Unicode scalars are preserved up to 24 code points. Empty normalized
names use the unnamed fallback. The fixed scalar ranges keep Claude and Pi output identical even
when their runtimes ship different Unicode category tables, and terminal controls never reach the
title escape sequence.

`KITTY_TITLE_REPO_ALIAS` changes only the repository segment. It never replaces, suppresses, or
duplicates a session name.

## Custom-title lookup and update bound

Every hook payload supplies `session_id` and `transcript_path`. The script accepts a custom-title
record only when the transcript filename and record `sessionId` both match that active session.
Malformed, unavailable, or cross-session data fails closed to the unnamed fallback.

The first lookup streams the transcript once with bounded memory. Later hooks resume from a
session-scoped cached byte offset under the private `XDG_RUNTIME_DIR` or
`/tmp/ai-tools-kitty-$UID`, so the script parses only complete appended records rather than
rescanning an unbounded transcript on every lifecycle event. Cache directories and files must be
owned by the current user with no group/world access. Individual JSONL records are capped at 1 MiB;
oversized non-title records are skipped without being loaded in full, while oversized or malformed
title records fail closed. Set `CLAUDE_KITTY_TITLE_CACHE_DIR` only to a private `0700` directory
when a different location is required.

A real Claude Code 2.1.220 probe on 2026-07-31 showed that `/rename` writes the new `custom-title`
record to the active transcript and updates Claude's own UI immediately, but emits no hook event.
Consequently this Kitty integration picks up a rename on the next configured lifecycle hook (for
example the next `UserPromptSubmit`, tool event, or `Stop`), not at the instant `/rename` returns.
A name supplied with `--name` has the same initial bound because it is not available in the
`SessionStart` hook payload or transcript at that hook's execution time. The implementation does
not claim an immediate update that Claude's hook surface cannot provide.

## Runtime assumptions

- Requires `bash`, `jq`, and Python 3.
- Uses `kitten @ set-tab-title` locally.
- Can use Kitty escape commands over SSH when `SSH_TTY` is available.
- Can show Beads context if `.beads/issues.jsonl` exists in the repo.

Useful environment variables:

- `KITTY_TITLE_REPO_ALIAS`
- `KITTY_TITLE_HOST_ALIAS`
- `CLAUDE_KITTY_TITLE_LOG`
- `CLAUDE_KITTY_TITLE_CACHE_DIR`
