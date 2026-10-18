# Pi prompt shortcuts

Four manual quick prompts, maintained here without an upstream package dependency. They save typing; they do not fix unnecessary agent stops or automatically restart work.

| Intent | Shortcut | Command fallback |
| --- | --- | --- |
| Continue already-authorized work (including “go on” / “go”) | Alt+Shift+C | `/quick-continue` |
| Checkpoint: done, verified, left, blockers | Alt+Shift+S | `/quick-checkpoint` |
| Decisions or approvals still needed | Alt+Shift+U | `/quick-unblock` |
| Explain the last recommendation or decision | Alt+Shift+W | `/quick-why` |

Each invocation sends the fixed text in [`PRESETS`](pi-prompt-shortcuts.ts) as a visible user message and starts a normal model turn. Continue explicitly withholds new approval and asks the agent to restate any pending decision and stop. The other prompts request read-only responses. There are deliberately no “yes”, “do it”, approval, or permission-grant presets. Type an exact approval yourself when appropriate; these prompts never substitute for native confirmation dialogs.

## Input behavior and limits

- TUI only; busy agents and pending message queues reject sends rather than steering or queueing them.
- Shortcuts refuse any editor text, including whitespace, and fail closed if the editor cannot be read. They do not clear or replace drafts. Submitted slash commands use Pi's normal editor submission path instead.
- Commands reject arguments instead of silently discarding qualifications. For custom instructions, type a normal message.
- A shared latch refuses duplicate presses while a submission is starting or running. Only session start or final `agent_settled` re-arms it; intermediate run ends do not. Those listeners never send messages.
- Pi's `sendUserMessage` API does not return a completion promise. If authentication, another extension's input handler, or another preflight check prevents the run from starting, the latch remains closed. Resolve the error, then `/reload` before deliberately retrying. No automatic retries or timeout resets.
- Prompt wording is guidance, **not an enforcement boundary**. Existing session guards, scope, billing consent and action-specific confirmations remain authoritative. Other extensions can transform input. No filesystem, network, shell, model selection, telemetry, or persistent state is added here.

Modified letter chords need a terminal that reports their modifiers (usually Kitty keyboard protocol). No terminal is inferred from `$TERM`, and Enter combinations are deliberately avoided. `/hotkeys` shows registered bindings, not proof your terminal delivers them. If keys are intercepted or unavailable, use the commands. Check autocomplete for the actual invocation names if another extension also defines a `quick-*` command; Pi can suffix collisions. Do not load duplicate copies.

## Install and verify

After reviewing the source, from the repository root:

```bash
make check-prompt-shortcuts
node --test tests/pi-apply.test.mjs
# Optional typecheck with the existing statusline development dependencies:
pi/statusline/node_modules/.bin/tsc -p pi/prompt-shortcuts/tsconfig.json

# Separate live-install step; links all managed resources, not just this one:
make apply
make verify-apply
```

Installation adds `~/.pi/agent/extensions/flurdy-prompt-shortcuts.ts`. Restart Pi after the initial link; `/reload` loads later source changes. The installer refuses conflicting destinations and leaves unrelated settings untouched. No upstream `pi-continue` package is required.

The implementation targets Pi 1.3.0's extension API. Unit tests cover exact message delivery, non-TUI/busy/queue/draft refusal, argument rejection, duplicate submission and passive reset behavior. Installer tests use disposable `.artifacts/` profiles and cover links, missing resources and collisions. Automated tests do not prove terminal delivery or model compliance with prompt wording.

For an attended terminal check, start with an empty editor and press Alt+Shift+W: expect one visible Why prompt. Repeat with an editor draft (expect refusal and unchanged text), then during an active run (expect refusal). This starts ordinary billed/subscription model turns; perform it deliberately in your normal profile after installation. Preset text and keys can be adjusted together in `PRESETS` as usage warrants; update the tests alongside them. No runtime log collection is installed.
