# Pi Model Tier Router

Small, provider-neutral Pi extension that maps semantic skill metadata such as `model-tier: standard-coding` to exact locally configured models and honors skill `effort` as Pi's thinking level. It restores the previous model and thinking level when the agent run settles.

Exact provider/model IDs stay in local JSON configuration; the extension contains no provider defaults.

## Requirements

- Pi 0.80.6 or newer
- Node.js 22.19 or newer for the development scripts

## Configure

List the models available with your current authentication:

```bash
pi --list-models
```

Copy the example and replace every placeholder with an exact `provider/model-id` from that output:

```bash
cp ./pi/model-tier-router/model-tier-router.example.json \
  ~/.pi/agent/model-tier-router.json
$EDITOR ~/.pi/agent/model-tier-router.json
```

Candidate order is fallback order. Every candidate must explicitly declare a boolean `metered` value; candidates without one are rejected rather than assumed free. `metered` is local cost knowledge, and the router never guesses from provider or authentication details. A metered candidate needs confirmation when the skill declares `model-metered-policy: ask-above-standard`, `cap-or-ask`, or `ask-before-metered-panel`, or declares `model-cost-policy: deliberate-premium`. Such a route is safely skipped when confirmation is required but no UI is available.

A trusted project can override top-level options and complete tier entries in:

```text
<project>/.pi/model-tier-router.json
```

Project configuration is ignored unless Pi trusts the project. A project tier replaces the global tier with the same name; other global tiers remain available.

Supported options:

- `enabled`: enable routing on load.
- `routeImplicitSkillReads`: route model-initiated `read` calls for skills loaded into that turn's Pi system prompt.
- `restoreAfterRun`: restore the pre-route model and thinking level at `agent_settled`.
- `tiers.<name>.rank`: nested skills may move to a higher rank, but never to an equal or lower rank.
- `tiers.<name>.thinking`: default Pi thinking level when the skill does not declare `effort`.
- `tiers.<name>.candidates`: exact, ordered model candidates and their local `metered` flag.
- `usageLedger`: optional global-only local telemetry. It defaults to disabled; when enabled it writes Pi-normalized assistant-response token counters under `~/.pi/agent/model-tier-router/usage/v1/`. `retentionDays` and `maxBytes` bound retention. Project configuration cannot enable it.

## Skill metadata

The router reads these optional frontmatter fields with Pi's frontmatter parser:

```yaml
model-tier: premium-review
model-cost-policy: deliberate-premium
model-metered-policy: ask-above-standard
effort: high
```

The confirmation policies documented above require confirmation for a metered candidate and are included in its confirmation message. Other or absent policy values do not add a confirmation gate. A valid `effort` value (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`) overrides the tier's default thinking level. Nested skills may raise thinking but never lower it. The router deliberately ignores Claude-specific `model: haiku` and `model-second-opinion-tier`.

Explicit `/skill:name` commands are detected during Pi's `input` event and routed from `before_agent_start` only after Pi has accepted and expanded that skill. This prevents a later input handler from leaving behind a premature model switch. Skill commands queued while an agent is already streaming continue on the active model because Pi 0.80.6 has no pre-provider boundary where a queued route can be applied safely; the router warns instead of switching too early. Model-initiated reads route only when the canonical read path exactly matches a skill file Pi loaded for that turn. This includes `SKILL.md` and registered root skill Markdown files without scanning or reimplementing Pi's discovery rules.

## Install for testing

```bash
pi -e ./pi/model-tier-router/index.ts
```

## Install globally

From this repository:

```bash
mkdir -p ~/.pi/agent/extensions
ln -sfn "$PWD/pi/model-tier-router" \
  ~/.pi/agent/extensions/model-tier-router
```

Restart Pi or run `/reload`.

## Commands

```text
/model-tier status
/model-tier usage
/model-tier reload
/model-tier on
/model-tier off
```

`reload` rereads router JSON configuration. `on` and `off` are in-memory overrides for the current extension instance; they do not edit local files.

Status reports the active tier and skills, selected/original models, pending restoration, loaded configuration paths, route warnings, and ledger health.

`/model-tier usage` summarizes local records by tier and exact provider/model. It labels them **Pi-normalized observed responses**: they are not subscription quota, provider billing, or cross-provider cost. Pi's `usage.cost` is calculated from configured local model prices, so it is intentionally not persisted as provider-reported cost. Cache reads, cache writes (including optional one-hour writes), output, and optional reasoning counters remain separate; unavailable or ambiguous zero counters are reported as unknown.

The ledger records neither prompts nor responses, repository/session-file paths, response IDs, account identifiers, or credentials. It is best-effort: records may be dropped on a full queue, disk error, or abrupt shutdown, and persistence never delays routing or restoration. Separate Pi subprocesses (including `pi-subagents` workers) are not rolled into a parent routed run.

## Development

Install development dependencies, then run focused tests and typechecking:

```bash
cd pi/model-tier-router
npm install
npm test
npm run typecheck
```

Pi loads `index.ts` directly; no build output is required.

## Lifecycle notes

- The first routed skill snapshots the current model and thinking level.
- Higher-ranked nested skills may upgrade the route. Equal- or lower-ranked skills retain the current route, while any nested skill may raise but not lower thinking effort.
- Candidate availability comes from `ctx.modelRegistry.getAvailable()`.
- A manual model selection during a routed run disables further routing and cancels automatic restoration, so the extension does not fight `/model` or model cycling.
- A failed restoration remains visible as pending and is retried when the agent next settles; routing pauses until restoration succeeds or the user manually chooses another model.
- Session shutdown/reload attempts the same safe restoration when appropriate.

## Contributing

Issues and pull requests are welcome, especially for new routing-policy use cases and Pi compatibility fixes.

## License

[MIT](../../LICENSE) © [Ivar Abrahamsen](https://flurdy.com)
