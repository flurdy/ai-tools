# Pi Statusline

Pi extension that replaces Pi's default footer with a Bobthefish/Claude-Code-inspired statusline.

It renders a compact single-line footer by default, and switches to a taller table-style footer when the terminal is large enough.

## Install for testing

```bash
pi -e ./pi/statusline/pi-statusline.ts
```

## Install globally

```bash
mkdir -p ~/.pi/agent/extensions
ln -sf "$PWD/pi/statusline/pi-statusline.ts" ~/.pi/agent/extensions/flurdy-statusline.ts
```

Then restart Pi, or run `/reload` from an existing Pi session.

## Options

- `PI_STATUSLINE=auto|compact|table` — default `auto`.
- `PI_STATUSLINE_MIN_ROWS=45` — minimum terminal height before `auto` uses table mode.
- `PI_STATUSLINE_PR=0` — disable GitHub PR lookup.
- `PI_STATUSLINE_PR_TTL=120000` — PR cache TTL in milliseconds.

## What it shows

- clock
- model and thinking level
- context/token mini bars
- session duration
- abbreviated cwd
- worktree repo, branch, dirty/staged/untracked markers
- cached GitHub PR number when available
- cost, tokens, and cache stats in table mode
