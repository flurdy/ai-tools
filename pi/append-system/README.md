# Pi `APPEND_SYSTEM.md` example

A small, opt-in system-prompt addition for Pi. It asks agents to finish substantive responses with a focused next action and to require fresh approval before remote Git operations.

`APPEND_SYSTEM.md` is appended to Pi's built-in system prompt; it does not replace it. Use it for stable, always-on preferences and safety rules.

## Install globally

From the root of this repository, create a symlink in Pi's global configuration directory:

```bash
mkdir -p ~/.pi/agent
ln -s "$PWD/pi/append-system/APPEND_SYSTEM.md" \
  ~/.pi/agent/APPEND_SYSTEM.md
```

`ln -s` deliberately fails if `~/.pi/agent/APPEND_SYSTEM.md` already exists, so inspect and back up an existing file before choosing to replace it. Restart Pi after installing or changing this file.

To copy rather than link the example, use this non-overwriting command:

```bash
mkdir -p ~/.pi/agent
cp -n "$PWD/pi/append-system/APPEND_SYSTEM.md" \
  ~/.pi/agent/APPEND_SYSTEM.md
```

## Install for one project

From the root of the target project, create `.pi/APPEND_SYSTEM.md` and copy the example into it:

```bash
mkdir -p .pi
cp -n /path/to/ai-tools/pi/append-system/APPEND_SYSTEM.md \
  .pi/APPEND_SYSTEM.md
```

Project-local Pi resources require the project to be trusted. The project file applies only when Pi starts in that project; the global file applies to every Pi session.

## `APPEND_SYSTEM.md` vs prompt templates

- **`APPEND_SYSTEM.md`**: always-on instructions appended to Pi's default system prompt. It applies automatically to every request in its scope.
- **Prompt templates**: reusable, user-invoked prompts such as `/review` or `/release-check`. They are loaded from Pi prompt directories and only affect a conversation when invoked.
- **`SYSTEM.md`**: replaces Pi's default system prompt. Prefer `APPEND_SYSTEM.md` unless replacing the default prompt is intentional.

Keep this file short, portable, and free of credentials, account details, trust decisions, session transcripts, and machine-specific paths.

## Adaptation

The included rules are examples, not a policy package. Copy them, remove rules that do not fit your workflow, and keep any organization-specific approval or release process in your own configuration.
