# Pi non-default-model advisory assessment

- **Date:** 2026-07-31
- **Issue:** `ai-tools-la1`
- **Runtime assessed:** Pi `0.82.1`
- **Outcome:** No-go for a general mismatch notification

## Decision

Do not add a Pi advisory that infers an unintended model choice by comparing the effective model with `~/.pi/agent/pl-launcher.json.defaultModel`.

Pi exposes the effective model but not why it was selected. The same mismatch can be an explicit launcher or CLI override, resumed session state, a manual model choice, a temporary model-tier-router route, another extension's choice, or an independently launched Pi process. A confirmation and 60-minute suppression can reduce repeated notices, but cannot make the first notice correct.

Keep the existing factual statusline as the smallest safe alternative. It shows the current effective model and thinking level and, during an active run, shows `Running: <model> · thinking <level>`. It follows router changes without claiming they are accidental and without changing model state.

This decision is notification-only: no model or thinking setter, restoration, Pi settings write, or launcher configuration write is permitted.

## Decisive Pi evidence

The installed Pi runtime is `0.82.1`. The statusline's development dependency remains `0.80.6`, but the decisive provenance gap exists in both versions.

Installed paths below are relative to the Pi `0.82.1` package at:

```text
/home/linuxbrew/.linuxbrew/Cellar/pi-coding-agent/0.82.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent/
```

- `dist/core/extensions/types.d.ts:409-415` defines `session_start` reasons as lifecycle state. Initial fresh, CLI override, continue, and resume process launches do not expose which model-selection path produced the startup model.
- `dist/core/extensions/types.d.ts:594-600` limits `model_select.source` to `set | cycle | restore`. It does not identify the caller.
- `dist/core/extensions/runner.js:482-484` exposes `ctx.model` as the effective model, without selection provenance.
- `dist/core/model-resolver.js:440-540` can choose an initial model from explicit CLI input, scoped models, settings defaults, provider defaults, or available fallbacks. Extensions receive the result, not the selected branch.
- `dist/core/sdk.js:73-105` also considers restored session state before falling back to initial-model resolution.
- `dist/core/agent-session.js:1179-1265` shows model setters and cycling update session/settings state and emit only the coarse event sources above.

Session history records selected models, not selection intent. A history check would suppress many resumes but would not classify empty saved sessions, explicit startup overrides, or another launcher's intent.

Pi also has no universal parent/subagent identity in extension context. TUI mode and package-specific environment variables can exclude known processes but cannot prove that every remaining process is the intended parent.

## Local launcher and router evidence

`pi/launcher/pl.fish` applies launcher defaults to fresh sessions and deliberately omits them from continue/resume flows unless the user supplies an explicit override. `pi/launcher/README.md` documents that resumed sessions preserve their saved model. The launcher currently emits no extension-visible provenance marker.

The extracted model-tier router at `/home/ivar/Code/flurdy/pi-skill-model-router/index.ts` changes and restores models through `pi.setModel()`. It recognizes its own calls with a private `switchingModel` guard (`index.ts:119,419-425,488-494,561-571`). Other extensions cannot read that ownership, so a router route and a manual `/model` selection both appear as `source === "set"`.

Restoration may also be deferred until settlement or retried after failure. Waiting for `agent_settled`, parsing router status text, depending on extension order, or delaying a warning would therefore remain incomplete and brittle.

The earlier `docs/pi-direct-turn-model-routing-assessment.md` in the extracted `pi-skill-model-router` repository reached the same provenance and persistent-default conclusions for Pi `0.80.6`. Pi `0.82.1` improves model/session observability but does not add initial model-source or extension-owned model-change provenance.

## Exact comparison contract

Exact equality is technically observable even though intent is not.

A future factual comparison would need to:

1. Read a JSON object with an own `defaultModel` string.
2. Require a non-empty, whitespace-free value.
3. Split at the first `/`, preserving the full remainder because model IDs can contain additional slashes.
4. Require non-empty provider and model ID components.
5. Compare the case-sensitive tuple `(ctx.model.provider, ctx.model.id)` rather than display labels, aliases, lower-cased values, or final path segments.
6. Fail silent when the configuration, parsed identity, or effective model is unavailable.

