# Claude Artifact Hygiene Push Gate

Runs the portable [artifact-hygiene audit](https://github.com/flurdy/agent-skills/tree/main/skills/artifact-hygiene)
before detected `git push` commands in Claude Code's Bash tool. The audit remains owned by
agent-skills; this thin client hook maps its result to allow or deny without copying detectors.
Originally promoted from the dotfiles hook.

## Files

- `artifact-hygiene-push.sh`: `PreToolUse(Bash)` hook.
- `settings.artifact-hygiene-gate.fragment.json`: hook registration with a 300-second timeout.
- `artifact-hygiene-push.test.sh`: isolated hook, settings and installation tests.
- `artifact-hygiene-report.test.py`: report-contract and safe-output regressions, called by that suite.

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
| Exit 0 and a valid complete v1 report with no findings or info-only findings | Allow and name the audited repository |
| Critical, high, medium, low, missing, null, or unknown severity | Deny with exit 2 |
| Malformed, unsupported, inconsistent or incomplete report; validator failure | Deny with exit 2 |
| Nonzero audit exit, including partial coverage or failure | Deny with exit 2 |
| Audit helper missing or not executable | Deny with exit 2 |

Audit pass and denial messages name the resolved repository. Denials contain only fixed diagnostic
text, process exit codes and counts by known severity; report-controlled strings and tracebacks are
never printed. Use `/artifact-hygiene` for the full redacted details. Unresolved pushes deny without
claiming a repository was audited. The hook runs read-only Git discovery; it never pushes or fixes findings.

### Report contract

Allow requires both the helper and validator to exit 0. The validator checks the gate-consumed
`artifact-hygiene/v1` fields:

- `status` is `complete`; `verdict` is `clean` exactly when `findings` is empty, otherwise `findings`.
- Coverage includes unique `working-tree`, `branch-history` and `custom-detectors` entries.
  Every entry, including additional sources, is complete with empty `errors` and `limits` lists.
- Each finding has a nonempty string `category` and a known severity. Only `info` findings may pass.

It does not use incidental metadata, locations, or precomputed summary counts for authorization.
Invalid UTF-8/JSON, duplicate keys, non-finite JSON constants, missing or mistyped decision fields,
and reports above the producer's 4,000,000-byte limit deny. Report bytes go directly to isolated
Python rather than shell variables; helper failures and validator exceptions cannot become an allow.

## Runtime assumptions and limits

- Requires Bash, Python 3.10+, standard Unix text utilities, and agent-skills installed with the
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
- The hook validates report structure and the helper's exit status; it still trusts the installed
  helper to perform the audit honestly. It is a guardrail, not a general shell security boundary
  or a replacement for explicit push approval.

## Verification

`make test` uses a disposable HOME and audit fixture; it never pushes or reads real audit
candidates. From the repository root, `make check` runs both Claude and Codex gate suites and the
watch-loop extraction contract; other components retain their own verification commands.
