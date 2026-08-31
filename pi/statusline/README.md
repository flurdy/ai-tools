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
- `PI_STATUSLINE_GIT_DIVERGENCE=0` — hide the upstream ahead/behind commit counts.
- `PI_STATUSLINE_GIT_DIVERGENCE_TTL=30000` — upstream-divergence cache interval in milliseconds (minimum one second).
- `PI_STATUSLINE_GIT_DIVERGENCE_TIMEOUT=500` — timeout for one local upstream comparison in milliseconds (minimum 100 ms).
- `PI_STATUSLINE_LAST_PROMPT=0` — hide the active-run/latest-prompt widget above the editor (recommended when prompts may be visible to others).
- `PI_STATUSLINE_K8S_CONTEXT=0` — hide the current `kubectl` context (shown by default when available).
- `PI_STATUSLINE_BEADS=0` — hide Beads work counts in the table footer.
- `PI_STATUSLINE_BEADS_TTL=30000` — Beads count refresh interval in milliseconds (minimum five seconds).
- `PI_STATUSLINE_BEADS_TIMEOUT=2000` — timeout for one Beads count lookup in milliseconds (minimum 250 ms).
- `PI_STATUSLINE_CODEX_QUOTA=0` — disable the Codex weekly-quota lookup when using an OpenAI-Codex model.
- `PI_STATUSLINE_CODEX_QUOTA_TTL=300000` — Codex quota refresh interval in milliseconds (minimum one minute).
- `PI_STATUSLINE_CODEX_QUOTA_STALE=900000` — age after which the last successful quota snapshot is marked stale (minimum one minute).
- `PI_STATUSLINE_CODEX_QUOTA_TIMEOUT=10000` — timeout for one Codex quota lookup in milliseconds.
- `PI_STATUSLINE_CODEX_BIN=codex` — Codex CLI executable to invoke.
- `PI_STATUSLINE_OPENROUTER_WARN=0` — disable large-context OpenRouter warnings.
- `PI_STATUSLINE_OPENROUTER_WARN_TOKENS=100000` — absolute context-token warning interval; `0` disables token-based warnings.
- `PI_STATUSLINE_OPENROUTER_WARN_COST=1` — estimated uncached input-cost warning interval in dollars; `0` disables cost-based warnings.
- `PI_STATUSLINE_OPENROUTER_PROJECT=...` — project passed to `secret-api-key lookup openrouter_management`; falls back to `SECRET_API_KEY_PROJECT`.
- `PI_STATUSLINE_OPENROUTER_MANAGEMENT_KEY=...` — legacy explicit management key fallback; prefer the keyring lookup.
- `PI_STATUSLINE_OPENROUTER_CREDITS=0` — disable the OpenRouter credit-balance lookup even when a key is configured.
- `PI_STATUSLINE_OPENROUTER_CREDITS_TTL=300000` — OpenRouter balance refresh interval in milliseconds (minimum one minute).
- `PI_STATUSLINE_OPENROUTER_CREDITS_STALE=900000` — age after which the last successful balance is rendered dim (minimum one minute).
- `PI_STATUSLINE_OPENROUTER_CREDITS_TIMEOUT=5000` — timeout for one OpenRouter balance request in milliseconds (minimum 250 ms).

## Layout modes

The examples below are schematic: they use placeholder values and omit terminal colours, hostnames, paths, repository names, branches, account data, and prompt text.

### Compact footer

Compact mode is a single line. As space narrows, less-important cells are dropped before the line is truncated.

```text
12:34 │ π │ implement │ GPT-5 Terra │ ⚡Hi │ ██░ ctx │ █░░ GPT │ OR $74.75 │ 12m │ ~/project │ main │ ⇡10 ⇣2 │ ◈ session
```

### Table footer

Table mode uses two bordered rows: location/session information on top, then model, capacity, usage, and time signals below.

