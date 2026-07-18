# Pi-crew pattern assessment

- **Date:** 2026-07-17
- **Source:** [`baphuongna/pi-crew`](https://github.com/baphuongna/pi-crew) at commit [`7aa077d42839603744153347b974a036b5bb0dce`](https://github.com/baphuongna/pi-crew/tree/7aa077d42839603744153347b974a036b5bb0dce)
- **Local targets:** shared `/orchestrate` workflow and Pi model-tier router

## Decision

Pi-crew contains useful patterns primarily for the shared `/orchestrate` workflow and only marginally for the model-tier router.

Borrow its **advisory vocabulary and control-plane patterns**, not its durable scheduler or subprocess runtime. Pi-crew's runtime lifecycle overlaps with capabilities already owned by `pi-subagents`, while `/orchestrate` is intentionally a conservative, parent-owned coordination workflow rather than a persistent scheduler.

> **Reconciliation (2026-07-18):** The `/orchestrate` changes in [Recommended change](#recommended-change) — advisory topology-preflight, structured recommendation/confidence/limits, and `needs-attention` normalization — are **superseded by `skills-mcn`**, which paused adaptive expansion of `/orchestrate` and closed the matching capability beads (`skills-rd6.2`, `skills-rd6.3`). Those items add advisory *prose* to a skill prompt — ceremony that re-describes coordination judgment a premium model already supplies — which the pause specifically ruled against. Only the two **router-side** ideas survive, tracked under epic `ai-tools-gc2`: `ai-tools-gc2.1` (bounded, consent-safe fallback) and `ai-tools-gc2.2` (normalized route-decision record). Keep this doc as the pi-crew analysis of record; do not implement the orchestrate items without new evidence that a real coordination outcome improves.

## Patterns worth adopting

### 1. Explicit topology preflight in `/orchestrate`

Pi-crew classifies work as `single`, `sequential`, `concurrent`, `complex-dag`, or `dynamic`, while reporting step count, fan-out, and DAG depth ([source](https://github.com/baphuongna/pi-crew/blob/7aa077d42839603744153347b974a036b5bb0dce/src/workflows/topology-analyzer.ts#L23-L35)). Its preflight remains advisory rather than blocking execution ([source](https://github.com/baphuongna/pi-crew/blob/7aa077d42839603744153347b974a036b5bb0dce/src/workflows/preflight-validator.ts#L77-L90)).

That fits `/orchestrate` well. Its existing work graph could produce a compact result such as:

```text
topology: coherent | serial | parallel | dag | adaptive
metrics: units=4, ready=2, max-depth=3, fan-in=yes
recommendation: direct | serial delegate | parallel recon | isolated panel | architect
confidence: high
reasons: two independent read-only investigations; one shared writer
limits: fanout=2, writers=1, repair-passes=1
```

This would make the “does delegation pay?” decision more consistent without creating a scheduler.

Do not copy pi-crew's exact thresholds. Its classifier only calls fan-out concurrent at three or more workers ([source](https://github.com/baphuongna/pi-crew/blob/7aa077d42839603744153347b974a036b5bb0dce/src/workflows/topology-analyzer.ts#L171-L190)), whereas the local Best-of-N spike supports two candidates as the normal expensive comparison shape.

### 2. Structured recommendations with reasons and confidence

Pi-crew returns a recommendation containing workflow, action, workspace mode, confidence, decomposition, and reasons ([source](https://github.com/baphuongna/pi-crew/blob/7aa077d42839603744153347b974a036b5bb0dce/src/extension/team-recommendation.ts#L155-L177), [source](https://github.com/baphuongna/pi-crew/blob/7aa077d42839603744153347b974a036b5bb0dce/src/extension/team-recommendation.ts#L237-L256)). It also supports declarative `triggers` and `useWhen` metadata ([source](https://github.com/baphuongna/pi-crew/blob/7aa077d42839603744153347b974a036b5bb0dce/src/extension/team-recommendation.ts#L171-L190)).

For `/orchestrate`, reusable execution shapes could declare:

- `useWhen`;
- `avoidWhen`;
- expected independence;
- writer mode;
- default fan-out;
- required evidence;
- escalation conditions.

These should inform parent judgment rather than automatically route work based on keywords.

Pi-crew's textual decomposition is too brittle to adopt: it can split numbered lists, bullets, or conjunctions into tasks ([source](https://github.com/baphuongna/pi-crew/blob/7aa077d42839603744153347b974a036b5bb0dce/src/extension/team-recommendation.ts#L106-L147)), but syntactic separation does not prove independent ownership.

### 3. Standard `needs-attention` handling

Pi-crew distinguishes idle workers and repeated tool failures, attaching a reason, elapsed time, and suggested operator action ([source](https://github.com/baphuongna/pi-crew/blob/7aa077d42839603744153347b974a036b5bb0dce/src/runtime/agent-control.ts#L59-L94), [source](https://github.com/baphuongna/pi-crew/blob/7aa077d42839603744153347b974a036b5bb0dce/src/runtime/agent-control.ts#L145-L182)).

`/orchestrate` should explicitly normalize native runtime state into:

```text
queued | running | complete | blocked | needs-decision
needs-attention | failed | cancelled
```

A `needs-attention` result should include:

- reason;
- last observed activity;
- suggested parent action;
- whether waiting, steering, cancellation, or user judgment is appropriate.

This belongs in the runtime adapter and judgment-packet contract, not in a new extension.

### 4. Visible hard limits

Pi-crew resolves concurrency from layered settings and applies a hard cap by default ([source](https://github.com/baphuongna/pi-crew/blob/7aa077d42839603744153347b974a036b5bb0dce/src/runtime/concurrency.ts#L37-L57)). Its policy layer separately checks total tasks, concurrency, child count, graph depth, retries, stale workers, and verification contracts ([source](https://github.com/baphuongna/pi-crew/blob/7aa077d42839603744153347b974a036b5bb0dce/src/runtime/policy-engine.ts#L35-L100)).

`/orchestrate` already has most of these policies implicitly. It would benefit from making them explicit in the execution shape:

- maximum launches;
- maximum simultaneous workers;
- one shared-worktree writer;
- maximum delegation depth;
- maximum repair passes;
- cost-consent boundary.

## Router implications

### Small idea worth borrowing

The router could expose one normalized route-decision record:

```text
requested tier
candidate selected
effective provider/model
thinking level
metered classification
consent basis
route reason/warnings
restoration result
```

It already exposes most of this through status and the usage ledger, so this is mainly a consistency and testability refinement rather than a new subsystem.

### Keep topology out of the router

The router should not decide:

- whether delegation pays;
- task decomposition;
- parallelism;
- writer isolation;
- child count;
- workflow selection.

Those are orchestration decisions. The router should continue translating semantic model requirements into exact local Pi models.

### Do not copy pi-crew's broad model fallback

Pi-crew retries many transient failures across candidate models ([source](https://github.com/baphuongna/pi-crew/blob/7aa077d42839603744153347b974a036b5bb0dce/src/runtime/model-fallback.ts#L184-L230)). More importantly, its candidate construction can append every available model after configured fallbacks ([source](https://github.com/baphuongna/pi-crew/blob/7aa077d42839603744153347b974a036b5bb0dce/src/runtime/model-fallback.ts#L343-L370)).

That conflicts with the local spend-safety boundary: a post-launch fallback could change provider, capability, or metering classification without renewed consent. Any future fallback must:

1. use a bounded, explicitly configured candidate list;
2. preflight every candidate's identity and metering;
3. obtain consent before launch when any possible route requires it;
4. stop rather than broaden to arbitrary available models.

Fallback execution would still belong to the runtime adapter, not the parent skill router.

## Patterns not to adopt

| Pi-crew feature | Decision |
|---|---|
| Persistent manifests, task state, and JSONL event log | Use native `pi-subagents` artifacts and status instead |
| Separate child-Pi scheduler | Duplicates runtime lifecycle ownership |
| Automatic keyword decomposition | Too easy to infer false independence |
| Dynamic executable workflows | Reject for shared orchestration |
| Automatic winner or quality scoring | Keep independent review and parent judgment |
| Broad model fallback | Conflicts with route consent and spend safety |
| Full metrics, OTLP, and dashboard layer | Disproportionate for a portable skill |

Dynamic workflows are particularly unsuitable: pi-crew explicitly says they run as trusted Node code with access to `require`, imports, and `process`, and are **not sandboxed** ([source](https://github.com/baphuongna/pi-crew/blob/7aa077d42839603744153347b974a036b5bb0dce/src/runtime/dynamic-workflow-runner.ts#L1-L17)).

## Recommended change

> **Superseded — see [Reconciliation](#decision).** Items 1–3 (orchestrate prose) are not
> being implemented per `skills-mcn`. Item 4 already describes current behaviour. Item 5
> (router route-decision evidence) survives as `ai-tools-gc2.2`; the bounded-fallback
> guardrail from [Router implications](#router-implications) is `ai-tools-gc2.1`.

Implement one small `/orchestrate` enhancement:

1. Add an advisory topology-preflight section.
2. Add a structured recommendation, confidence, reasons, and explicit limits.
3. Normalize `needs-attention` runtime handling.
4. Reuse native `pi-subagents` state and artifacts.
5. Leave the router's responsibility unchanged, aside from possibly normalizing its route-decision evidence.

Pi-crew's own architecture shows why restraint matters: it is intentionally durable-first, with manifests, task files, event logs, subprocess workers, model fallback, policy engines, and artifact stores ([source](https://github.com/baphuongna/pi-crew/blob/7aa077d42839603744153347b974a036b5bb0dce/docs/architecture.md#L1-L24), [source](https://github.com/baphuongna/pi-crew/blob/7aa077d42839603744153347b974a036b5bb0dce/docs/architecture.md#L27-L57)). That is valuable when building an orchestration platform, but excessive for a conservative parent-owned workflow.

Its quantitative comparison document is also stale: it compares pi-crew v0.2.3 ([source](https://github.com/baphuongna/pi-crew/blob/7aa077d42839603744153347b974a036b5bb0dce/docs/comparison-pi-subagents-vs-pi-crew.md#L1-L21)), while current architecture documentation says v0.9.0. Treat its performance numbers as directional rather than reusable policy evidence.
