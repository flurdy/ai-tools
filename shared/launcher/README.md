# Shared Launcher Internals

Provider-neutral context discovery and Git worktree creation used by the Claude
and Pi launchers.

## Files

- `context-gather`: discovers the main checkout, existing worktrees, handoffs,
  branch state, and cached pull-request metadata before presenting the `fzf`
  picker. Handoffs show their `HH:MM` timestamp and are newest-first by full
  timestamp. It keeps agent-specific picker capabilities such as Claude's fork
  action behind `--agent`.
- `mkworktree`: creates or reuses a worktree and carries local project setup
  into it. It copies existing Claude and Pi project settings because a worktree
  can be opened by either agent.

The agent directories expose relative symlinks with their established names:

```text
claude/launcher/cl-gather      -> shared/launcher/context-gather
claude/launcher/cl-mkworktree  -> shared/launcher/mkworktree
pi/launcher/pl-gather          -> shared/launcher/context-gather
pi/launcher/pl-mkworktree      -> shared/launcher/mkworktree
```

`context-gather` infers the agent when invoked through `cl-gather` or
`pl-gather`. For direct use, pass it explicitly:

```bash
shared/launcher/context-gather --agent=claude --list
shared/launcher/context-gather --agent=pi
```

The `cl` and `pl` Fish functions remain separate. They translate the selected
context into each agent's own model, session, resume, fork, and prompt flags.

## Runtime Requirements

- Bash 4+ (the context picker uses associative arrays)
- Git and `fzf`
- `gh` is optional and adds cached pull-request metadata

Both GNU/Linux and BSD/macOS `stat` forms are supported for cache timestamps.

## Configuration

- `AI_WORKTREE_PARENT`: fallback parent for newly created worktrees. When it is
  unset, the helper uses an existing `*/worktrees/*` layout when one is found,
  otherwise `../worktrees` relative to the main checkout.
- `AI_HANDOFF_LIST`: optional path to the handoff listing script. The default is
  `~/.claude/skills/handoffs/scripts/list.sh`.
- `XDG_CACHE_HOME`: PR metadata is shared by both launchers under
  `$XDG_CACHE_HOME/ai-launcher` (or `~/.cache/ai-launcher`).

The worktree helper copies these files when they exist in the main checkout and
not in the new worktree:

- `.claude/settings.local.json`
- `.pi/settings.json`
- `.pi/settings.local.json`

It also links root and top-level package `node_modules` directories, matching the
previous per-agent helpers.

## Test

Run the offline integration suite from the repository root or any directory:

```bash
shared/launcher/test.sh
```

It covers provider-specific picker keys, the shared PR cache, timestamped
newest-first handoff ordering, copied-install agent detection, shared
configuration provisioning, branch reuse, path spaces, slug collisions, and
worktree creation failures.
