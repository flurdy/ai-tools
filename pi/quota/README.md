# Codex quota helper

`codex-quota` prints the Codex CLI account's weekly GPT quota, reset time, and credit balance as
JSON. It is the data source behind the `/quota` prompt in
[flurdy/agent-skills](https://github.com/flurdy/agent-skills) (`prompts/quota.md`) and can be run
directly for a check that costs no model turn.

It reuses the statusline's [`codex-quota.ts`](../statusline/codex-quota.ts): one `codex app-server`
request for `account/rateLimits/read`, selecting the canonical `codex` bucket and the seven-day
window by duration. It reads no credential files, scrapes no interactive screen, runs no model turn,
and never changes the signed-in account, model, limits, or balance. The lookup works whichever
provider Pi is currently using.

## Install

Requires Node.js 22.19 or later and a signed-in [Codex CLI](https://github.com/openai/codex) on
`PATH`. Link the executable somewhere on your `PATH`, for example:

```bash
ln -s "$PWD/pi/quota/codex-quota.ts" ~/.local/bin/codex-quota
```

`make apply` does not install it: the helper is a shell command, not a Pi extension.

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

## Develop and test

From the ai-tools root, after installing the statusline's development dependencies:

```bash
make check-quota
cd pi/quota && ../statusline/node_modules/.bin/tsc --noEmit
```

The tests drive the executable against a fake `codex` on `PATH`; they never contact OpenAI.
