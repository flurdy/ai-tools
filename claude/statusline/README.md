# Claude Statusline

Claude Code statusline command inspired by Bobthefish. It renders Claude's `✦` mark in its own cell so sessions are immediately distinguishable from Pi.

## Files

- `statusline-command.sh`: executable statusline command.
- `settings.statusline.fragment.json`: small settings fragment for the permission needed to syntax-check the script.

## Install

```bash
make install
```

This symlinks the script into `~/.claude/`, so the installed statusline cannot drift from source. Override the destination with `make install CLAUDE_DIR=/somewhere/else`. Prefer this over copying: a copy silently forks and stops receiving changes.

Then configure Claude Code to use it as the statusline command. Merge the permissions from `settings.statusline.fragment.json` into your Claude settings if you want Claude to be allowed to run `bash -n statusline-command.sh`.

## Runtime Assumptions

- Requires `bash` and `jq`.
- Uses Git when the current workspace is a repo, including a cached local comparison with its configured upstream.
- Uses `gh` opportunistically to cache PR state. Disable with `CLAUDE_STATUSLINE_PR=0`.
- Uses `bd`, `jq`, and GNU `timeout`/`gtimeout` opportunistically to cache Beads work counts.
- Uses the `worktree-cotenancy` hook opportunistically to count sessions sharing a worktree.
- Reads `~/.claude/settings.json` for effort display when available.

Useful environment variables:

- `CLAUDE_STATUSLINE=auto|table|compact`
- `CLAUDE_STATUSLINE_MIN_ROWS=50`
- `CLAUDE_STATUSLINE_PR=0`
- `CLAUDE_STATUSLINE_PR_TTL=120`
- `CLAUDE_STATUSLINE_GIT_DIVERGENCE=0`
- `CLAUDE_STATUSLINE_GIT_DIVERGENCE_TTL=30`
- `CLAUDE_STATUSLINE_GIT_DIVERGENCE_TIMEOUT=1`
- `CLAUDE_STATUSLINE_BEADS=0`
- `CLAUDE_STATUSLINE_BEADS_TTL=30`
- `CLAUDE_STATUSLINE_BEADS_TIMEOUT=2`
- `CLAUDE_STATUSLINE_COTENANCY=0`

## Git upstream status

A warning-coloured divergence cell appears after the branch and shows only non-zero directions: `⇡N` for local commits absent upstream and `⇣N` for upstream commits absent locally. The detached lookup runs `git rev-list --left-right --count <branch>@{upstream}...<branch>` with a hard timeout and caches the result, so rendering never waits for Git. It never runs `git fetch`; the counts reflect the locally available tracking ref from the most recent fetch performed elsewhere. Zero directions are omitted, while missing upstreams, unavailable commands, timeouts, and other failures hide the whole cell. The timeout is measured in seconds and clamped to 1–10 seconds.

## Beads work

Table mode shows Beads work on the second row immediately before cost. At a validated project-workspace root it uses `project-workspace beads-counts` to aggregate the workspace and every registered repository store. Inside a registered repository and outside project workspaces it retains nearest-store scope. The cell shows non-zero open `P0`–`P4` buckets, the in-progress count, and blocked work. Partial workspace results retain healthy counts and add `⚠N` for unavailable sources; an entirely unavailable aggregate shows `◉ ? ⚠N` rather than a false zero. The lookup is detached, cached, atomically deduplicated, and hard-timeout-bounded, so the first result may appear on the next statusline refresh. `CLAUDE_STATUSLINE_BEADS_TIMEOUT` is measured in seconds and clamped to 1–10 seconds.

The cell is hidden in compact output, outside Beads workspaces, when a required command is unavailable, or when topology or output is invalid. Explicit `CLAUDE_STATUSLINE=compact` mode does not start Beads lookups.

## Worktree co-tenancy

In a linked worktree the `🌳` cell gains a warning-coloured `⚠N` when `N` live Claude sessions share that worktree. It matters because Claude Code's exit dialog removes a worktree without knowing another session is in it, deleting that session's directory and commits; the cell keeps the shared state on screen at the moment someone reaches for `/exit`. See `../worktree-cotenancy/README.md`.

The count comes from the co-tenancy hook, resolved as a sibling of this script or at `~/.claude/hooks/worktree-cotenancy.sh`, and is cached with the rest of the Git status. It is hidden outside worktrees, when only one session holds the worktree, when the hook is not installed, and when `CLAUDE_STATUSLINE_COTENANCY=0`.

