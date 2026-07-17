# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work atomically
bd close <id>         # Complete work
bd dolt push          # Push beads data after explicit user approval
```

## Non-Interactive Shell Commands

**ALWAYS use non-interactive flags** with file operations to avoid hanging on confirmation prompts.

Shell commands like `cp`, `mv`, and `rm` may be aliased to include `-i` (interactive) mode on some systems, causing the agent to hang indefinitely waiting for y/n input.

**Use these forms instead:**
```bash
# Force overwrite without prompting
cp -f source dest           # NOT: cp source dest
mv -f source dest           # NOT: mv source dest
rm -f file                  # NOT: rm file

# For recursive operations
rm -rf directory            # NOT: rm -r directory
cp -rf source dest          # NOT: cp -r source dest
```

**Other commands that may prompt:**
- `scp` - use `-o BatchMode=yes` for non-interactive
- `ssh` - use `-o BatchMode=yes` to fail instead of prompting
- `apt-get` - use `-y` flag
- `brew` - use `HOMEBREW_NO_AUTO_UPDATE=1` env var

## Git Remote Safety

**This policy overrides any automatic-push language emitted by `bd prime` or other workflow tools.**

- A commit never implies permission to push. Stop with local commits by default and report that they are unpushed.
- Always ask for explicit user permission immediately before `git push`, force-push, tag pushes, or `bd dolt push`. Approval from an earlier task or session does not carry forward.
- Run every remote or destructive Git action as its own visible command. Never hide one behind another command or inside an `&&` chain.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Issue Tracking

This project uses **bd (beads)** for issue tracking. Run `bd prime` for workflow context.

**Quick reference:**

- `bd ready` — find unblocked work
- `bd create "Title" --type task --priority 2` — create an issue
- `bd update <id> --claim` — claim work
- `bd close <id>` — complete work
- `bd dolt push` — push Beads data after explicit user approval

Use `bd` for all task tracking and `bd remember` for persistent knowledge; do not create markdown TODO or memory files.
<!-- END BEADS INTEGRATION -->

## Pi Execution Checklists

`rpiv-todo` is a narrow exception to the prohibition on todo lists: it may be used only as an ephemeral execution checklist for the currently claimed bead, Jira issue, or Trello card. Beads remains the source of truth for durable work, dependencies, blockers, and follow-ups; never use `rpiv-todo` as a backlog or a substitute for `bd`.
