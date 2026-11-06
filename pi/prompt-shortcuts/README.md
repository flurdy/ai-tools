# Pi prompt shortcuts

Manual quick actions that save typing; they never automatically restart work or answer native confirmation dialogs.

| Intent | Shortcut | Command fallback | Behavior |
| --- | --- | --- | --- |
| Continue already-authorized work (“go on” / “continue”) | Alt+Shift+C | `/quick-continue` | Send one visible prompt |
| Checkpoint: done, verified, left, blockers | Alt+Shift+S | `/quick-checkpoint` | Send one read-only prompt |
| Decisions or approvals still needed | Alt+Shift+U | `/quick-unblock` | Send one read-only prompt |
| Explain the last recommendation or decision | Alt+Shift+W | `/quick-why` | Send one read-only prompt |
| Reply yes | Alt+Shift+Y | `/quick-yes` | Insert `yes`; manual Enter required |
| Reply approved | Alt+Shift+A | `/quick-approved` | Insert `approved`; manual Enter required |
| Guard writes and release scopes | Alt+Shift+P | `/quick-plan` | Dispatch the registered `/plan` command |
| Prepare implementation command | Alt+Shift+I | `/quick-implement` | Insert `/implement`; edit paths if needed, then press Enter |

Continue explicitly withholds new approval and stops for pending decisions. The four prompt actions start normal model turns; the other actions do not. Inserted replies have their normal contextual meaning only after you review and submit them. Inserted `/implement` executes only after a separate Enter. No shortcut selects an answer in a dialog.

## Input behavior and limits

- TUI only; busy agents and pending message queues refuse actions instead of steering or queueing them.
- Shortcuts preserve every editor draft, including whitespace, and fail closed if the editor cannot be read. Reply actions never clear or replace a draft. Submitted prompt-command fallbacks use Pi's normal editor submission path.
- All `quick-*` commands reject arguments rather than silently discard qualifications. Type a normal message or native command for custom instructions.
- A shared submission latch refuses duplicate prompt presses while a model submission is starting/running. Only session start or final `agent_settled` re-arms it; intermediate run ends never do. If authentication or preflight prevents the run from starting, resolve the error and `/reload` before deliberately retrying. No automatic retries or timeout resets.
- Insert-only actions (yes, approved and Implement) need no model-turn latch: the inserted draft prevents another insertion, and clearing/submitting it allows a later deliberate action.
- Plan requires Pi 1.4.0 or newer. It checks for an exact, unambiguous registered `/plan` extension command before dispatch; missing, conflicting/suffixed, or non-extension commands refuse instead of falling through to an LLM prompt. Existing session-mode scope, lease, contention and confirmation checks still apply.
- Implement only inserts the literal `/implement` into an empty editor. There is no path dialog, automatic command dispatch or scope acquisition. Review it, optionally append worktree paths, and press Enter separately to execute the native command. Bare `/implement` uses native current-worktree/existing-lease behavior; explicit paths use native scope selection and contention checks. Edit or clear the draft to change or cancel it. Insertion needs no command-provider or Pi-version lookup because nothing executes.
- Plan relies on normal session-mode handling of overlapping requests. Pi provides no command-completion signal, so Plan does not use the model-turn latch: repeated Plan presses may reissue `/plan`. This behavior is deliberate, not automatic retry.
- Prompt wording is guidance, **not an enforcement boundary**. Existing guards, billing consent and action-specific confirmations remain authoritative. No shell, account request, model selection, telemetry or persistent configuration is added here.

## Orca legacy encoding

Some Orca Pi panes deliver Alt+Shift+letter as `ESC` followed by an uppercase letter, even though a plain shell can enable Kitty reporting. Pi's matcher does not recognise that legacy form. A session-scoped input adapter translates **only the exact two-byte forms for the eight advertised chords** into their matching CSI-u encoding.

The adapter never consumes input or invokes a handler: normal focused-editor/overlay/dialog routing still decides what happens. It leaves lowercase Alt bindings, legacy `ESC B`/`ESC F` word-navigation aliases, Kitty input, bracketed pastes, longer chunks and unrelated keys unchanged. No terminal setting is changed. The listener is replaced on session start and removed on shutdown.

Legacy input cannot distinguish these chords from Caps Lock + Alt, or Escape followed immediately by an uppercase letter when both arrive in one input event. Avoid those spellings for unrelated input. `ESC P` can incur a short terminal-parser delay because it also prefixes a control string.

This fix deliberately does not reinterpret Kitty's primary key on remapped layouts. For example, `ESC[120:67;4u` reports primary `x`, shifted `C`; Pi still matches `x`. `/hotkeys` proves registration, not delivery. Use the command fallbacks if Orca or the OS intercepts a binding. Check autocomplete for actual fallback names when another extension registers the same command; Pi can suffix collisions. Do not load duplicate copies.

## Key probe

`/quick-keyprobe` waits up to ten seconds for one input event and consumes it, so no shortcut or model turn starts. It temporarily steps ahead of compatibility translation and reports the **original** bytes in a notification. It then unsubscribes; timeout, session replacement and shutdown also clean it up. Only short recognised key-sequence shapes are shown as hex; ordinary text, pasted content and other input are reported as a byte count only. Nothing is persisted.

| Report | Meaning |
| --- | --- |
| `1b 57 (ESCW)` | Original legacy Alt+Shift+W; normal input now translates this before Pi matches shortcuts |
| `ESC[119:87;4u` | Kitty Alt+Shift+W; Pi matches it directly |
| `ESC[120:67;4u` for C | Primary `x`, shifted `C`; separate layout identity issue, not rewritten |
| byte count only | Input was not a recognised bounded key sequence; text was withheld |
| timeout | No eligible input reached the probe: nothing was pressed, or an earlier layer consumed it |

## Install and verify

From the repository root:

```bash
make check-prompt-shortcuts
node --test tests/pi-apply.test.mjs
pi/statusline/node_modules/.bin/tsc -p pi/prompt-shortcuts/tsconfig.json
```

The optional real-host matcher test accepts `PI_TUI_KEYS_MODULE`, an absolute path or file URL to the installed Pi's `pi-tui/dist/keys.js`. Without it, only that host-integration test is skipped; normal unit tests need no Pi runtime dependencies. Local development declarations may be older than Pi 1.4.0; mode dispatch also checks the actual loaded host version before using its newer API.

Initial installation is separate:

```bash
make apply
make verify-apply
```

This links all managed resources, not just this extension, and refuses conflicting destinations. The extension link is `~/.pi/agent/extensions/flurdy-prompt-shortcuts.ts`. Restart after initial installation; `/reload` loads later live-linked changes. No upstream package is required.

For attended Orca checks after reloading, use an empty editor and try each advertised chord. Prompt actions start normal billed/subscription model turns; Plan changes guard state. Verify Y/A only insert replies, I only inserts `/implement` without a dialog or execution, native dialogs are not answered, drafts survive, busy/queued refusals work, and subsequent actions still work. Pressing Enter on an inserted `/implement` requests write scopes through native command handling; exercise that separately and deliberately. Automated tests cover byte translation, the real host matcher when selected, mixed dispatch, editable command insertion without sending, duplicate protection and probe cleanup; they do not prove live terminal delivery or model compliance.
