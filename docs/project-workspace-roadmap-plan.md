# Architect Plan: Project-workspace v1 pilot readiness

## Planning tier

- **Tier:** all-in
- **Why:** The workspace contract spans filesystem safety, Git/Beads ownership, generated state, and an optional external mgit integration. More lifecycle commands should wait for adversarial implementation review and real-use evidence.
- **Validation status:** Updated after three focused in-harness reviews, one substantive local Anthropic review, and an OpenRouter quorum run across four configured vendors.

## Goal

Turn `shared/project-workspace` from a strong local prototype into a trustworthy v1 pilot without expanding it into a general repository orchestrator.

The v1 outcome should:

1. Preserve independent repository ownership while giving cross-project context and work a clear root.
2. Keep every supported state transition internally consistent.
3. State its supported platform, installation, and portability boundaries honestly.
4. Generate evidence from real use before selecting additional lifecycle features.

## Context gathered

- The implementation was delivered in three commits: scaffold (`027bec7`), safe registration (`3514b55`), and optional mgit setup (`4b50a74`).
- Closed Beads are `ai-tools-t7r`, `ai-tools-v16`, and `ai-tools-1b9`; `bd list` and targeted searches found no open workspace roadmap item.
- The current surface is `init`, `add-repo`, `add-infrastructure`, `configure-mgit`, and `doctor`.
- The subsystem contains a 1,036-line Python CLI and a 947-line end-to-end test module. All 29 focused tests pass.
- The documented boundary deliberately excludes refresh, removal, and broad lifecycle management until real use demonstrates demand.
- The repository has no CI workflow or package metadata for this subsystem. Installation is a documented symlink to the checked-out executable.

## Assumptions

- Initial users are trusted developers on modern Unix-like systems with Python 3.10+, Git, Beads, Bash, Make, and symlink support.
- The workspace is a coordination root, not a monorepo substitute or deployment orchestrator.
- Manifest v1 describes local topology; it is not yet a complete portable reconstruction specification.
- Tracker and repository mutations remain explicit. No future command should clone, push, or change agent permission policy implicitly.
- Concurrent hostile mutation is outside the v1 pilot threat model. If multiple writers become realistic, locking and directory-fd/no-follow hardening require a separate design.

## Repository-grounded review findings

### Strengths

- Cross-project documentation and Beads tracking have a clear home while implementation repositories retain independent history and local instructions.
- Registration is explicit, non-destructive, and heavily validated.
- Relative links, traversal checks, duplicate-target rejection, Git-root checks, README ownership markers, dry-run, reruns, atomic replacement, and rollback provide an unusually strong safety baseline.
- Optional mgit setup is separate from initialization and does not mutate agent permissions.

### Integrity work required before the pilot

1. **Name-only init can create a nested Git repository inside an existing work tree.** Preflight checks only `<workspace>/.git`. With an output directory inside another repository and no `--repo`, it can initialize a nested repository. This is more reachable than the original review’s planted-manifest provenance scenario and should replace it as the primary Git-containment defect.
2. **Post-mgit repository registration leaves the configured workspace unhealthy.** Registration updates the manifest but not `.mgit.conf`; `doctor` fails, while `configure-mgit` refuses the stale generated configuration. `add-infrastructure` is unaffected because mgit derives only repository paths.
3. **Init and doctor disagree on absolute repository links.** Init rerun checks only the resolved target; doctor requires a relative link. Generated links are relative, so this is a hand-edited-state repair/diagnostic inconsistency rather than a normal-path blocker.
4. **Doctor checks Beads presence, not health, and mgit verification discards captured stderr from the user-facing error.** A stable, bounded, non-mutating Beads probe must be selected before implementing this check.
5. **Additive manifest compatibility is useful but untested.** Validation ignores unknown keys and registration deep-copies the manifest, so future optional fields should already survive round trips. Freeze that behavior with a regression test before the pilot.

### Product decisions to make through the pilot

