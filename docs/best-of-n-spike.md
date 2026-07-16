# Best-of-N implementation comparison spike

- **Date:** 2026-07-16
- **Bead:** `ai-tools-dw1`
- **Dogfood base:** `7793bc2216a471cadf945c915e8cfb5445032d90`
- **Pi:** 0.80.6
- **pi-subagents:** 0.34.0

## Decision

Do **not** add a new Pi extension to `ai-tools`, and do not add a deterministic
comparison/scoring module.

Best-of-N implementation comparison should be an explicit, high-cost execution shape
owned by the shared `/orchestrate` workflow. Runtime adapters should implement that
shape with native isolation and child execution. On Pi, `pi-subagents` already owns the
required mechanics: parallel tasks, per-task model overrides, isolated worktrees,
patch capture, child artifacts, lifecycle status, and cleanup.

The existing agent-skills roadmap already has the appropriate owners:

- `skills-rd6.2`, **Add adaptive delegation strategy**, owns when isolated parallel
  implementations are worth their coordination and cost.
- `skills-rd6.4`, **Add evidence ledger and conflict synthesis**, owns candidate evidence,
  comparison, conflict handling, and honest unresolved outcomes.

A separate `/best-of-n` command or skill would split the intended single orchestration
entry point. A local extension would mostly proxy `pi-subagents` and duplicate its
lifecycle. Reconsider Pi-specific code only if repeated use exposes a runtime gap that
cannot be handled by the shared workflow or upstream `pi-subagents`.

## Dogfood setup

After explicit approval for a bounded panel whose child billing classification was
unknown, the parent launched two fresh `worker` children with the **same task and model**:

- same base commit and judgment packet;
- separate `pi-subagents` worktrees;
- `openai-codex/gpt-5.6-sol`, thinking `high`;
- three owned throwaway prototype files;
- Node 18-only validation contract;
- no automatic patch application.

Both workers implemented a small candidate-report comparator. The exercise was chosen
to test isolation, artifact collection, objective validation, and qualitative comparison;
the prototypes were never intended as product architecture.

### Results

| Candidate | Result | Independent validation | Observed usage |
|---|---|---|---|
| 1 | Complete; 8 worker tests | Patch applied cleanly to a fresh detached worktree; 8/8 tests and `git diff --check` passed | 15,547 input; 43,520 cache-read; 6,295 output; 8 turns |
| 2 | Complete; 9 worker tests | Patch applied cleanly to a fresh detached worktree; 9/9 tests and `git diff --check` passed | 11,700 input; 33,792 cache-read; 6,262 output; 6 turns |
| Fresh reviewer | Candidate 2 conditionally; apply neither as-is | Inspected both patches, reports, metadata, and parent validation | 22,709 input; 50,688 cache-read; 5,087 output; 5 turns |

The parallel worker stage took about 2m22s; the subsequent reviewer took about 2m09s.
Across all three children, runtime metadata reported 49,956 input tokens, 128,000
cache-read tokens, and 17,644 output tokens. The runtime-reported cost field totalled
`0.843100`; this is observed runtime metadata, **not** a claim about subscription quota or
actual marginal billing.

Both post-launch worker metadata records matched the preflight model identity. Temporary
worktrees and branches were removed, full patches remained in the run artifacts, and
the original checkout stayed clean.

## Candidate comparison findings

Both implementations passed the submission and validation gates, but both showed why a
hard-coded scorer is the wrong abstraction:

- Candidate 1 required producer-assigned correctness, validation, and maintainability
  scores, then counted self-reported residual risks. A producer could improve its result
  by inflating scores or omitting risks.
- Candidate 2 used only the requested evidence and had stronger schema checks, but
  selected the sole candidate reporting zero residual risks. That also rewards omission.
- The reviewer preferred Candidate 2 as a simpler foundation, conditional on removing
  that winner rule and requiring at least two candidates. No patch was applied because
  the durable solution should not be this local comparator.

The important comparison is therefore not an arithmetic score. Hard gates can be
mechanical; choosing between eligible implementations remains independent review and
parent judgment. When evidence trades off or is insufficient, the correct result is
**no winner**.

## Recommended workflow

Use this shape only when the expected information value exceeds the extra execution and
review cost:

