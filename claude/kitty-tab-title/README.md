# Claude Kitty Tab Title

Claude Code hook script for showing agent state in Kitty tab titles.

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
- `CLAUDE_KITTY_TITLE_LOG`