- A cloned or relocated workspace cannot repair broken links because validation requires them to resolve and the manifest stores no source identity. Do not add source remotes or `relink` until second-path/machine use proves the requirement.
- `primary` is currently display-only; mgit consumes all registered repository paths. Multiple primaries are reachable only through manual manifest editing. Decide during the pilot whether role has durable semantics, should become explicit input, or should be removed in a future migration.
- Workspace-level versus repository-level Beads ownership remains guidance rather than an enforceable boundary. Improve examples before considering synchronization.
- The executable resolves templates relative to its real path. Symlink installation works; copying the executable without its templates does not. Document this as an installation constraint.

## Recommended approach

### Now: protect the existing contract

1. Reject workspace roots nested inside any existing Git work tree while preserving interrupted-init recovery. Keep the rarer matching-manifest provenance case in the same threat analysis, but do not make it the sole acceptance scenario.
2. Make repository registration and managed mgit state one safe transition. A supported command sequence must never return success and leave `doctor` failing. Prefer transactional regeneration when the existing `.mgit.conf` exactly matches the pre-registration manifest; otherwise refuse before writes.
3. Align relative-link invariants, expose mgit stderr, select a Beads health probe, lock in unknown-key preservation, and document Python 3.10+/Unix/symlink-only installation expectations.

The pilot probe is `bd list --limit 1 --no-pager --readonly` with a five-second subprocess timeout. It is bounded, non-mutating, exercises store access, and lets doctor distinguish a missing executable from an unusable store.

### Next: pilot before adding command families

4. Dogfood v1 in representative greenfield, existing multi-repository, infrastructure, and optional-mgit workspaces.
5. Clone or relocate one workspace to another path or machine and record whether a `relink`/repair contract is actually required.
6. Record recurring friction in installation, topology churn, role semantics, tracker ownership, upgrades, and diagnosis. Do not treat isolated preferences as roadmap evidence.

### Pilot outcome — 2026-07-25

The [v1 pilot report](project-workspace-v1-pilot-report.md) covers greenfield, multi-repository, infrastructure, optional-mgit, topology-change, whole-layout relocation, and workspace-only clone/recovery paths.

- Keep manifest v1 as a local relative-topology contract and add no lifecycle command from one synthetic second-path reconstruction.
- Keep `primary` display-only and keep tracker replication under Beads rather than `project-workspace`.
- Resolve the repeatedly observed mixed skill-root discovery failure separately in `ai-tools-o48.5`; a non-empty explicit `SKILLS_DIR` remains authoritative.
- Reconsider source identity or a dry-run-first repair command only after real second-machine or repeated independent relocation evidence.

### After evidence: select one lifecycle outcome

- If portability fails repeatedly, add an explicit dry-run-first `relink`/repair command and decide whether optional source identity belongs in manifest v1 or requires a later schema version.
- If topology churn is the repeated problem, implement one transactional `remove` or `rename` operation with manifest, README, link, and mgit consistency.
- If onboarding is repeatedly manual, add read-only discovery output; require explicit registration for writes.
- Add schema migration machinery only when the first incompatible schema change is concrete.

### Avoid or defer

- Automatic clone, sync, refresh, push, or remote repository management.
- Generic plugin architecture or provider-specific metadata in the core manifest.
- Automatic agent-permission changes or implicit mgit setup.
- Package-manager channels, self-update, multi-version CI matrices, `--version`, or install automation before a second consumer or pilot evidence justifies release infrastructure.
- Repository-relocating conversion; existing `ai-tools-aqd` is deferred pending pilot evidence because it broadens lifecycle management before the core contract is proven.
- File locking until a credible multi-writer use case changes the trusted single-user threat model.
- A size-only rewrite of the CLI or tests. Split by feature boundary when the next proven change makes that separation pay for itself.

## Implementation slices