```text
┌──────────────┬───────────┬──────┬──────────────────────┬────────────────┐
│ example-host │ ~/project │ main │ ⇡10 ⇣2 │ ◉ P4:4 ◐1         │ ◈ session      │
├───┬──────────┴──┬─────┬──┴──────┴──┬──────────┬────────┴──┬─────┬───────┤
│ π │ implement │ GPT-5 Terra │ ⚡Hi │ ███░░░ ctx │ OR $74.75 │ est $0.00 │ 12m │ 12:34 │
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
- the `session-mode` extension status (`implement`, `plan`, `conflict`, `lost`, or `unguarded`), pinned in narrow and wide layouts when installed
- `π` agent marker in its own cell; a compact model name (including variants such as Sol, Terra, and Luna), prefixed with `OR` only for OpenRouter; and thinking level
- cautious context-capacity bar labelled `ctx` (green through 33%, yellow through 66%, then red)
- cached Codex weekly used-capacity bar labelled `GPT` for OpenAI-Codex models, plus its reset date in table mode
- optional cached OpenRouter account credit balance labelled `OR`, immediately before the estimated session cost
- session duration
- abbreviated cwd
- worktree repo, branch, dirty/staged/untracked markers
- cached divergence from the configured upstream, shown as `⇡N` for unpushed local commits and `⇣N` for upstream commits not present locally
- cached GitHub PR number when available
- open Beads grouped by priority plus compact active and blocked counts in table mode when the cwd is inside a Beads workspace
- Pi-configured estimated cost, tokens, and cache stats in table mode (not provider billing or subscription usage)
- visible OpenRouter cost warnings outside the footer when large absolute context or estimated uncached input crosses a configured band

## OpenRouter large-context advisory

The advisory is enabled by default only for models whose Pi provider is `openrouter`. It warns immediately after a manual model switch when the existing conversation is already above a threshold, includes newly submitted text and images before the first request, and checks again before each continuing tool-loop turn. The defaults warn at 100,000 context tokens or $1 of estimated uncached input. Further warnings occur only when the next multiple of either configured threshold is crossed, and are deduplicated by session and model. Session restore and `/reload` therefore do not repeat a warning for a band already shown in the current Pi process.

The cost figure is a local estimate: current context tokens multiplied by the active model's Pi-configured request-wide input rate. Before the first request, submitted text uses Pi's conservative four-characters-per-token estimate and each image adds 1,200 tokens. The estimate assumes all context is billed as uncached input and excludes output, exact provider payload adjustments, cache discounts, routing changes, account credits, and provider billing corrections. The notification labels it `estimated uncached input` and omits it when pricing metadata is missing or invalid. It never queries OpenRouter billing or account spend.

Set `PI_STATUSLINE_OPENROUTER_WARN=0` to disable the advisory. Set either interval to `0` to disable only that signal; invalid values fall back to the documented defaults.

## Git upstream source

The optional divergence cell asynchronously compares the cache-keyed branch with its locally available upstream tracking ref using `git rev-list --left-right --count <branch>@{upstream}...<branch>`. It shows only non-zero directions: `⇡N` for local commits absent upstream and `⇣N` for upstream commits absent locally. It never fetches from a remote, so its value reflects the most recent fetch performed elsewhere. The lookup is cached, timeout-bounded, and hidden when both counts are zero or data is unavailable.

## Beads count source

The table footer discovers the nearest parent `.beads` workspace. At a validated project-workspace root it uses `project-workspace beads-counts` to aggregate the root and every registered repository store; inside a registered repository and outside project workspaces it retains the nearest-store `bd` query. Open counts include non-zero `P0`–`P4` buckets, including P4 backlog work. Active and blocked counts use compact symbols. A partial workspace result keeps healthy counts and adds `⚠N` for unavailable sources; if every source is unavailable it shows `◉ ? ⚠N` rather than a false zero. The lookup is cached, timeout-bounded, and never runs during footer rendering. Its cell stays hidden in compact mode, outside Beads workspaces, when required commands are missing, or when topology or output is invalid.

## Codex quota source

For OpenAI-Codex models, the quota segment queries the authenticated Codex CLI's machine-readable `codex app-server` API (`account/rateLimits/read`). It stays hidden and skips lookups for other providers. It does not scrape the interactive `/status` screen, read Codex credential files, or run a model turn. Lookup runs asynchronously outside footer rendering, refreshes at a bounded interval, and retains the last successful snapshot when a later refresh fails. Data older than the configured stale interval—or whose reset time has passed—is rendered dim.

The weekly bucket is identified by its approximately seven-day duration rather than by assuming it is always the API's primary or secondary window. The segment stays hidden when Codex is missing, unauthenticated, too old to support the endpoint, or returns no weekly bucket.

The displayed quota belongs to the account authenticated in the Codex CLI. It represents Pi's OpenAI-Codex allowance only when Pi and Codex are signed into the same ChatGPT account.

## OpenRouter credit source

The optional `OR` segment calls OpenRouter's `GET /api/v1/credits` endpoint and displays `total_credits - total_usage`. OpenRouter requires a management key for this account-level endpoint; normal inference keys receive HTTP 403. When `PI_STATUSLINE_OPENROUTER_PROJECT` or `SECRET_API_KEY_PROJECT` is set, the statusline loads it once with `secret-api-key lookup openrouter_management PROJECT`. The API lookup is asynchronous, cached, and timeout-bounded. A transient refresh failure keeps the last successful balance and immediately renders it dim; age also dims a snapshot after the configured stale interval. Missing, rejected, and malformed responses stay hidden.

The statusline intentionally does not read `OPENROUTER_API_KEY`, log credentials or response bodies, or render the management key. The legacy explicit management-key environment variable remains supported, but keyring lookup avoids exposing the key to Pi's child commands.