The current launcher validates only a non-empty, whitespace-free string; it does not require a resolvable `provider/model` pair. Tightening launcher validation is separate scope and must not be hidden inside an advisory.

Exact inequality establishes only that two values differ. It does not establish that the effective model is wrong.

## Scenario disposition

| Scenario | Observable fact | Safe decision |
| --- | --- | --- |
| Fresh `pl` default | `pl` passes its default through `--model`; Pi exposes the effective tuple | Equality is factual. A mismatch is not attributable without a launcher contract and should normally fail earlier. |
| `pl --model=X` | Effective X, without public launcher-source metadata | Do not warn; the mismatch is intentional. |
| Direct `pi --model X` or another launcher | Effective X only | Do not apply `pl` policy to an unrelated process. |
| Continue or resume | Saved effective model; initial event may still be `startup` | Do not warn; preserving saved state is documented launcher intent. |
| Manual `/model` or model cycling | Later event source is `set` or `cycle` | Display current state factually; do not infer error. |
| Router route or restoration | Generic `set` events and private router ownership | Do not warn; the existing running-model widget follows actual state. |
| Deferred or failed restoration | A mismatch can outlive normal settlement | Let the router report its precise failure instead of misattributing it to launch policy. |
| Concurrent parent sessions | Separate contexts with shared config/settings | No provenance gain; shared suppression would add locking and merge races. |
| Installed `pi-subagents` child | `PI_SUBAGENT_CHILD=1`, generally JSON mode and sometimes `--no-extensions` | Useful defense for this package, not a universal Pi child contract. |
| Unknown child or SDK process | No standard child provenance | Do not warn. |

`PI_SUBAGENT_PARENT_SESSION` must not be used as a child test because the installed package also sets it in the root process.

## Why suppression does not rescue the advisory

A suppression entry could be keyed by the exact effective/default pair and expire after 60 minutes. That would deduplicate repeated observations of the same pair, but every intentional CLI override, resume, or router route would still receive the first false warning.

Durable suppression would also require bounded entries, TTL pruning, private permissions, corruption handling, and cross-process locking or merge semantics. Those mechanisms add state and failure modes without adding provenance. They are therefore YAGNI for the rejected advisory.

## Smallest safe alternative

The current statusline already renders factual state from `ctx.model` in `pi/statusline/pi-statusline.ts:385-420` and tracks active model/thinking changes in `pi/statusline/pi-statusline.ts:209-309`. `pi/statusline/README.md` documents both the current-model cell and active `Running:` widget.

Do not add a warning-colored mismatch cell. A neutral `launch default: X` label would remain factual, but it is likely redundant and requires a separate product decision.

## Conditional future path

A narrower launcher-attested startup check is technically possible only with explicit new scope:

- `pl` supplies a non-inherited extension argv flag only when it fills a fresh session's model from launcher defaults;
- explicit model overrides, continue, and resume omit the flag;
- the extension checks once during initial TUI startup and never observes later model events;
- absent, malformed, changed, or propagated markers fail silent;
- nested/subagent behavior is proven with an isolated `PI_CODING_AGENT_DIR`.

This path is not recommended now. A fresh defaulted `pl` launch already passes the same model through `--model`, so a safely attributable disagreement should be exceptional or fail during CLI resolution. Implementing a launcher/extension protocol for that invariant has low expected value.

Reassess only if Pi adds documented initial model-source and extension-owned model-change provenance, or if a separately approved launcher-attestation experiment demonstrates useful mismatches without marker propagation.

## Validation

Evidence was rechecked against installed Pi `0.82.1`, the current launcher, and the extracted router. Existing behavior also passed:

```text
shared/launcher/test.sh
# ok

npm --prefix pi/statusline test
# 53 tests passed

npm --prefix pi/statusline run typecheck
# passed
```

The live `~/.pi/agent/extensions/model-tier-router` symlink currently targets the nonexistent `/home/ivar/Code/flurdy/pi-model-tier-router`; the checkout is `/home/ivar/Code/flurdy/pi-skill-model-router`. This unrelated setup issue prevents meaningful live router UAT and was not repaired as part of this assessment.

## Conclusion

Close `ai-tools-la1` as assessed/no-go. Runtime behavior remains unchanged. Do not create follow-up implementation work unless a neutral factual label, launcher-attestation prototype, launcher parser change, or router setup repair is separately approved.
