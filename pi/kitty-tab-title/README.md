# Pi Kitty Tab Title

Pi extension for showing agent state in Kitty tab titles, matching the Claude/Codex hooks in this repo.

Named session:

```text
π·-agents/foreman-design·✅
```

Unnamed fallbacks:

```text
π·-ai-tools/feature·💭
π·-blc/GE-1793·⚙️
π·󰉋-scratch·✅
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

Then restart Pi or run `/reload`. Session-name refresh requires Pi 0.82.1 or newer.

## States

- `🌱` session started
- `💭` user prompt / thinking
- `⚙️` tool running
- `🧹` compacting
- `✅` turn or session finished

## Title precedence

The title contains:

1. a Pi prefix plus Git/directory glyph and repository name, respecting
   `KITTY_TITLE_REPO_ALIAS` for the repository segment only;
2. the normalized custom session name when `pi.getSessionName()` returns one;
3. otherwise, the existing shortened branch or main/trunk Beads task followed by the
   persistent `/watch-release` or `/watch-prs` role when present; and
4. the lifecycle state emoji.

Renaming or clearing a session fires Pi's `session_info_changed` event, so the title updates
immediately while retaining the current lifecycle state. Clearing a name restores the branch,
Beads, and watcher-role fallback.

Session names use the shared, version-independent Kitty normalization contract. ASCII and common
Unicode punctuation, terminal controls, invisible formatting characters, and symbol/emoji ranges
collapse to `-`; remaining Unicode scalars are preserved up to 24 code points. Empty normalized
names use the unnamed fallback. The fixed scalar ranges keep Pi and Claude output identical even
when their runtimes ship different Unicode category tables, and terminal controls never reach the
title escape sequence.

## Orca-managed panes

`orca-titlebar-spinner.ts` also calls `ctx.ui.setTitle()` while `ORCA_PANE_KEY` is set and would
race this extension. To avoid relying on extension event order, this extension disables its title
writer and emits a warning in that environment. Disable the Orca titlebar-spinner extension,
then set `PI_KITTY_TITLE_ALLOW_ORCA=1` for that session to acknowledge the conflict and enable
`flurdy-kitty-tab-title.ts`. Do not set the override while both writers are loaded.

## Runtime behavior

The extension uses `kitten @ set-tab-title`, falls back to `kitten @ --to unix:@kitty`, and also
writes OSC title escapes to `/dev/tty`. Over SSH it writes Kitty remote-control escapes to
`$SSH_TTY`.

## Environment variables

- `KITTY_TITLE_REPO_ALIAS`
- `KITTY_TITLE_HOST_ALIAS`
- `PI_KITTY_TITLE_LOG=/tmp/pi-kitty-title.log`
