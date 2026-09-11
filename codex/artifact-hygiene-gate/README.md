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

Codex invokes the synchronous hook before local shell commands. A standalone
`git -C /absolute/repository push ...` runs the artifact-hygiene audit in its resolved worktree.
Bare pushes and relative `-C` deny. The shared gate allows only helper exit 0 plus a validated
complete v1 report with no findings or info-only findings. Malformed reports, unsupported severities,
incomplete coverage, helper/validator failures, and detected wrapped, chained or unresolved pushes
deny with exit 2. Denials contain fixed diagnostics and known severity counts, not report-controlled
text. See the [canonical report contract](../../claude/artifact-hygiene-gate/#report-contract).
Non-push commands pass without auditing.

## Requirements and limits

- Codex CLI with lifecycle hooks enabled. The `PreToolUse` `Bash` payload contract is checked
  against the documentation and 0.153.4 source, not a live Codex session.
- Bash, Python 3.10+, standard Unix text utilities, and the executable artifact-hygiene helper from
  agent-skills at `~/.agents/skills/artifact-hygiene/scripts/artifact_hygiene.py`.
- The fragment timeout is 300 seconds and is enforced by Codex, not the script.
- Codex can skip untrusted hooks, and specialized tool paths may bypass `PreToolUse`; this is a
  guardrail rather than a complete enforcement boundary.
- Repository resolution accepts only the canonical gate's documented standalone command forms;
  detected wrappers, chains, and unresolved repositories deny without auditing a fallback.
- Regex detection retains the canonical gate's documented limits and can miss aliases, alternate
  Git executable paths, scripts, shell expansions, and other indirect invocations.

The [hook contract](https://developers.openai.com/codex/hooks/#common-input-fields) defines `cwd`
as the session working directory and `tool_input.command` as the shell command. In 0.153.4,
[`run_pre_tool_use_hooks`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/hook_runtime.rs)
uses the turn's cwd, while
[`ExecCommandHandler::pre_tool_use_payload`](https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs)
emits only the command, omitting the invocation's workdir. The shared gate therefore requires an
absolute `-C` rather than treating session cwd as execution-directory evidence.

`make test` runs the canonical suite through the installed Codex link, using synthetic payloads
with that shared schema and a fake audit helper; it never pushes or reads real audit candidates.
This is not end-to-end Codex execution evidence.
