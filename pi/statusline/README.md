# Pi Statusline

Pi extension that replaces Pi's default footer with a Bobthefish/Claude-Code-inspired statusline.

It renders a compact single-line footer by default, and switches to a taller table-style footer when the terminal is large enough.

## Install for testing

```bash
pi -e ./pi/statusline/index.ts
```

## Install globally

```bash
mkdir -p ~/.pi/agent/extensions
rm -f ~/.pi/agent/extensions/flurdy-statusline.ts
ln -sfn "$PWD/pi/statusline" ~/.pi/agent/extensions/flurdy-statusline
```

Then restart Pi, or run `/reload` from an existing Pi session.

## Options

- `PI_STATUSLINE=auto|compact|table` — default `auto`.
- `PI_STATUSLINE_MIN_ROWS=45` — minimum terminal height before `auto` uses table mode.
- `PI_STATUSLINE_PR=0` — disable GitHub PR lookup.
- `PI_STATUSLINE_PR_TTL=120000` — PR cache TTL in milliseconds.
- `PI_STATUSLINE_LAST_PROMPT=0` — hide the latest-prompt widget above the editor.
- `PI_STATUSLINE_CODEX_QUOTA=0` — disable the Codex weekly-quota lookup.
- `PI_STATUSLINE_CODEX_QUOTA_TTL=300000` — Codex quota refresh interval in milliseconds (minimum one minute).
- `PI_STATUSLINE_CODEX_QUOTA_STALE=900000` — age after which the last successful quota snapshot is marked stale (minimum one minute).
- `PI_STATUSLINE_CODEX_QUOTA_TIMEOUT=10000` — timeout for one Codex quota lookup in milliseconds.
- `PI_STATUSLINE_CODEX_BIN=codex` — Codex CLI executable to invoke.

## What it shows

- latest submitted prompt and its local submission time above the editor (single-line and width-truncated)
- clock
- current session name (truncated when necessary)
- `π` agent marker in its own cell; model (including variants such as Sol, Terra, and Luna); and thinking level
- cautious context-capacity bar (green through 33%, yellow through 66%, then red)
- cached Codex weekly subscription quota, percentage remaining, and reset time when available
- cumulative input/output tokens and cache-hit percentage
- session duration
- abbreviated cwd
- worktree repo, branch, dirty/staged/untracked markers
- cached GitHub PR number when available
- Pi-configured estimated cost, tokens, and cache stats in table mode (not provider billing or subscription usage)

## Codex quota source

The quota segment queries the authenticated Codex CLI's machine-readable `codex app-server` API (`account/rateLimits/read`). It does not scrape the interactive `/status` screen, read Codex credential files, or run a model turn. Lookup runs asynchronously outside footer rendering, refreshes at a bounded interval, and retains the last successful snapshot when a later refresh fails. Data older than the configured stale interval—or whose reset time has passed—is labelled stale.

The weekly bucket is identified by its approximately seven-day duration rather than by assuming it is always the API's primary or secondary window. The segment stays hidden when Codex is missing, unauthenticated, too old to support the endpoint, or returns no weekly bucket.

The displayed quota belongs to the account authenticated in the Codex CLI. It represents Pi's OpenAI-Codex allowance only when Pi and Codex are signed into the same ChatGPT account.
