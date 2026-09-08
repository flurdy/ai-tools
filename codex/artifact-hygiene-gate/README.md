# Codex Artifact Hygiene Push Gate

Registers the canonical [Claude artifact-hygiene gate](../../claude/artifact-hygiene-gate/)
for Codex `PreToolUse`. The provider-neutral shell hook remains in one source location; this
component owns only Codex registration, installation and verification.

## Files

- `hooks.artifact-hygiene-gate.fragment.json`: Codex `PreToolUse(Bash)` registration.
- `Makefile`: installs a direct symlink to the canonical gate script.
- `artifact-hygiene-gate.test.sh`: validates registration and reuses the canonical gate suite
  through the Codex-installed path.

## Install

```bash
make test
make install
```

`make install` links the canonical script as `~/.codex/hooks/artifact-hygiene-push.sh`.
Override the destination with `make install CODEX_DIR=/somewhere/else`. Merge the fragment's
`PreToolUse` entry into `~/.codex/hooks.json` without replacing existing entries such as the
Kitty title hook.

Open Codex and use `/hooks` to inspect and trust the new command definition. Codex records trust
for the hook command; because that command follows a symlink into this checkout, later source
edits run without a fresh trust prompt. Treat this checkout as trusted executable code.

## Behaviour

Codex invokes the synchronous hook before local shell commands. A detected `git push` runs the
artifact-hygiene audit in the target repository. The shared gate allows complete clean and
info-only audits, and denies findings, partial/failed coverage, or a missing helper with exit 2.
Denials use the same bounded summary as Claude Code. Non-push commands pass without auditing.

## Requirements and limits

- Codex CLI with lifecycle hooks enabled; verified against 0.153.4 and the documented
  `PreToolUse` `Bash` contract.
- Bash, Python 3, standard Unix text utilities, and the executable artifact-hygiene helper from
  agent-skills at `~/.agents/skills/artifact-hygiene/scripts/artifact_hygiene.py`.
- The fragment timeout is 300 seconds and is enforced by Codex, not the script.
- Codex can skip untrusted hooks, and specialized tool paths may bypass `PreToolUse`; this is a
  guardrail rather than a complete enforcement boundary.
- Push detection and repository resolution retain the canonical gate's documented regex limits.

`make test` uses synthetic Codex-compatible payloads and a fake audit helper; it never pushes or
reads real audit candidates. The payload contract is verified against Codex documentation rather
than by launching an agent. Run a harmless disposable-repository check after trusting the hook if
you need end-to-end evidence for a specific Codex release.
