# Goal baseline fixture

Preparation only: a synthetic CSV quote-escaping defect and frozen expected
outputs. This is not a Pi runner, sandbox, budget limiter or completed trial.
No packages or model calls are needed for `make check-goal-baseline` from the
repository root. The self-checks load only trusted committed code, assert the
specimen's three expected failures and verify a known-good reference.

## Future trial boundary

- Stage only `TASK.md` and `fixture/csv.mjs` (renamed to `src/csv.mjs`) into a
  fresh, separately authorized isolated workspace. Do not mount this repository,
  `oracle/`, `tests/goal-baseline.test.mjs`, home directories or host agent config.
- Keep `oracle/cases.json` and its digest outside worker writes. The trusted
  reference in the repository self-test is not worker input. Freeze all source,
  task and oracle hashes before a trial; use identical snapshots for comparisons.
- Trial candidate code is untrusted. Do not import it into the host self-test or
  host verifier. Execute candidates only within approved whole-process isolation;
  validate observations outside that process against the pristine oracle. A
  candidate can forge reports or alter an in-process checker. These self-checks
  are not an adversarial grading or containment system.
- Require reviewed image identity, minimal filesystem/credential/network access,
  explicit model and billing approval, verified external request/token/spend
  admission, process-tree deadline/cancellation and separate launch approval.
  Worktrees, model instructions and Pi usage counters do not establish those gates.

This package intentionally has no launch command, container recipe or candidate
loader. Machine-specific readiness, budgets and trial results belong in the
owning Bead; disposable receipts belong under ignored `.artifacts/`. A successful
fixture check proves the fixture, not model effectiveness or readiness to run.
