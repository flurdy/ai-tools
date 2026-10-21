# Pi Statusline

Pi extension that replaces Pi's default footer with a Bobthefish/Claude-Code-inspired statusline.

It renders a compact single-line footer by default, and switches to a taller table-style footer when the terminal is large enough. The optional widget above the editor shows the active run and latest submitted prompt.

## Install

From the ai-tools root:

```bash
make apply
```

Install [the standalone session-mode package](https://github.com/flurdy/pi-session-mode) separately for guard indicators and `/leases`. Statusline reads its published `session-mode` and `session-mode-leases` statuses through Pi; it does not import that package or inspect locks. Without those statuses, the guard cell is hidden.

Restart Pi after first installation; use `/reload` for later changes. `make verify-apply` checks resource links, not code already loaded in a running Pi process. Older installations may retain an unused `pi/statusline/node_modules/@flurdy/pi-session-mode` link; it is no longer required.

## Develop and test

After installing this component's development dependencies, run from the ai-tools root:

```bash
npm --prefix pi/statusline test
npm --prefix pi/statusline run typecheck
pi -e ./pi/statusline/index.ts
```

Avoid loading a second copy of an already installed extension when using `-e`.

## Options

- `PI_STATUSLINE=auto|compact|table` — default `auto`.
- `PI_STATUSLINE_MIN_ROWS=45` — minimum terminal height before `auto` uses table mode.
- `PI_STATUSLINE_PR=0` — disable GitHub PR lookup.
- `PI_STATUSLINE_PR_TTL=120000` — PR cache TTL in milliseconds.
- `PI_STATUSLINE_GIT_DIVERGENCE=0` — hide the upstream ahead/behind commit counts.
- `PI_STATUSLINE_GIT_DIVERGENCE_TTL=30000` — upstream-divergence cache interval in milliseconds (minimum one second).
- `PI_STATUSLINE_GIT_DIVERGENCE_TIMEOUT` — lookup timeout in milliseconds (minimum 100 ms); defaults to 500 for a single repository and 2000 at a project-workspace root.
- `PI_STATUSLINE_GUARD_EMOJI=0` — show the session guard's full text label instead of its compact emoji.
- `PI_STATUSLINE_LAST_PROMPT=0` — hide the active-run/latest-prompt widget above the editor (recommended when prompts may be visible to others).
- `PI_STATUSLINE_K8S_CONTEXT=0` — hide the current `kubectl` context (shown by default when available).
- `PI_STATUSLINE_BEADS=0` — hide Beads work counts in the table footer.
- `PI_STATUSLINE_BEADS_TTL=30000` — Beads count refresh interval in milliseconds (minimum five seconds).
- `PI_STATUSLINE_BEADS_TIMEOUT=2000` — timeout for one Beads count lookup in milliseconds (minimum 250 ms).
- `PI_STATUSLINE_CODEX_QUOTA=0` — disable the Codex weekly-quota and credit-balance lookup and its `GPT` cell.
- `PI_STATUSLINE_CODEX_QUOTA_TTL=300000` — Codex quota refresh interval in milliseconds (minimum one minute).
- `PI_STATUSLINE_CODEX_QUOTA_STALE=900000` — age after which the last successful quota snapshot is marked stale (minimum one minute).
- `PI_STATUSLINE_CODEX_QUOTA_TIMEOUT=10000` — timeout for one Codex quota lookup in milliseconds (minimum one second).
- `PI_STATUSLINE_CODEX_BIN=codex` — Codex CLI executable to invoke.
- `PI_STATUSLINE_CLAUDE_QUOTA=0` — disable the Claude Code `/usage` lookup and its `Claude` cell.
- `PI_STATUSLINE_CLAUDE_QUOTA_TTL=900000` — Claude usage refresh interval in milliseconds (minimum one minute).
- `PI_STATUSLINE_CLAUDE_QUOTA_STALE=1800000` — age after which the last successful Claude snapshot is marked stale (minimum one minute).
- `PI_STATUSLINE_CLAUDE_QUOTA_TIMEOUT=10000` — timeout for one Claude usage lookup in milliseconds (minimum one second).
- `PI_STATUSLINE_QUOTA_CACHE=0` — disable the host-shared account quota cache; each footer then looks up on its own.
- `PI_STATUSLINE_QUOTA_CACHE_DIR=<absolute path>` — private directory for the shared cache (default `$XDG_RUNTIME_DIR/pi-statusline`, otherwise `pi-statusline` under `$XDG_CACHE_HOME` or `~/.cache`).
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
π │ 🔒 │ Terra 5 │ ⚡Hi │ ▮▯▯ ctx │ GPT ▮▮▯▯▯ · 126 cr │ Claude 5h ▯▯▯▯▯ · wk ▮▮▯▯▯ │ OR $75 │ 12m │ ~/project │ main │ ⇡10 ⇣2 │ ◈ session
```

The full line uses five-block quota gauges. When it does not fit, those gauges shrink to three blocks before the path, duration, PR and session cells are dropped. The guard, `ctx` and quota cells stay until the narrowest fallback, which keeps only the agent, guard, model, `ctx`, Kubernetes context, branch, divergence and session.

### Table footer

Table mode uses two bordered rows: location/session information on top, then model, capacity, usage, and session duration below. Like compact mode, it starts with five-block quota gauges and tries three blocks if needed before dropping the path or falling back to one line:

```text
row 1: example-host │ ~/project │ main │ ⇡10 ⇣2 │ ◉ P4:4 ◐1 │ ◈ session
row 2: π │ 🔒2 │ Terra 5 │ ⚡Hi │ ▮▮▯▯▯▯ ctx │ GPT ▮▮▯▯▯ · 126 cr │ Claude 5h ▯▯▯▯▯ · wk ▮▮▯▯▯ │ OR $75 │ est $0 │ 12m
```

Percentages and reset dates stay in `/quota`, not the footer. Reset times still invalidate expired quota windows, which show `?` until refreshed.

`PI_STATUSLINE=auto` (the default) selects table mode only when the terminal has at least 45 rows and is at least 100 columns wide. Otherwise it selects compact mode. `PI_STATUSLINE=compact` and `PI_STATUSLINE=table` request a layout explicitly; table mode still falls back to compact if its cells cannot fit.

### Session guard indicators

| Guard label | Footer | Meaning |
| --- | --- | --- |
| `acquiring` | ⏳ | Waiting for the worktree writer lease. |
| `implement`, one worktree lease | 🔒 | This session holds one worktree writer lease, not necessarily cwd. |
| `implement`, multiple worktree leases | 🔒N | This session holds N worktree writer leases (up to 32). |
| `implement`, zero or unavailable count | ✅ | Implement state without a reported worktree lease; may be a file-only grant. |
| `lazy` | 💤 | Implementation intent with no worktree lease; the next native write acquires only its own worktree. |
| `plan` | 🔍 | This session is guarded and read-only. |
| `conflict` | ⛔ | Another session prevented lease acquisition. |
| `lost` | 💥 | A previously held lease was lost. |
| `unguarded` | 🚨 | Guard protection is unavailable or disabled. |

One guard cell summarizes this session's authority in both layouts. The lock means this session holds worktree write authority, not that another session blocks it. Plan mode has no occupancy hint or background lock probe. Lease counts are used only in implement state; names and zero counts are never displayed. Missing or malformed counts do not imply a held lock.

Use `/leases` for full canonical identities, requested scopes, occupancy observations, and failures. The footer reads the count published by session-mode; it does not infer authority from Beads or the launch directory. Guard enforcement, status publication, and `/leases` are unchanged.

Set `PI_STATUSLINE_GUARD_EMOJI=0` to preserve the full themed state label, adding a count only for multiple implement leases (for example, `implement 2`). A single lease or unavailable count remains `implement`. The distinct shapes, text fallback, and table above are the accessibility contract; colour is not required to distinguish states.

### Above-editor widget and prompt privacy

In TUI mode, the extension normally shows a dim, single-line, width-truncated latest-prompt line above the editor:

```text
Last [12:34]: [submitted prompt, truncated to the terminal width]
```

While an agent run is active, it separately adds the active parent-run model and thinking level above that prompt; this line updates if a model-tier router changes either during the run:

```text
Running: Terra 5 · thinking high
Last [12:34]: [submitted prompt, truncated to the terminal width]
```

The latest prompt is taken from your submitted input, so it can expose task details, identifiers, or secrets to anyone who can see your terminal, screenshots, recordings, or shared tmux session. Set `PI_STATUSLINE_LAST_PROMPT=0` before starting Pi to suppress both widget lines entirely.

## What it shows

- latest submitted prompt and its local submission time above the editor (single-line and width-truncated)
- active parent-run model and thinking level above that prompt; it updates when the model-tier router changes model or thinking mid-run
- hostname with a Nerd Font monitor icon
- current `kubectl` context when available
- current session name (truncated when necessary)
- one session guard cell, pinned in narrow and wide layouts, with a worktree count only for multiple implement leases and a documented text fallback
- `π` agent marker in its own cell; a compact model name such as `Sol 6.1`, `Terra 5.6`, or `Sonnet 5.5`, with `+` for a trailing GPT Pro variant and `OR` only for OpenRouter; and thinking level
- cautious context-capacity bar labelled `ctx` (green through 33%, yellow through 66%, then red); conversation context only, never subscription usage
- whatever model is active, the cached Codex account's weekly used capacity as `GPT`, with the ChatGPT/Codex credit balance as `GPT … · 126 cr` (or `∞ cr`)
- whatever model is active, the cached Claude Code account's 5-hour session and all-model weekly usage as `Claude 5h … · wk …`
- for `pi-claude-cli` models, a separate `Claude turn …` cell when the adapter's latest binding window adds a warning, limit, overage or per-model window the account cell lacks
- both layouts use five-block quota gauges, shrinking to three blocks when space is tight; fill is the used share, like `ctx`, and `/quota` provides percentages and reset details
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

At a validated project-workspace root, the divergence cell uses `project-workspace git-counts` to show separate counts for the root and each registered repository, in manifest order: `⇡1 ⇡4 ⇣2 ⇡1 ⇡2`. Clean repositories and zero directions are omitted; both directions for a diverged repository stay together. It does not show names, a repository-count suffix, or a summed total. Use `make git-status` for repository identities and detail. Branch and dirty markers still describe only the cwd repository.

Detection checks only the canonical cwd, never a parent workspace. Inside a member or outside a workspace, the existing cache-keyed `<branch>@{upstream}...<branch>` comparison remains unchanged. Counts use local tracking refs, disable lazy object fetching, and never fetch from remotes. The asynchronous lookup is cached and timeout-bounded; workspace collectors own a process group cleaned on completion, timeout or abort on Unix-like hosts.

Healthy workspace counts survive individual source failures, with `⚠N` for unavailable sources (including missing upstreams, detached or unborn branches). If all sources fail, the cell shows `? ⚠N`; unavailable collectors, invalid topology or malformed output show `? ⚠` with no invented source count. These failures are cached too. A fully clean workspace hides the cell. Single-repository zero counts and unavailable data still stay hidden.

## Beads count source

The table footer discovers the nearest parent `.beads` workspace. At a validated project-workspace root it uses `project-workspace beads-counts` to aggregate the root and every registered repository store; inside a registered repository and outside project workspaces it retains the nearest-store `bd` query. Open counts include non-zero `P0`–`P4` buckets, including P4 backlog work. Active and blocked counts use compact symbols. A partial workspace result keeps healthy counts and adds `⚠ N` for unavailable sources; if every source is unavailable it shows `◉ ? ⚠ N` rather than a false zero. The lookup is cached, timeout-bounded, and never runs during footer rendering. Reads within each store are serial and share one request deadline; independent workspace stores can still be queried concurrently. On Unix-like hosts each lookup owns a process group, cleaned on completion, timeout, or abort even when the collector exits before its readers. This covers descendants that stay in that group, not independently detached daemons; Windows retains direct-child cleanup. Its cell stays hidden in compact mode, outside Beads workspaces, when required commands are missing, or when topology or output is invalid.

## Codex quota and credit source

The `GPT` cell queries the authenticated Codex CLI's machine-readable `codex app-server` API (`account/rateLimits/read`) whatever provider Pi is using, because skill routing and second opinions use several accounts in one session. It does not scrape the interactive `/status` screen, read Codex credential files, or run a model turn. See [account quota caching](#account-quota-caching) for refresh, failure and staleness behaviour; a weekly window whose reset has passed shows `GPT ?` until the next lookup rather than its old value.

Quota and credits come from the same canonical `rateLimitsByLimitId.codex` snapshot, falling back to `rateLimits` when that bucket is absent. The weekly window is identified by its approximately seven-day duration rather than by assuming it is always primary or secondary. A successful response without a weekly window hides the gauge but can still show credits. An initial lookup failure renders a dim `GPT ?` and no credit balance, including when the Codex CLI is not installed (set `PI_STATUSLINE_CODEX_QUOTA=0` to hide it); a later failure retains the last successful snapshot. The cell is hidden only when disabled or before the first lookup completes.

The [`CreditsSnapshot`](https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/schema/typescript/v2/CreditsSnapshot.ts) fields are validated separately, so malformed credits do not hide valid weekly quota. Both flags must be booleans. `unlimited: true` displays `∞ cr`; otherwise a balance appears only with `hasCredits: true` and a finite, non-negative plain decimal string. The footer rounds numeric balances to whole credits for a compact display, including an explicitly reported zero. Absent, null, malformed, or unavailable credit data is hidden, not converted to zero. A successful refresh replaces the entire snapshot, clearing credits that are no longer reported. Credits share the quota lookup, timeout, failure retention and age-based staleness; a passed weekly reset affects only the weekly gauge. There is no second request.

This is **ChatGPT/Codex credit capacity, not OpenAI API-platform billing credit or a dollar balance**. The displayed quota and credits belong to the account authenticated in the Codex CLI. They represent Pi's active OpenAI-Codex account only when Pi and Codex are signed into the same ChatGPT account; the statusline does not verify account alignment.

## Claude account usage source

The `Claude` cell runs Claude Code's built-in local `/usage` command through the same [collector](claude-usage.ts) as the `claude-quota` helper: `claude -p /usage --no-session-persistence --output-format json`, from the temporary directory so project settings do not apply, with no prompt, model turn or saved session. It parses the `Current session` (`5h`) and `Current week (all models)` (`wk`) lines; per-model weekly lines are not shown. It runs whatever provider Pi is using.

The panel is undocumented text. A missing or unrecognised window shows `5h ?` or `wk ?`, never zero; a panel with neither shows `Claude ?`, as does an initial lookup failure. A window whose reset has passed shows `?` until the next lookup. Above 100% the gauge stays full and adds `>100%`. A response that is not the local `usage` command, or reports any model turn or cost, is refused and **stops further Claude lookups until `/reload`**, so a changed CLI cannot spend usage every refresh; a missing `claude` CLI also stops them.

The values describe the account Claude Code is signed in to. Their alignment with Pi's Claude provider account is not verified, and API-key, Bedrock/Vertex or OpenRouter Claude usage is never represented. Each lookup starts Claude Code with its user-level settings, so user hooks or update checks that run on every invocation run on every refresh too.

### pi-claude-cli turn telemetry

For `pi-claude-cli` models, the adapter publishes a `claude-rate-limit` status with only the **binding** window of its latest turn. Reading it needs no lookup, polling or credentials. The footer shows it as a separate `Claude turn <window>` cell, never as account-wide usage, and only when it adds a signal: a warning or `limit`, over 100%, extra usage, a window other than `5h`/`Wk` (`Wk Opus`, `Wk Sonnet`, `Extra`), or no fresh account snapshot. A routine `allowed` 5-hour or weekly reading is left to the account cell.

A gauge appears only when `utilization` is a finite, non-negative number; a reported `0` shows an empty gauge, while missing utilization shows the label alone rather than `0%`. Above 100% the gauge stays full and the label adds `>100%`. Tone is the more severe of the reported status and the shared quota thresholds: `allowed_warning` is at least yellow, `rejected` (labelled `limit`) and over-100% are red. `isUsingOverage` adds `· extra`.

The turn cell is hidden for an `allowed` window without utilization or extra usage, for unknown status values or window types, for malformed JSON, after the adapter clears the status (model change, session tree, compaction or shutdown), and once `resetsAt` has passed. A reading without a valid `resetsAt` is hidden because nothing else bounds its age: `observedAt` only changes when the payload changes, so it is not used as freshness evidence.

## Account quota caching

Each footer instance keeps one cache per account source (Codex and Claude Code), configured when the footer starts. Rendering only reads cached snapshots; the footer's one-second tick starts a lookup when one is due. Each cache allows one lookup in flight, refreshes every `*_QUOTA_TTL` (default five minutes for Codex, 15 for Claude Code) after a success, and after consecutive failures waits one, two, then four intervals, capped at 30 minutes or the interval if longer. Model and provider switches never start a lookup. A failed refresh keeps the last good snapshot. A snapshot older than `*_QUOTA_STALE` (default 15 minutes for Codex, 30 for Claude Code) is dimmed and prefixed `~`. When Pi disposes the footer, in-flight lookups are aborted and their processes killed; late results are ignored.

Footers on one host share each source's latest snapshot through a private per-user directory: `$XDG_RUNTIME_DIR/pi-statusline` when that runtime directory is private, otherwise `pi-statusline` under `$XDG_CACHE_HOME` or `~/.cache`, created `0700` (`PI_STATUSLINE_QUOTA_CACHE_DIR` overrides it; `PI_STATUSLINE_QUOTA_CACHE=0` disables sharing). A due refresh first reads the shared snapshot and reuses it while it is younger than the refresh interval; otherwise one footer takes a lock file and looks up while the others wait for its result. Concurrent sessions therefore make about one Codex lookup every five minutes and one Claude Code lookup every 15 minutes between them, plus each session's separate OpenRouter refresh.

Entries are keyed by a SHA-256 digest of the user, the CLI's configuration directory (`CLAUDE_CONFIG_DIR` or `~/.claude`, `CODEX_HOME` or `~/.codex`), the resolved executable's metadata and whether its credential file exists (never the file's contents or timestamps, which Claude Code rewrites on every token refresh), so a CLI upgrade, sign-out or different configuration directory misses. Signing the same configuration directory into a different account is not detected: another session's figures for the previous account may show for at most one interval. Entries left under an old digest are removed a day after their last write. Sharing is off while an API-key, base-URL or cloud-provider override such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` is set. Cached files are mode `0600` and hold only the parsed percentages, reset times, Codex credit figures and that digest; malformed, foreign, future-dated or group-readable entries are ignored. A failed lookup records a cooldown for one interval so the other sessions back off instead of retrying in turn; a missing `claude` CLI is never shared because PATH differs per session. A lock is reclaimed only when its holder has exited or it is older than the lookup timeout plus 30 seconds. Without a usable directory each footer looks up on its own as before. `/quota` always makes its own fresh lookup and never reads this cache. Raise the TTLs or disable a source to reduce the volume.

## OpenRouter credit source

The optional `OR` segment calls OpenRouter's `GET /api/v1/credits` endpoint and displays `total_credits - total_usage`. OpenRouter requires a management key for this account-level endpoint; normal inference keys receive HTTP 403. When `PI_STATUSLINE_OPENROUTER_PROJECT` or `SECRET_API_KEY_PROJECT` is set, the statusline loads it once with `secret-api-key lookup openrouter_management PROJECT`. The API lookup is asynchronous, cached, and timeout-bounded. A transient refresh failure keeps the last successful balance and immediately renders it dim; age also dims a snapshot after the configured stale interval. Missing, rejected, and malformed responses stay hidden.

The statusline intentionally does not read `OPENROUTER_API_KEY`, log credentials or response bodies, or render the management key. The legacy explicit management-key environment variable remains supported, but keyring lookup avoids exposing the key to Pi's child commands.
