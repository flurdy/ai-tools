# Claude Launcher

Fish `cl` launcher for choosing a Claude Code context before starting `claude`.

It can launch from:

- the main checkout
- an existing Git worktree
- a handoff target
- a newly-created worktree

## Files

- `cl.fish`: Fish function users run as `cl`.
- `cl-gather`: builds the picker rows and returns the selected launch descriptor.
- `cl-mkworktree`: creates or reuses a worktree for a branch.

## Install

```bash
mkdir -p ~/.config/fish/functions ~/.claude/bin
cp cl.fish ~/.config/fish/functions/cl.fish
cp cl-gather cl-mkworktree ~/.claude/bin/
chmod +x ~/.claude/bin/cl-gather ~/.claude/bin/cl-mkworktree
```

## Usage

```fish
cl
cl --list
cl --dry-run
cl --chrome
cl --model=claude-sonnet-4-5
```

Picker keys:

- `enter`: default launch mode for the row
- `ctrl-n`: force new session
- `ctrl-r`: resume picker
- `ctrl-f`: continue and fork session

## Runtime Assumptions

- Requires Fish for `cl.fish`.
- Requires `bash`, `git`, and `fzf`.
- Uses `gh` when available to show cached PR state.
- Uses `~/.claude/skills/handoffs/scripts/list.sh` when the handoffs skill is installed.
- Shows handoffs owned by the current repo as separate rows and starts a fresh Claude session seeded with the selected handoff note.
- `cl-mkworktree` has a local fallback parent of `../claude-blc-2/worktrees`; edit that before using it outside my layout.
