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
- Reads `~/.claude/settings.json` for effort display when available.

Useful environment variables:

- `CLAUDE_STATUSLINE=auto|table|compact`
- `CLAUDE_STATUSLINE_MIN_ROWS=50`
- `CLAUDE_STATUSLINE_PR=0`
- `CLAUDE_STATUSLINE_PR_TTL=120`

