# Pi startup skill spotlight

An opt-in, dependency-free Pi extension that shows one randomly selected loaded skill near the
editor when starting a fresh interactive session. It displays a compact `/name` label and a
short description. Discovery still uses Pi's native `skill:name` metadata; this display-only
shorthand does not register command aliases, and explicit `/skill:name` remains available. It never runs the command, reads the skill body, adds a message to model
context, or calls a model.

## Install and enable

From the repository root:

```bash
make apply
make verify-apply
```

This adds `~/.pi/agent/extensions/flurdy-skill-spotlight.ts` through the existing conflict-checked
installer. It does not overwrite unrelated resources or change settings. Restart Pi after first
installation; `/reload` loads later edits but deliberately does not show a tip.

The extension is **off by default**. Enable it for a fresh session:

```bash
env PI_SKILL_SPOTLIGHT=1 pi
```

Set the same environment variable in your launcher environment to enable future sessions. Unset
it or set it to `0` before launching to disable it. Only the exact value `1` enables output; no
user configuration is changed automatically.

## Behavior

- Requires TUI mode, terminal stdout, and a fresh `session_start` (`startup` or `new`). A new
  `/new` session is eligible; resume, fork and reload are not.
- Initial CLI resumes can report `startup`, so an existing session file, conversation history,
  compaction or parent-session metadata also suppresses the tip. Fresh setup/system metadata
  alone is not conversation history. There is no persistent spotlight ledger.
- Uses Pi's `getCommands()` snapshot, filtering for valid loaded `skill:` commands with usable
  descriptions. Prompt templates, extension commands, invalid names and empty descriptions are
  excluded. No filesystem skill scan or second catalog is maintained. Resources added later by
  another extension's `resources_discover` hook are not included in this initial snapshot.
- The standard `aboveEditor` widget sits **below** the startup header/resources. This is layout
  ordering, not a delayed notification; no timer or header replacement is needed. Pi handles
  line wrapping. Descriptions are plain text with terminal controls/bidi formatting removed and
  capped at 140 Unicode code points.
- Removes its own widget on the first agent run or session shutdown; it does not clear other
  widgets, block input, execute the suggested skill, or alter the system prompt.
- Print, JSON, RPC and redirected-output runs remain quiet, even when the opt-in is inherited.
  Hosts missing the modern mode/start-reason APIs fail quietly. Verified with Pi 1.0.4.

A spotlight is a reminder, not an endorsement of a skill's safety or suitability for the current
task. Skill invocation still requires the user's normal intent and permissions. The feature adds
no prompt content beyond Pi's ordinary skill advertising.

## Verification

```bash
make check-skill-spotlight
make check
# Optional typecheck with existing statusline development dependencies:
pi/statusline/node_modules/.bin/tsc -p pi/skill-spotlight/tsconfig.json
# Real TUI and RPC smoke; needs installed Pi, tmux, Python 3, and Node >=22.19:
python3 pi/skill-spotlight/smoke.py
```

Unit tests cover discovery, selection, sanitization, lifecycle, opt-in, headless suppression and
optional failures. Installation tests cover idempotence and file/directory/symlink collisions.
The smoke launches an isolated tmux server with disposable home/settings and one fixture skill,
checks visual order, narrow resize, disabled/resumed/reloaded suppression and RPC silence, and
never submits a model prompt. Its scratch files stay under ignored `.artifacts/` and are removed
on exit. It neither installs into your live home nor uses your credentials.
