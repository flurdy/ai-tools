# Project-workspace v1 pilot report

**Date:** 2026-07-25  
**Bead:** `ai-tools-o48.3`  
**Decision:** Keep v1 as a local-layout workspace and add no lifecycle command. Fix mixed agent-skill discovery separately in `ai-tools-o48.5`.

## Pilot environment

- Fedora Linux, Python 3.14.6, Git 2.54.0, Beads 1.1.0, GNU Make 4.4.1.
- `project-workspace` was installed through a temporary executable symlink to `shared/project-workspace/project-workspace`.
- The installed `setup-multirepo-git` skill was supplied through `SKILLS_DIR=~/.agents/skills`.
- All repositories and tracker data were disposable local fixtures. No remote Git or Dolt push was performed.

## Scenarios and evidence

| Scenario | Exercise | Result |
|---|---|---|
| Greenfield | `init`, `doctor`, exact `init` rerun, generated `make doctor` | Passed. Doctor reported `Workspace: PASS`, `Beads: PASS`, and `Mgit: UNCONFIGURED`; rerun preserved state. |
| Existing multi-repository | Repository-backed `init`, second repository registration, infrastructure registration | Passed. Relative links, manifest entries, and generated README sections stayed consistent. |
| Optional mgit | Dry-run and apply, doctor, then a third repository registration | Passed. Registration regenerated `.mgit.conf`; root and all three repository status commands succeeded; doctor reported `Mgit: PASS`. |
| Tracker ownership | Created `workspace-41o` in the workspace Beads store and queried it from the workspace root | Passed. Cross-project work remained in the workspace tracker while implementation repositories stayed independent. |
| Whole-topology relocation | Moved the workspace, three sibling repositories, and infrastructure directory together | Passed without edits. Relative repository and infrastructure links, Beads, mgit, and doctor remained healthy. |
| Workspace-only clone | Cloned only the committed workspace Git repository to a deeper second path | Failed safely at `repos/api`: the manifest has local paths but no source identity and the linked sources were absent. |
| Reconstructed source layout | Cloned all three sources and copied infrastructure to the relative paths preserved by the links | Repository validation recovered without manifest edits. Doctor then exposed the next missing dependency: the embedded Beads database was not in Git. |
| Tracker-store recovery | Copied the original disposable `embeddeddolt` store into the cloned workspace | Recovered `workspace-41o`; doctor advanced to the remaining mgit failure. A real cross-machine workflow must instead configure and use a supported Dolt remote or backup. |
| Relocated mgit installation link | Reused the committed relative `scripts/mgit` link at a different path depth | Failed safely with `existing mgit script conflicts`. Removing the disposable generated mgit pair and rerunning `configure-mgit` recovered it. |
| Mixed skill roots | Ran doctor with `~/.codex/skills` present but the complete skill available through `~/.claude/skills`/`~/.agents/skills` | Failed without `SKILLS_DIR` and passed with it. `installed_mgit_source` stops at the first existing root instead of the first complete installation. |

The decisive checks used the public CLI rather than internal functions:

```bash
project-workspace doctor --workspace PATH
project-workspace configure-mgit --workspace PATH --dry-run
project-workspace configure-mgit --workspace PATH
project-workspace add-repo SOURCE --workspace PATH
make -C PATH doctor
./scripts/mgit status repos/SERVICE --short
bd list --limit 1 --no-pager --readonly
```

## Friction record

| Area | Observation | Frequency / consequence |
|---|---|---|
| Installation | The executable symlink worked. Optional mgit discovery failed in the mixed Pi/Claude/Codex skill layout unless `SKILLS_DIR` was explicit. | Reproduced in both `doctor` and `configure-mgit`; blocks optional mgit use. |
| Topology churn | Adding a repository after mgit configuration was transactional and healthy. Moving the complete sibling topology also worked. | No normal-path friction in the exercised changes. |
| Role semantics | The first repository remained `primary`; all later repositories were `service`; mgit treated every repository path alike. | No operational effect or repeated user need; keep display-only semantics for the pilot. |
| Tracker ownership | A workspace issue was naturally separate from source repositories. A Git clone did not carry the embedded Dolt store. | Ownership was clear; cross-machine tracker replication remains an explicit Beads responsibility. |
| Upgrades | The executable symlink resolves the current checkout and requires no copied runtime. No manifest/schema upgrade was exercised. | No evidence for versioning, migrations, package distribution, or self-update. |
| Diagnosis | Doctor stopped at each invalid boundary in order: broken source link, unusable Beads store, then conflicting mgit link. | Actionable in every exercised failure; no new diagnostic command is justified. |

## Decision

### No new workspace lifecycle command

Do not add `relink`, `remove`, `rename`, source discovery, or source identity to manifest v1 from this pilot.

The evidence distinguishes two contracts:

1. A workspace is portable when its expected relative source topology and tracker state move with it.
2. A workspace Git clone alone is intentionally incomplete: repository checkouts, infrastructure, Beads replication, and the local mgit installation are independently owned dependencies.

One synthetic second-path reconstruction is not repeated user evidence for a core repair command or schema expansion. The safe v1 position is therefore to document the local-layout boundary and gather a real second-machine onboarding result before reconsidering source identity or `relink`.

### One focused installation follow-up

`ai-tools-o48.5` tracks complete-skill discovery across supported agent roots. This is narrower than a lifecycle feature, was reproduced by two commands, and directly affects the current Pi/Claude/Codex installation model. Explicit `SKILLS_DIR` must remain authoritative.

### Other decisions

- Keep `primary` display-only during the pilot.
- Keep workspace and repository trackers independent; do not add tracker synchronization to `project-workspace`.
- Keep symlink-only CLI installation and defer package/version automation.
- Require a supported Beads Dolt remote or backup for actual cross-machine tracker recovery; the pilot did not configure or push one.

## Revisit triggers

Reconsider source identity or a dry-run-first repair command only after a real second-machine onboarding or another independent workspace repeatedly requires manual link reconstruction. Reconsider one topology lifecycle command only after repeated remove/rename friction. Reconsider role semantics only when a consumer needs behavior that differs between primary and service repositories.
