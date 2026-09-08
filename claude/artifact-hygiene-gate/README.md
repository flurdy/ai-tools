# Claude Artifact Hygiene Push Gate

Runs the portable [artifact-hygiene audit](https://github.com/flurdy/agent-skills/tree/main/skills/artifact-hygiene)
before detected `git push` commands in Claude Code's Bash tool. The audit remains owned by
agent-skills; this thin client hook maps its result to allow or deny without copying detectors.
Promoted unchanged from the dotfiles hook.

## Files

- `artifact-hygiene-push.sh`: `PreToolUse(Bash)` hook.
- `settings.artifact-hygiene-gate.fragment.json`: hook registration with a 300-second timeout.
- `artifact-hygiene-push.test.sh`: isolated hook, settings and installation tests.

## Install

From this directory:

```bash
make test
make install
```

This symlinks `~/.claude/hooks/artifact-hygiene-push.sh` directly to this checkout, replacing
any existing file or link at that path. Override the destination with
`make install CLAUDE_DIR=/somewhere/else` (and adjust the fragment's command accordingly).
Merge the settings fragment into your Claude settings: combine existing `PreToolUse` arrays,
including Kitty title hooks, rather than replacing them. Installation does not edit settings.

An existing dotfiles-managed installation may instead link its hook to this source and retain
its outer `~/.claude/hooks/` link and registration. Either way, ai-tools is the only editable
hook source; running `make install` replaces that two-link chain with a direct link.

## Behaviour

| Audit result | Hook result |
| --- | --- |
| Command is not a detected push | Allow without running the audit |
| Exit 0, no findings or info-only findings | Allow silently |
| High, medium, low, or missing-severity findings | Deny with exit 2 |
| Nonzero audit exit, including partial coverage or failure | Deny with exit 2 |
| Audit helper missing or not executable | Deny with exit 2 |

Denials summarize coverage errors before severity/category counts and the verdict, then point
to `/artifact-hygiene` for the redacted report. The hook never runs Git, pushes, or fixes findings.
Partial coverage relies on the audit's documented nonzero exit contract.

## Runtime assumptions and limits

- Requires Bash, Python 3, standard Unix text utilities, and agent-skills installed with the
  executable helper at `~/.agents/skills/artifact-hygiene/scripts/artifact_hygiene.py`.
- The audit itself requires Git and Gitleaks; a missing scanner produces partial coverage.
- The 300-second timeout is enforced by Claude's hook registration, not by the shell script.
- Push detection is a regex, not a shell parser. Simple `git push`, options and unquoted
  `git -C /absolute/path push` are supported. Quoted/spaced paths, relative `-C` resolution,
  preceding `cd`, multiple repositories in one command, wrappers, aliases and indirect
  invocations are not reliably handled. It can also match command text that will not execute.
- The hook trusts the installed helper's report schema and exit contract; it is not a general
  shell security boundary or a replacement for explicit push approval.

## Verification

`make test` uses a disposable HOME and audit fixture; it never pushes or reads real audit
candidates. From the repository root, `make check` runs this gate's tests only; other components
retain their own verification commands.
