# Pi Launcher

Fish `pl` launcher for choosing a Pi context before starting `pi`.

It can launch from:

- the main checkout
- an existing Git worktree
- a handoff target
- a newly-created worktree

## Files

- `pl.fish`: Fish function users run as `pl`.
- `pl-gather`: builds the picker rows and returns the selected launch descriptor.
- `pl-mkworktree`: creates or reuses a worktree for a branch.

## Install

For the live dotfiles layout:

```bash
mkdir -p ~/.dotfiles/.config/fish/functions ~/.dotfiles/.pi/bin ~/.pi/bin
cp pl.fish ~/.dotfiles/.config/fish/functions/pl.fish
cp pl-gather pl-mkworktree ~/.dotfiles/.pi/bin/
chmod +x ~/.dotfiles/.pi/bin/pl-gather ~/.dotfiles/.pi/bin/pl-mkworktree
ln -sfn ~/.dotfiles/.pi/bin/pl-gather ~/.pi/bin/pl-gather
ln -sfn ~/.dotfiles/.pi/bin/pl-mkworktree ~/.pi/bin/pl-mkworktree
```

Or copy `pl.fish` to any directory Fish autoloads from.

## Usage

```fish
pl
pl --list
pl --dry-run
pl --model=anthropic/claude-sonnet-4-5
pl --thinking=high
pl --name='ticket work'
```

Picker keys:

- `enter`: default launch mode for the row (`main` starts fresh, worktrees continue, handoffs start fresh with the note loaded)
- `ctrl-n`: force fresh Pi session
- `ctrl-r`: Pi resume picker
- `ctrl-w`: start the row in a fresh worktree (prompts for a branch; a handoff row also seeds its note)

## Runtime Assumptions

- Requires Fish for `pl.fish`.
- Requires `bash`, `git`, and `fzf`.
- Uses `gh` when available to show cached PR state.
- Uses `~/.claude/skills/handoffs/scripts/list.sh` when the handoffs skill is installed.
- Shows handoffs owned by the current repo as separate rows and starts a fresh Pi session seeded with the selected handoff note.
- `pl-mkworktree` creates worktrees under an existing `*/worktrees/*` parent when present, otherwise under `../worktrees` relative to the main checkout.