1. **Fix the experiment.** Record one base commit, one self-contained judgment packet,
   explicit non-goals, and one validation contract. Keep the candidate prompt identical
   except for disclosed model/effort choices.
2. **Preflight routes and cost.** Resolve effective child identity and trusted
   `metered: true|false` classification before launch. Metered, inherited, or unknown
   routes require approval for the bounded panel. Same-model and different-model panels
   use the same gate.
3. **Launch two candidates by default.** Use isolated worktrees and cap ordinary fanout
   at two; add a third only when its information value is stated. Never use a shared
   worktree for competing writers.
4. **Confirm launch evidence.** Record effective model/effort and stop further fanout on
   an identity mismatch.
5. **Capture artifacts.** Preserve each patch and worker report before worktree cleanup.
6. **Validate independently.** Apply-check every patch against the fixed base, then run
   the same required commands in disposable worktrees. Worker claims alone are not
   comparison evidence.
7. **Review eligible candidates.** Give a fresh read-only reviewer the patches, fixed
   requirements, validation evidence, and rubric. Diff size, token use, and amount of
   prose are informational, not quality scores.
8. **Return a decision.** Report a conditional winner only when it materially dominates
   on requirements, correctness risk, validation, and maintainability. Otherwise report
   no winner and the unresolved tradeoff.
9. **Apply only after an explicit choice.** The parent rechecks the selected patch and
   asks before applying it. Never auto-merge the winning worktree or patch.

A staged parent-controlled flow is safer than one opaque chain when child route identity
must be confirmed between fanout and review.

## Artifact contract

Each candidate needs enough evidence to reproduce and audit the comparison:

- candidate identifier;
- base commit and stable digest of the task/acceptance packet;
- requested and effective model/effort;
- trusted metered classification and current-run consent state;
- completion state (`complete`, `blocked`, or `needs-decision`);
- patch path and hash, changed files, and diff summary;
- validation commands, exit codes, and concise output;
- worker assumptions and residual risks;
- observed usage fields when available, clearly separated from billing estimates;
- independent findings and final parent disposition.

## Comparison rubric

### Hard gates

A candidate is ineligible when any of these fail:

- same approved base and task packet;
- approved effective child route;
- bounded ownership and no prohibited scope expansion;
- complete patch artifact that applies cleanly;
- required validation passes;
- no unresolved blocking review finding.

### Qualitative comparison

For eligible candidates, inspect:

1. requirements and edge-case coverage;
2. correctness and regression risk;
3. test and validation quality;
4. simplicity and consistency with repository patterns;
5. maintainability and compatibility;
6. security or operational risks relevant to the task;
7. unresolved assumptions and residual risks.

Do not reward a candidate merely for fewer changed lines, fewer tokens, lower reported
cost, more tests, or fewer self-reported risks. These can explain a decision but cannot
make it.

## Failure and stop behaviour

- Dirty base: do not launch isolated writers.
- Candidate failure or timeout: preserve available artifacts and continue comparison
  only if at least one valid candidate remains; otherwise report no winner.
- Route mismatch: stop later fanout until the user approves the new disclosure.
- Patch capture or apply-check failure: candidate is ineligible.
- Validation disagreement: parent evidence wins over worker attestation.
- Reviewer finds an unapproved product or architecture choice: return to the parent/user.
- Tie or incomparable tradeoff: report no winner; do not add more candidates
  automatically.

## Ownership boundary

| Concern | Owner |
|---|---|
| User-facing execution policy, ROI gate, comparison rubric, and final authority | shared `/orchestrate` skill |
| Pi child launch, worktrees, artifacts, status, and cleanup | `pi-subagents` |
| Exact local model selection and parent skill routing | Pi/runtime configuration and `model-tier-router` |
| Trusted child identity/metering consent | shared child-routing policy plus runtime evidence |
| Potential structured patch/result API gap | upstream `pi-subagents`, only if repeated use justifies it |
| New `ai-tools` Pi extension | **No-go for now** |

## Acceptance conclusion

The dogfood demonstrated same-task execution from one base with isolated candidates,
per-child model evidence, preserved patches, independent validation, read-only review,
and safe cleanup. It also demonstrated meaningful variation between two runs of the
same model. Existing Pi primitives are sufficient; the missing value is portable
orchestration policy and evidence synthesis, already tracked by `skills-rd6.2` and
`skills-rd6.4`.
