# Pi Launcher

Fish `pl` launcher for choosing a Pi context before starting `pi`.

It can launch from:

- the main checkout
- an existing Git worktree
- a handoff target
- a newly-created worktree

## Files

- `pl.fish`: Pi-specific Fish frontend users run as `pl`.
- `pl-gather`: symlink to the [shared context picker](../../shared/launcher/).
- `pl-mkworktree`: symlink to the shared worktree creator.

## Install

For the live dotfiles layout:

```bash
mkdir -p ~/.dotfiles/.config/fish/functions ~/.dotfiles/.pi/bin ~/.pi/bin ~/.pi/agent
cp -f pl.fish ~/.dotfiles/.config/fish/functions/pl.fish
test -f ~/.pi/agent/pl-launcher.json || cp -f pl-launcher.json.example ~/.pi/agent/pl-launcher.json
# cp follows the repository symlinks and installs the shared helper contents.
cp -f pl-gather pl-mkworktree ~/.dotfiles/.pi/bin/
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

`pl` pins fresh sessions to the defaults in `~/.pi/agent/pl-launcher.json` so they
remain stable when extensions temporarily change Pi's persisted defaults. Copy
`pl-launcher.json.example` to that path to configure a model and thinking level; its default
is `openai-codex/gpt-5.6-sol` with `high` thinking. The tiered model router may select Terra
or Luna for work that fits lower tiers. Continue/resume launches preserve the session's saved
model; use `--model` and `--thinking` to override either value explicitly.

Picker keys:

- `enter`: default launch mode for the row (`main` starts fresh, worktrees continue, handoffs start fresh with the note loaded)
- `ctrl-n`: force fresh Pi session
- `ctrl-r`: Pi resume picker
- `ctrl-w`: start the row in a fresh worktree (prompts for a branch; a handoff row also seeds its note)

## Runtime Assumptions

- Requires Fish for `pl.fish`.
- Requires Bash 4+, `git`, `fzf`, and `jq` (when a launcher config exists).
- Uses `gh` when available to show cached PR state.
- Uses `~/.claude/skills/handoffs/scripts/list.sh` when the handoffs skill is installed.
- Shows handoffs owned by the current repo as separate rows and starts a fresh Pi session seeded with the selected handoff note.
- Worktrees reuse an existing `*/worktrees/*` layout, then fall back to `../worktrees`; set `AI_WORKTREE_PARENT` to override that fallback.
- Worktrees receive existing local Claude and Pi project settings so either launcher can use them.
- Claude and Pi share cached PR metadata under `~/.cache/ai-launcher` (or `$XDG_CACHE_HOME/ai-launcher`).
