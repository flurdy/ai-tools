# Pi Kitty Tab Title

Pi extension for showing agent state in Kitty tab titles, matching the Claude/Codex hooks in this repo.

Example title shape:

```text
-ai-tools/main·💭
-blc/GE-1793·⚙️
󰉋-scratch·✅
```

## Install for testing

```bash
pi -e ./pi/kitty-tab-title/pi-kitty-tab-title.ts
```

## Install globally

```bash
mkdir -p ~/.pi/agent/extensions
ln -sf "$PWD/pi/kitty-tab-title/pi-kitty-tab-title.ts" ~/.pi/agent/extensions/flurdy-kitty-tab-title.ts
```

Then restart Pi or run `/reload`.

## States

- `🌱` session started
- `💭` user prompt / thinking
- `⚙️` tool running
- `🧹` compacting
- `✅` turn or session finished

## Behaviour

The title contains:

- a Git/directory glyph;
- repo name, respecting `KITTY_TITLE_REPO_ALIAS`;
- a shortened branch, or a Beads task id on main/trunk when detectable;
- persistent session role for `/watch-release` and `/watch-prs` prompts;
- state emoji.

It uses `kitten @ set-tab-title`, falls back to `kitten @ --to unix:@kitty`, and also writes OSC title escapes to `/dev/tty`. Over SSH it writes Kitty remote-control escapes to `$SSH_TTY`.

## Environment variables

- `KITTY_TITLE_REPO_ALIAS`
- `KITTY_TITLE_HOST_ALIAS`
- `PI_KITTY_TITLE_LOG=/tmp/pi-kitty-title.log`
