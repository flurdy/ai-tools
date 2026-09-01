# Shared Launcher Internals

Provider-neutral context discovery and Git worktree creation used by the Claude
and Pi launchers. This directory is the canonical implementation; live dotfiles
helpers are dispatch shims selected through `AI_TOOLS_HOME`, not copied variants.

## Files

- `context-gather`: discovers the main checkout, existing worktrees, handoffs,
  branch state, and cached pull-request metadata before presenting the `fzf`
  picker. Handoffs show their `HH:MM` timestamp and are newest-first by full
  timestamp. Ctrl-P (shown as `ctrl-p=mode`) cycles the launcher's private
  initial-mode state without closing `fzf`: `restore` preserves a resumed
  session's saved mode, followed by
  explicit `plan` and `implement` (Pi) or `auto` (Claude) choices. It keeps
  agent-specific picker capabilities such as Claude's fork action behind
  `--agent`.
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

`context-gather` emits a versioned seven-field descriptor:
`type<TAB>path<TAB>branch<TAB>session<TAB>note<TAB>root<TAB>mode`. `root` is set
only for a workspace-member handoff, so Fish frontends can switch Git context
before creating or resolving a worktree. It infers the agent when invoked through
`cl-gather` or `pl-gather`. For direct use, pass it explicitly:

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
- `AI_TOOLS_HOME`: canonical checkout used by dotfiles dispatch shims. It defaults
  to `$XDG_DATA_HOME/ai-tools` (or `~/.local/share/ai-tools`); a legacy
  `~/Code/flurdy/ai-tools` checkout is recognized for migration compatibility.
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

It covers provider-specific picker keys and mode translation, the shared PR cache,
timestamped newest-first handoff ordering, copied-install agent detection, shared
configuration provisioning, branch reuse, path spaces, slug collisions, and
worktree creation failures.
