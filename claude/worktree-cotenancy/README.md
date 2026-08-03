# Claude Worktree Co-tenancy Guard

Makes it visible when more than one live Claude Code session is working in the same
linked git worktree.

## Why

Claude Code's exit dialog offers "Remove worktree". Choosing it runs
`git worktree unlock`, then `git worktree remove --force`, then deletes the branch.
The dialog only knows about the session doing the exiting, so when two sessions share
a worktree, exiting one deletes the other's working directory and discards its
commits. Observed on 2026-07-30 with Claude Code 2.1.220: an exiting session reported
`Worktree removed. 3 commits on worktree-expressive-puzzling-map were discarded.`
while another session was still working in that directory.

Nothing outside Claude Code can stop the removal:

- `/exit` is not a tool, so `PreToolUse` never sees it.
- `SessionEnd` runs too late and cannot veto.
- `git worktree lock` does stop `git worktree remove` and even `--force` (only
  `-f -f` overrides it), but Claude Code unlocks the worktree itself first.
- Claude Code's own "changed files would be lost" abort is deliberately skipped when
  the removal comes from `exit_tool`, `exit_dialog` or `job_delete_force`.

So this guard reports rather than blocks: it warns the session at start, tells the
model never to remove the worktree, and feeds a count to the statusline so the shared
state is on screen at the moment someone reaches for `/exit`.

## Files

- `worktree-cotenancy.sh`: hook and query command.
- `settings.worktree-cotenancy.fragment.json`: hook registration and permissions.

## Install

```bash
make install
```

This symlinks the hook into `~/.claude/hooks/`, so the installed hook cannot drift
from source. Override the destination with `make install CLAUDE_DIR=/somewhere/else`.
Then merge `settings.worktree-cotenancy.fragment.json` into your Claude settings.

## Modes

| Mode | Used by | Behaviour |
|---|---|---|
| `register` | `SessionStart` hook | Records a lease, warns when the worktree already has another live session |
| `release` | `SessionEnd` hook | Drops this session's lease |
| `count [dir]` | statusline, scripts | Prints how many live sessions hold the worktree containing `dir` |
| `list [dir]` | debugging | Prints `session pid started` per live lease |

Only linked worktrees take leases. The main checkout is never at risk from the exit
dialog, so `count` there is always `0`.

## Leases

A lease is one file per session under
`${CLAUDE_WORKTREE_LEASE_DIR:-~/.claude/worktree-leases}/<key>/<session-id>`, where
`<key>` derives from the worktree path. It records the owning process, that process's
kernel start time, and the worktree path.

- Liveness is the recorded pid plus its start time, so a recycled pid never reads as
  the original session. Dead leases are collected on the next read; a crashed session
  leaves nothing behind to clean up by hand.
- Leases are counted per process, not per session. Resuming, compacting and
  in-process children all report the same owning process and count once — the hazard
  is a *second* Claude process, because each one runs its own exit dialog.
- A lease naming a different worktree is ignored, so a key collision between two
  paths cannot inflate the count.
- Background and daemon sessions never reach the exit dialog and take no lease.

## Runtime assumptions

- Requires `bash` and Git 2.31+ (for `rev-parse --path-format`). `jq` is used when
  present and a text fallback parses the hook payload when it is not.
- Process start times come from `/proc`. Elsewhere liveness degrades to a plain pid
  check, which cannot detect pid reuse.
- Disable the statusline cell with `CLAUDE_STATUSLINE_COTENANCY=0`.

## Limits

This is a warning, not a lock. It cannot stop a removal, and it says nothing about a
session that a person drives from a plain terminal in the same directory. A nested
`claude` process started inside the worktree counts as a co-tenant, which is accurate
even when that process would never show an exit dialog.
