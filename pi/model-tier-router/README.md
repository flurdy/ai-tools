# Pi Model Tier Router

Small, provider-neutral Pi extension that maps semantic skill metadata such as `model-tier: standard` to exact locally configured models and honors skill `effort` as Pi's thinking level. It restores the previous model and thinking level when the agent run settles.

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

Candidate order is fallback order. Every candidate must explicitly declare a boolean `metered` value; candidates without one are rejected rather than assumed free. `metered` is the local spend authority, and the router never guesses from provider, authentication details, or portable skill metadata. Every `metered: true` candidate requested through an explicit `/skill:name` command requires interactive confirmation. Declining, or running without a confirmation UI, skips the switch and retains the prior model. `metered: false` is the user's explicit local classification that the candidate may route without a spend prompt.

Model-initiated skill reads never open a blocking spend prompt. An implicit read may route to `metered: false`, but it skips `metered: true` and retains the current route/model. In the copied example configuration, the premium placeholders are therefore confirmation-only for explicit skill commands even though `routeImplicitSkillReads` is enabled.

A trusted project can override top-level options and complete tier entries in:

```text
<project>/.pi/model-tier-router.json
```

Project configuration is ignored unless Pi trusts the project. A project tier replaces the global tier with the same name; other global tiers remain available.

Supported options:

- `enabled`: enable routing on load.
- `routeImplicitSkillReads`: route model-initiated `read` calls for skills loaded into that turn's Pi system prompt.
- `tiers.<name>.rank`: nested skills may move to a higher rank, but never to an equal or lower rank.
- `tiers.<name>.thinking`: default Pi thinking level when the skill does not declare `effort`.
- `tiers.<name>.candidates`: exact, ordered model candidates and their local `metered` flag.
- `usageLedger`: optional global-only local telemetry. It defaults to disabled; when enabled it writes Pi-normalized assistant-response token counters under `~/.pi/agent/model-tier-router/usage/v1/`. `retentionDays` and `maxBytes` bound retention. Project configuration cannot enable it.

The shared portable taxonomy uses `economy` for low-risk deterministic work,
`standard` for normal workflows and bounded implementation, and `premium` for work
where substantial judgment or the cost of a mistake justifies the strongest configured
capability. Skill `effort` expresses reasoning depth independently, so `standard` can
serve both routine coordination and high-effort coding. Configure these three routes
with strictly increasing ranks so nested skills can upgrade but never silently
downshift.

The router continues to accept arbitrary private/project tier names, but shared skills
should use only economy, standard, or premium.

## Skill metadata

The router reads these optional frontmatter fields with Pi's frontmatter parser:

```yaml
model-tier: premium
effort: xhigh
```

The local candidate's `metered` flag alone controls the confirmation gate. Skill metadata cannot waive that gate. A valid `effort` value (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`) overrides the tier's default thinking level. Nested skills may raise thinking but never lower it. The router deliberately ignores Claude-specific `model: haiku` metadata.

Explicit `/skill:name` commands are detected during Pi's `input` event and routed from `before_agent_start` only after Pi has accepted and expanded that skill. This prevents a later input handler from leaving behind a premature model switch. Skill commands queued while an agent is already streaming continue on the active model because Pi 0.80.6 has no pre-provider boundary where a queued route can be applied safely; the router warns instead of switching too early. Model-initiated reads route only when the canonical read path exactly matches a skill file Pi loaded for that turn. This includes `SKILL.md` and registered root skill Markdown files without scanning or reimplementing Pi's discovery rules; metered matches fail closed without prompting, while unmetered matches may route normally.

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

`/model-tier usage` summarizes local records by tier and exact provider/model in a compact table. It labels them **Pi-normalized observed responses**: they are not subscription quota, provider billing, or cross-provider cost. Pi's `usage.cost` is calculated from configured local model prices, so it is intentionally not persisted as provider-reported cost. Cache reads, cache writes (including optional one-hour writes), output, and optional reasoning counters remain separate; unavailable or ambiguous zero counters are reported as unknown. Summaries read only canonical `YYYY-MM-DD.jsonl` regular files managed by the ledger.

The ledger records neither prompts nor responses, repository/session-file paths, response IDs, account identifiers, or credentials. It is best-effort: records may be dropped on a full queue, disk error, or abrupt shutdown, and persistence never delays routing or restoration. Configuration reload reuses an unchanged ledger, preserving its queue and health counters; changing or disabling ledger bounds drains the previous instance before replacement. Separate Pi subprocesses (including `pi-subagents` workers) are not rolled into a parent routed run.

## Development

Install the Node version pinned in `.nvmrc`, then run the focused tests and typechecking through that runtime. These commands remain reliable when the shell's default `node` is older:

```bash
cd pi/model-tier-router
fnm install
fnm exec --using=.nvmrc npm install
fnm exec --using=.nvmrc npm test
fnm exec --using=.nvmrc npm run typecheck
```

With `nvm`, run `nvm install && nvm use` before the same `npm` commands. Pi loads `index.ts` directly; no build output is required.

## Lifecycle notes

- The first routed skill snapshots the current model and thinking level.
- Higher-ranked nested skills may upgrade the route. Equal- or lower-ranked skills retain the current route, while any nested skill may raise but not lower thinking effort.
- Candidate availability comes from `ctx.modelRegistry.getAvailable()`.
- A manual model selection during a routed run disables further routing and cancels automatic restoration, so the extension does not fight `/model` or model cycling.
- Restoration is deferred when another run is already active, then retried at the next `before_agent_start` boundary before any new route is applied.
- A failed restoration remains visible as owed and is retried before the next run or when the agent next settles; routing pauses while usage attribution stays attached to the still-active route. A manual model selection clears the owed state.
- Session shutdown/reload attempts restoration eagerly even when the agent is not idle.

## Contributing

Issues and pull requests are welcome, especially for new routing-policy use cases and Pi compatibility fixes.

## License

[MIT](../../LICENSE) © [Ivar Abrahamsen](https://flurdy.com)
