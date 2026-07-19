# Pi Statusline

Pi extension that replaces Pi's default footer with a Bobthefish/Claude-Code-inspired statusline.

It renders a compact single-line footer by default, and switches to a taller table-style footer when the terminal is large enough. The optional widget above the editor shows the active run and latest submitted prompt.

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
- `PI_STATUSLINE_LAST_PROMPT=0` — hide the active-run/latest-prompt widget above the editor (recommended when prompts may be visible to others).
- `PI_STATUSLINE_K8S_CONTEXT=0` — hide the current `kubectl` context (shown by default when available).
- `PI_STATUSLINE_CODEX_QUOTA=0` — disable the Codex weekly-quota lookup.
- `PI_STATUSLINE_CODEX_QUOTA_TTL=300000` — Codex quota refresh interval in milliseconds (minimum one minute).
- `PI_STATUSLINE_CODEX_QUOTA_STALE=900000` — age after which the last successful quota snapshot is marked stale (minimum one minute).
- `PI_STATUSLINE_CODEX_QUOTA_TIMEOUT=10000` — timeout for one Codex quota lookup in milliseconds.
- `PI_STATUSLINE_CODEX_BIN=codex` — Codex CLI executable to invoke.

## Layout modes

The examples below are schematic: they use placeholder values and omit terminal colours, hostnames, paths, repository names, branches, account data, and prompt text.

### Compact footer

Compact mode is a single line. As space narrows, less-important cells are dropped before the line is truncated.

```text
12:34 │ π │ GPT-5 Terra │ ⚡Hi │ ██░ ctx │ █░░ GPT │ 12m │ ~/project │ main │ ◈ session
```

### Table footer

Table mode uses two bordered rows: location/session information on top, then model, capacity, usage, and time signals below.

```text
┌──────────────┬───────────┬──────┬───────────────────────────────────────┐
│ example-host │ ~/project │ main │ ◈ session                             │
├───┬──────────┴──┬─────┬──┴──────┴──┬──────────┬───────────┬─────┬───────┤
│ π │ GPT-5 Terra │ ⚡Hi │ ███░░░ ctx │ ↑12k ↓2k │ est $0.00 │ 12m │ 12:34 │
└───┴─────────────┴─────┴────────────┴──────────┴───────────┴─────┴───────┘
```

`PI_STATUSLINE=auto` (the default) selects table mode only when the terminal has at least 45 rows and is at least 100 columns wide. Otherwise it selects compact mode. `PI_STATUSLINE=compact` and `PI_STATUSLINE=table` request a layout explicitly; table mode still falls back to compact if its cells cannot fit.

### Above-editor widget and prompt privacy

In TUI mode, the extension normally shows a dim, single-line, width-truncated latest-prompt line above the editor:

```text
Last [12:34]: [submitted prompt, truncated to the terminal width]
```

While an agent run is active, it separately adds the active parent-run model and thinking level above that prompt; this line updates if a model-tier router changes either during the run:

```text
Running: GPT-5 Terra · thinking high
Last [12:34]: [submitted prompt, truncated to the terminal width]
```

The latest prompt is taken from your submitted input, so it can expose task details, identifiers, or secrets to anyone who can see your terminal, screenshots, recordings, or shared tmux session. Set `PI_STATUSLINE_LAST_PROMPT=0` before starting Pi to suppress both widget lines entirely.

## What it shows

- latest submitted prompt and its local submission time above the editor (single-line and width-truncated)
- active parent-run model and thinking level above that prompt; it updates when the model-tier router changes model or thinking mid-run
- clock
- hostname with a Nerd Font monitor icon
- current `kubectl` context when available
- current session name (truncated when necessary)
- `π` agent marker in its own cell; a compact model name (including variants such as Sol, Terra, and Luna), prefixed with `OR` only for OpenRouter; and thinking level
- cautious context-capacity bar labelled `ctx` (green through 33%, yellow through 66%, then red)
- cached Codex weekly used-capacity bar labelled `GPT`, plus its reset date in table mode
- cumulative input/output tokens and cache-hit percentage
- session duration
- abbreviated cwd
- worktree repo, branch, dirty/staged/untracked markers
- cached GitHub PR number when available
- Pi-configured estimated cost, tokens, and cache stats in table mode (not provider billing or subscription usage)

## Codex quota source

The quota segment queries the authenticated Codex CLI's machine-readable `codex app-server` API (`account/rateLimits/read`). It does not scrape the interactive `/status` screen, read Codex credential files, or run a model turn. Lookup runs asynchronously outside footer rendering, refreshes at a bounded interval, and retains the last successful snapshot when a later refresh fails. Data older than the configured stale interval—or whose reset time has passed—is rendered dim.

The weekly bucket is identified by its approximately seven-day duration rather than by assuming it is always the API's primary or secondary window. The segment stays hidden when Codex is missing, unauthenticated, too old to support the endpoint, or returns no weekly bucket.

The displayed quota belongs to the account authenticated in the Codex CLI. It represents Pi's OpenAI-Codex allowance only when Pi and Codex are signed into the same ChatGPT account.
