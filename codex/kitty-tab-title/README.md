# Codex Kitty Tab Title

Codex hook script for showing agent state in Kitty tab titles.

## Files

- `kitty-title.sh`: hook command.
- `hooks.json`: Codex hooks config.

## Install

```bash
mkdir -p ~/.codex
cp kitty-title.sh ~/.codex/kitty-title.sh
chmod +x ~/.codex/kitty-title.sh
```

Merge or adapt `hooks.json` into `~/.codex/hooks.json`. Codex may ask you to review new or changed hook commands.

Kitty must allow remote title updates. The longer explanation is in <https://flurdy.com/docs/kitty-ai-tabs/>.

## Runtime Assumptions

- Requires `bash`.
- Uses `jq` for hook payload parsing.
- Uses `kitten @ set-tab-title` locally.
- Can use Kitty escape commands over SSH when `SSH_TTY` is available.
- Can show Beads context if `.beads/db.jsonl` exists in the repo.

Useful environment variables:

- `KITTY_TITLE_REPO_ALIAS`
- `KITTY_TITLE_HOST_ALIAS`
- `CODEX_KITTY_TITLE_LOG`

