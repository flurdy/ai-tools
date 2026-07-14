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
- `watchprs.fish`, `watchrelease.fish`: watcher launchers (see below).

## Install

```bash
mkdir -p ~/.config/fish/functions ~/.claude/bin
cp cl.fish watchprs.fish watchrelease.fish ~/.config/fish/functions/
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
- `ctrl-w`: start the row in a fresh worktree (prompts for a branch; a handoff row also seeds its note)

## Watcher launchers

`watchprs` and `watchrelease` start a dedicated watcher tab in the current repo, pinned to a
watch-safe model. Watch-skill ticks run on the *session* model, and Fable-class models render
blank ticks (their output arrives after the tool call that ends the turn) — these launchers use
`claude --model sonnet`, which applies to that session only and leaves the saved default alone.

```fish
watchprs                 # /watch-prs, adaptive cadence, stop 18:00
watchprs 17              # stop at 17:00
watchprs 10m --dry-run   # fixed 10m interval; print the launch instead of running
watchrelease             # /watch-release (attended — it prompts to push/defer/cancel)
watchprs --model=opus    # override the model (opus also works for watch ticks)
```

Arguments pass through to the watch skill; `--model=ID` and `--dry-run|-n` are consumed by the
launcher. Run them from the repo the watcher should report on.

## Runtime Assumptions

- Requires Fish for `cl.fish`.
- Requires `bash`, `git`, and `fzf`.
- Uses `gh` when available to show cached PR state.
- Uses `~/.claude/skills/handoffs/scripts/list.sh` when the handoffs skill is installed.
- Shows handoffs owned by the current repo as separate rows and starts a fresh Claude session seeded with the selected handoff note.
- `cl-mkworktree` has a local fallback parent of `../claude-blc-2/worktrees`; edit that before using it outside my layout.
