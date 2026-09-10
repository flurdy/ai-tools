# Claude Artifact Hygiene Push Gate

Runs the portable [artifact-hygiene audit](https://github.com/flurdy/agent-skills/tree/main/skills/artifact-hygiene)
before detected `git push` commands in Claude Code's Bash tool. The audit remains owned by
agent-skills; this thin client hook maps its result to allow or deny without copying detectors.
Originally promoted from the dotfiles hook.

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
| Invalid hook payload or missing command | Deny with exit 2 without running the audit |
| Command is not a detected push | Allow without running the audit |
| Detected push lacks an absolute `-C`, is wrapped/chained, or cannot be resolved | Deny with exit 2 without running the audit |
| Exit 0, no findings or info-only findings | Allow and name the audited repository |
| High, medium, low, or missing-severity findings | Deny with exit 2 |
| Nonzero audit exit, including partial coverage or failure | Deny with exit 2 |
| Audit helper missing or not executable | Deny with exit 2 |

Audit pass and denial messages name the resolved repository. Audit denials summarize coverage
errors before severity/category counts and the verdict, then point to `/artifact-hygiene` for the
redacted report. Unresolved pushes deny without claiming a repository was audited. The hook runs
read-only Git discovery; it never pushes or fixes findings. Partial coverage relies on the audit's
documented nonzero exit contract.

## Runtime assumptions and limits

- Requires Bash, Python 3, standard Unix text utilities, and agent-skills installed with the
  executable helper at `~/.agents/skills/artifact-hygiene/scripts/artifact_hygiene.py`.
- The audit itself requires Git and Gitleaks; a missing scanner produces partial coverage.
- The 300-second timeout is enforced by Claude's hook registration, not by the shell script.
- Repository resolution requires one standalone `git -C /absolute/repository push ...` command
  with exactly one literal absolute `-C` path. Bare pushes and relative `-C` deny. Optional no-value
  Git flags are `--no-pager`, `--paginate`, `--literal-pathspecs`,
  `--no-literal-pathspecs`, `--glob-pathspecs`, `--noglob-pathspecs`, and `--icase-pathspecs`.
- Tokens must be unquoted ASCII letters/digits or `- _ . / : @ % + = ,`, separated by spaces/tabs.
  Quotes, escapes, globs, tilde/variable expansion and other shell syntax are deliberately unsupported.
- The payload cwd is never repository proof: the shared [Codex hook](../../codex/artifact-hygiene-gate/)
  receives session cwd, not necessarily the command's workdir. An absolute `-C` is independent of both.
  Read-only `git rev-parse --show-toplevel` resolves the candidate's worktree root; bare repositories
  deny. Inherited Git repository, worktree, index, object-store, namespace, discovery or config
  overrides deny rather than redirect discovery or the audit. Inline assignments are unsupported.
- Detected shell wrappers, directory changes, subshells, and command chains deny before auditing.
  Issue each push as its own visible command; rewrite `cd path && git push` using an absolute `-C`.
- Push detection is still a regex, not a shell parser. Aliases, alternate Git executable paths,
  scripts, shell expansions, and other indirect invocations can bypass it. Non-push commands containing
  a `push` token (such as `git checkout push`) can also produce a conservative denial.
- The hook trusts the installed helper's report schema and exit contract. It is a guardrail, not a
  general shell security boundary or a replacement for explicit push approval.

## Verification

`make test` uses a disposable HOME and audit fixture; it never pushes or reads real audit
candidates. From the repository root, `make check` runs both Claude and Codex gate suites and the
watch-loop extraction contract; other components retain their own verification commands.