| # | Slice / deliverable | Observable outcome | Acceptance evidence |
|---|---|---|---|
| 1 | Git-work-tree containment | Name-only `init` cannot scaffold or run `git init` beneath an existing Git work tree, while interrupted initialization at a legitimate workspace root remains recoverable. | Real-Git tests for an existing-repository subdirectory, planted matching manifest, and interrupted-init recovery; `make -C shared/project-workspace test` passes. |
| 2 | Repository/mgit state consistency | `configure-mgit → add-repo → doctor` succeeds as one consistent supported flow, or registration refuses before any write when managed config is unsafe to regenerate. | Cross-feature tests covering success, conflicts, rollback, and exact rerun; root and newly registered service mgit status both pass. |
| 3 | Contract hardening and diagnostics | Init and doctor enforce the same relative-link rule; doctor reports actionable mgit failure output and a bounded Beads health result; unknown manifest keys survive registration. | Focused happy/sad tests, one real-tool smoke path, and generated documentation stating the supported platform/install contract. |
| 4 | Pilot and portability decision | Real use produces a written decision on role semantics, tracker ownership, relink/source identity, one lifecycle command, or no new feature. | [`project-workspace-v1-pilot-report.md`](project-workspace-v1-pilot-report.md) records representative flows, second-path recovery, the no-lifecycle decision, and focused follow-up `ai-tools-o48.5`. |

## Tracking recommendation

**Epic proposal — not created:** `Project-workspace v1 pilot readiness` (P2 feature)

Suggested independently reviewable children:

1. **Proposal — not created:** `Prevent project-workspace init inside existing Git work trees` (P2 bug).
   - Acceptance: real-Git containment and interrupted-init recovery tests; no writes on rejection.
2. **Proposal — not created:** `Keep mgit configuration consistent during repository registration` (P2 bug).
   - Acceptance: no successful topology mutation leaves doctor failing; transactional update/refusal and rollback are tested.
3. **Proposal — not created:** `Harden project-workspace invariants and diagnostics` (P2 task).
   - Scope: relative-link consistency, mgit stderr, bounded Beads probe, unknown-key preservation, and supported-platform/install documentation.
4. **Proposal — not created:** `Dogfood project-workspace v1 and decide portability requirements` (P2 task; depends on children 1 and 2).
   - Acceptance: representative pilot notes and a source-backed decision on role semantics and the next lifecycle outcome.

**Deferred proposal — do not create yet:** `Automate project-workspace distribution and compatibility testing` (P4 task). Trigger only after a second consumer or pilot evidence justifies versioning, install automation, or a CI matrix.

Do not create `relink`, `remove`, `rename`, discovery, or schema-migration beads until the pilot supplies the stated evidence.

## Test strategy

- **Happy path:** Greenfield init, repository-backed init, multiple registrations, infrastructure, optional mgit, exact reruns, and doctor.
- **Sad path:** Output nested in an existing Git work tree, stale/foreign mgit configuration, broken/absolute links, unusable Beads state, missing installed tools, and verification rollback.
- **Edge cases:** Interrupted initialization, partial registration states, relocation, noncanonical manifest formatting, unknown manifest keys, generated README migration, and the documented single-writer threat boundary.
- **State-transition matrix:** Exercise init/register/configure/doctor in meaningful orders, especially configure → register → doctor and interrupted init → rerun.
- **Real-tool coverage:** Keep fast stubs, but use real Git for containment and a bounded release smoke with real Beads.

## Risks and mitigations

- **Scope creep into repository orchestration** → Keep lifecycle additions conditional on repeated pilot evidence and preserve explicit writes.
- **False portability claims** → Publish the supported platform/install contract and test clone/relocation before adding reconstruction metadata.
- **Workspace/repository tracker duplication** → Add concise ownership examples; do not build tracker synchronization without demonstrated need.
- **Cross-feature state drift** → Treat commands as topology state transitions and add transition tests before adding commands.
- **Compatibility burden** → Freeze representative v1 fixtures and unknown-key preservation; introduce migrations only for actual incompatible changes.
- **Third-party execution in doctor** → Document that configured mgit doctor invokes the installed wrapper and keep the integration explicit.

