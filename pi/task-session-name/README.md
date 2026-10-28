# Pi task session names for Orca

Names an unnamed Pi session in an Orca pane after the task it claimed, so Orca's agent sidebar row
and terminal tab describe current work instead of the last prompt or a generic `Pi ready`.

```text
Pi - ai-tools-8hy - agents
Pi - agents-go1 · watch-release - agents
```

The extension only calls Pi's `setSessionName()`. It writes no terminal titles: Orca's managed
`orca-titlebar-spinner.ts` remains the single title writer and already shows the session name with
its spinner, needs-input and idle markers. The [Kitty tab title](../kitty-tab-title/) extension keeps
its Orca guard and is unchanged.

## Signals

| Signal | Name part |
| --- | --- |
| Successful bash `next-select start <selector>`; a numeric selector uses `--expect-id` | Claimed task ID |
| Successful bash `bd update <one-id> --claim`, `--status in_progress` or `-s in_progress` | Claimed task ID |
| Prompt starting with `/watch-release` or `/watch-prs` (also `/skill:` or `$` prefixed) | Watcher role |

A later claim replaces the task; the role persists. Task IDs must match a strict Beads-style ID of at
most 64 characters, and roles come from the fixed list above, so prompt text, tool output, file
contents and arbitrary arguments never reach the name. This is a command-shape heuristic, not a
tracker lookup: an executable named `bd` or `next-select` with a successful tool result supplies the
signal. Failed commands, other tools, multi-ID updates, unsupported flags and flags before an update
ID are ignored. Only a standalone literal command is accepted; chains, pipelines, redirections,
substitutions, comments and scripts are ignored because their final exit status cannot prove the
claim ran successfully. Quoted values and backslash-newline continuations are supported. No model
or provider calls are made. Jira keys and branches are not used; Orca already shows the branch on
the worktree card.

## Precedence

1. A name you set (`/name`, `--name`, or another extension) always wins. The extension renames only
   an unnamed session or a name it set itself.
2. Otherwise the latest claimed task, then the watcher role, joined by ` · `.
3. Without either signal the session stays unnamed and Orca keeps its own fallback label.

Each automatic name appends a `session_info` entry and a `flurdy-task-session-name` custom entry to
the session file. Before each update, ownership is reconstructed from the current session's entries;
there is no cached session context or subprocess handle. A later `session_info` you wrote, even for
the same name, leaves the name yours immediately and across reload/resume. Clearing the name
returns control to automatic naming on the next signal. Automatic names also appear in
`/resume`, and stay with the session if you later open it outside Orca.

The extension is active only when `ORCA_PANE_KEY` is set and the session has a UI (interactive or
RPC), so Kitty/plain terminals and headless child agents are unaffected.

## Install and rollback

`make apply` links it as `~/.pi/agent/extensions/flurdy-task-session-name.ts`; restart Pi after first
installation, then `/reload` for later changes. To roll back, remove that link and `/reload`. Existing
automatic names stay in session files; rename or keep them with `/name`.

Built against Pi 1.4.0 (`tool_result`, `setSessionName`, `appendEntry`, `ctx.hasUI`) and observed
with Orca 1.4.230, where a native Pi session name appears in both the sidebar row and the tab.

## Verification

From the repository root, with Node >=22.19:

```bash
make check-task-session-name
pi/statusline/node_modules/.bin/tsc -p pi/task-session-name/tsconfig.json
```

The tests cover claim parsing, quoting, rejection of compound shell syntax, failure and tool filtering,
user-name precedence (including same-name manual edits), clearing, reload/resume ownership,
forged entries, the role vocabulary, and the Orca/UI
gates. They do not prove what Orca renders; check the sidebar row and tab in an attended session.
