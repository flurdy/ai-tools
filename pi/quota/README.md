# Quota helpers

Two standalone CLIs print subscription quota as JSON. They are the data sources behind the
`/quota` prompt in [flurdy/agent-skills](https://github.com/flurdy/agent-skills)
(`prompts/quota.md`) and can be run directly for a check that costs no model turn:

- `codex-quota`: the Codex CLI account's weekly GPT quota, reset time, and credit balance.
- [`claude-quota`](#claude-quota): the Claude Code account's session and weekly usage windows.

`codex-quota` reuses the statusline's [`codex-quota.ts`](../statusline/codex-quota.ts): one `codex app-server`
request for `account/rateLimits/read`, selecting the canonical `codex` bucket and the seven-day
window by duration. It reads no credential files, scrapes no interactive screen, runs no model turn,
and never changes the signed-in account, model, limits, or balance. The lookup works whichever
provider Pi is currently using.

## Install

Requires Node.js 22.19 or later, plus a signed-in [Codex CLI](https://github.com/openai/codex)
for `codex-quota` and a signed-in [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
CLI for `claude-quota`, on `PATH`. From the ai-tools root:

```bash
make apply
make verify-apply
```

This installs the existing Pi resources and executable `~/bin/codex-quota` and
`~/bin/claude-quota` symlinks into this checkout. It refuses conflicting files, directories and
symlinks before installing any links, and verification checks each helper's target and
executable bit. Keep this checkout available:
copying the entry file alone would break its relative imports.

Override the commands directory explicitly with `BIN_DIR` (absolute, non-root path):

```bash
make apply BIN_DIR="/absolute/path/to/bin"
make verify-apply BIN_DIR="/absolute/path/to/bin"
```

Ensure the selected directory is on the PATH inherited by Pi, not only your interactive shell.
These are standalone Node CLIs, not Pi extensions; `/quota` remains the separately installed
agent-skills prompt.

## Use

```bash
codex-quota                      # JSON report
codex-quota --timeout-ms 5000    # bound one lookup (100–120000 ms, default 10000)
codex-quota --help
```

Exit codes: `0` report printed, `1` lookup failed (JSON error envelope on stdout), `2` usage error.

A successful report:

```json
{
  "schemaVersion": 1,
  "status": "ok",
  "source": "codex-cli-account",
  "timeZone": "Europe/London",
  "fetchedAt": "2026-10-10T12:00:00.000Z",
  "fetchedAtLocal": "2026-10-10 13:00 BST (Europe/London)",
  "weekly": {
    "usedPercent": 73.4,
    "remainingPercent": 26.6,
    "resetsAt": "2026-10-14T05:05:30.000Z",
    "resetsAtLocal": "2026-10-14 06:05 BST (Europe/London)",
    "untilReset": { "seconds": 320730, "text": "3d 17h 5m" },
    "resetPassed": false
  },
  "credits": { "kind": "balance", "balance": "126.4375" },
  "caveats": ["…"]
}
```

- Percentages and `credits.balance` are exactly as the provider reported them: no rounding and no
  conversion into dollars, requests, or extra weekly allowance. `credits` is `{"kind":"unlimited"}`
  when the account reports unlimited credits; an explicit zero balance stays `"0"`.
- `weekly`, `weekly.resetsAt`, and `credits` are `null` when the provider did not report them. Null
  means unknown, never zero, and a caveat says which field was missing.
- `resetPassed: true` marks a window whose reported reset time is already in the past; the
  percentages are stale and should not be presented as current. `untilReset` is then `null`.
- Local timestamps use the process time zone (`TZ` is honoured) and name the IANA zone explicitly.
- `caveats` always includes the source caveat: values describe the account signed in to the Codex
  CLI, whose alignment with Pi's active account is not verified; credits are ChatGPT/Codex
  capacity, not OpenAI API dollar credit; a snapshot does not guarantee future requests.

A failure:

```json
{
  "schemaVersion": 1,
  "status": "error",
  "source": "codex-cli-account",
  "error": { "kind": "codex-cli-missing", "message": "The Codex CLI (`codex`) was not found on PATH; …" },
  "caveats": ["…"]
}
```

`error.kind` is `codex-cli-missing`, `timeout`, or `lookup-failed`. Messages are sanitized
(control sequences removed, the home directory shortened to `~`, bearer tokens and API-key-shaped
strings redacted, length bounded) and never include raw protocol output. A `lookup-failed` error
whose message looks like a sign-in problem carries a `hint` pointing at `codex login status`; that
is a heuristic, not a verified cause. Timeouts terminate the Codex child process before returning,
and nothing is retried.

The `/quota` prompt that renders this report consumes a normal model turn; only the direct
`codex-quota` command is free of inference.

## claude-quota

`claude-quota` runs one local Claude Code command and parses its usage panel:

```bash
claude -p "/usage" --no-session-persistence --output-format json
```

That is Claude Code's built-in `/usage` command, answered without a model turn or cost, and no
session is saved. It runs from the temporary directory, so the caller's project settings do not
apply. The helper reads no credential files, sends no prompt, and never signs in or changes
settings. Options and exit codes match `codex-quota` (`--timeout-ms`, default 10000 ms).

```json
{
  "schemaVersion": 1,
  "status": "ok",
  "source": "claude-code-usage",
  "timeZone": "Europe/London",
  "fetchedAt": "2026-10-18T21:00:00.000Z",
  "fetchedAtLocal": "2026-10-18 22:00 BST (Europe/London)",
  "windows": [
    {
      "label": "Current session",
      "usedPercent": 12,
      "resetsAtText": "Oct 19, 3:19am",
      "resetsTimeZone": "Europe/London",
      "resetsAt": "2026-10-19T02:19:00.000Z",
      "resetsAtLocal": "2026-10-19 03:19 BST (Europe/London)",
      "untilReset": { "seconds": 19140, "text": "5h 19m" },
      "resetPassed": false
    }
  ],
  "caveats": ["…"]
}
```

- `windows` lists every `Current …: N% used · resets <time> (<zone>)` line in panel order, such
  as the session, all-models week and per-model weeks. `label`, `usedPercent`, `resetsAtText` and
  `resetsTimeZone` are as printed; an explicit `0%` stays `0`.
- The panel is undocumented text. A value that does not match the known format is `null` with a
  caveat naming the window, never zero. Unmatched limit-like lines and a panel with no windows
  also produce caveats. Fixtures under `fixtures/` cover the Claude Code 2.1.302 format and a
  changed one.
- The panel omits the year, so `resetsAt` is the first matching time after retrieval in the
  reported zone; a caveat says so. `resetsAt` is `null` when the time or zone is not recognised.
- The panel's approximate, local-only "What's contributing" section is not reported.

Failures use the same envelope as `codex-quota`, with `source: "claude-code-usage"`. `error.kind`
is one of:

- `claude-cli-missing`.
- `timeout`: the process group is killed first.
- `lookup-failed`: a non-zero exit or an error result. Messages that look like sign-in problems
  carry a `claude auth status` hint.
- `unexpected-response`: the helper fails closed. This covers output that is not JSON or exceeds
  1 MiB, a result that is not the `usage` local command, and any non-zero `num_turns` or
  `total_cost_usd`.

Messages are sanitized as for `codex-quota`, and nothing is retried.

## Develop and test

From the ai-tools root, after installing the statusline's development dependencies:

```bash
make check-quota
cd pi/quota && ../statusline/node_modules/.bin/tsc --noEmit
```

The tests drive each executable against a fake `codex` or `claude` on `PATH`; they never contact
OpenAI or Anthropic.