## Rollout and rollback

1. Land the two integrity fixes before recommending broader use.
2. Pilot through the existing checkout-and-symlink installation model.
3. Keep generated workspaces on manifest version 1 during the pilot.
4. Roll back by removing the command symlink; existing workspace repositories remain untouched and independently usable.
5. Do not publish package-manager releases until the pilot demonstrates an audience and support commitment.

## Open questions

- Does `primary` have operational meaning, or should role be removed or made explicit?

## External validation

### Coverage

- **Focused in-harness reviews:** 3/3 succeeded on `gpt-5.6-sol`; useful corroboration but not vendor-independent.
- **Local `local-legacy` consensus panel, 10-minute timeout:** Anthropic Claude succeeded; OpenAI Codex failed in its read-only environment; Google Gemini failed with a local JavaScript syntax error. Quorum was 1/2, so no local consensus assessment was made.
- **OpenRouter `extreme` quorum panel, 10-minute timeout:** Qwen, xAI, and Moonshot routes returned; DeepSeek failed. Mechanical quorum was 3/2 providers. OpenRouter quorum establishes coverage, not correctness or claim-level consensus.

### Evidence-backed agreements

- Keep the product narrow and pilot before adding lifecycle commands.
- Post-mgit repository registration is a real cross-command defect.
- Real-Git containment tests and broader state-transition tests are needed.
- Platform and symlink-install assumptions should be explicit.
- CI/version/install automation should be narrowed or deferred until adoption evidence exists.

### Disagreements and resolution

- **Merge the two integrity bugs or keep separate:** Qwen recommended merging; local Claude recommended separate outcomes. Keep them separate because they touch independent init-provenance and registration/mgit transitions and can be reviewed atomically.
- **Role validation now or later:** Qwen favored immediate enforcement; local Claude found role display-only and unreachable through normal CLI misuse. Defer the semantic decision to the pilot, while preserving current generated behavior.
- **CI/version/install automation now:** The initial draft proposed it; local Claude and Qwen both identified YAGNI risk. Defer automation and keep only supported-platform and symlink-only installation documentation now.
- **Foreign Git defect framing:** Earlier reviews emphasized planted matching manifests. Local Claude identified the more reachable name-only init beneath an existing Git work tree. The plan was rescaled around containment while retaining provenance as an edge case.

### Rejected or unusable findings

- Qwen cited nonexistent files such as `cli.py`/`workspace.py` and suggested adding a manifest version that already exists. Those claims were rejected.
- The xAI response described different filenames, flags, CI, and Beads that do not exist in the checked repository state. Its repository-specific claims were rejected as ungrounded; only conclusions independently verified in current files were retained.
- Moonshot returned only a review preamble and supplied no actionable findings.
- DeepSeek returned an OpenRouter request error.
- Kill-9 testing and file locking were not added to the immediate plan; exception recovery is already covered, while power-loss/concurrent-writer durability exceeds the stated trusted single-user pilot threat model.

### Plan changes

1. Replaced the broad foreign-repository finding with the more reachable nested-Git-work-tree containment defect.
2. Kept the two integrity bugs separate and narrowed mgit scope to repository registration.
3. Replaced the broad adoption/CI slice with a smaller contract-hardening slice.
4. Moved role semantics, relink/source identity, and lifecycle commands behind pilot evidence.
5. Added unknown-manifest-key preservation and explicit cross-command state-transition coverage.
6. Reduced the epic from five active children to four, with distribution automation explicitly deferred.

### Residual uncertainty

- Real second-machine behavior remains untested; the pilot decision keeps v1 local-layout until that evidence exists.

## Recommended implementation tier

Use a strong standard coding model for the two focused integrity defects and premium review for state-transition safety. Retain premium planning for any schema or portability change.
