# Claude Statusline

Claude Code statusline command inspired by Bobthefish. It renders Claude's `✦` mark in its own cell so sessions are immediately distinguishable from Pi.

## Files

- `statusline-command.sh`: executable statusline command.
- `settings.statusline.fragment.json`: small settings fragment for the permission needed to syntax-check the script.

## Install

Copy or symlink the script into your Claude config, for example:

```bash
mkdir -p ~/.claude
cp statusline-command.sh ~/.claude/statusline-command.sh
chmod +x ~/.claude/statusline-command.sh
```

Then configure Claude Code to use it as the statusline command. Merge the permissions from `settings.statusline.fragment.json` into your Claude settings if you want Claude to be allowed to run `bash -n statusline-command.sh`.

## Runtime Assumptions

- Requires `bash` and `jq`.
- Uses Git when the current workspace is a repo.
- Uses `gh` opportunistically to cache PR state. Disable with `CLAUDE_STATUSLINE_PR=0`.
- Uses `bd`, `jq`, and GNU `timeout`/`gtimeout` opportunistically to cache Beads work counts.
- Reads `~/.claude/settings.json` for effort display when available.

Useful environment variables:

- `CLAUDE_STATUSLINE=auto|table|compact`
- `CLAUDE_STATUSLINE_MIN_ROWS=50`
- `CLAUDE_STATUSLINE_PR=0`
- `CLAUDE_STATUSLINE_PR_TTL=120`
- `CLAUDE_STATUSLINE_BEADS=0`
- `CLAUDE_STATUSLINE_BEADS_TTL=30`
- `CLAUDE_STATUSLINE_BEADS_TIMEOUT=2`

## Beads work

Table mode discovers the nearest parent `.beads` workspace and shows non-zero open `P0`–`P4` buckets, the in-progress count, and the blocked count when non-zero. The lookup is detached, cached, atomically deduplicated, and hard-timeout-bounded, so the first result may appear on the next statusline refresh. `CLAUDE_STATUSLINE_BEADS_TIMEOUT` is measured in seconds and clamped to 1–10 seconds.

The cell is hidden in compact output, outside Beads workspaces, when a required command is unavailable, or when `bd` returns an error or invalid data. Explicit `CLAUDE_STATUSLINE=compact` mode does not start Beads lookups.

