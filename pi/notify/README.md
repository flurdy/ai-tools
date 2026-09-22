# Pi completion notifications

A maintained, dependency-free adaptation of Pi's [`notify.ts` example](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/examples/extensions/notify.ts). Sends **Pi: Ready for input** when `agent_settled` fires, after automatic retries, compaction and queued follow-ups. Intermediate `agent_end` events do not notify.

“Ready” means Pi has settled, not that the task succeeded: errors and cancellation can also settle a run. Independently running background jobs are not tracked by this extension.

## Install

From the repository root:

```bash
make apply
make verify-apply
```

This adds `~/.pi/agent/extensions/flurdy-notify.ts` alongside the other managed resources. Restart Pi after first installation; use `/reload` for subsequent source changes. Requires a Pi version providing `agent_settled` and `ctx.mode` (verified against 0.86.1 documentation).

Before installing, disable any other completion notifier, including an unmanaged copy of upstream `notify.ts`. Arbitrary extensions cannot be automatically detected as duplicate notifiers. `make apply` never changes settings or deletes those copies; it refuses conflicting files, directories or differently targeted links at any managed resource name before installing links. Inspect and relocate conflicts yourself, then retry.

## Delivery

| Environment | Default behavior |
| --- | --- |
| Kitty (`KITTY_WINDOW_ID` or `TERM=xterm-kitty`) | One complete [OSC 99](https://sw.kovidgoyal.net/kitty/desktop-notifications/) notification. |
| Ghostty (`TERM_PROGRAM=ghostty` or `TERM=xterm-ghostty`) | OSC 777 title/body notification, as in Pi's example. |
| WezTerm (`TERM_PROGRAM=WezTerm`) | [OSC 777](https://wezterm.org/escape-sequences.html) title/body notification. |
| Orca (`ORCA_PANE_KEY` or `TERM_PROGRAM=Orca`) | Silent; completion reporting belongs to Orca's host integration. |
| tmux, screen, dumb or unknown terminals | Silent; no guessed protocol or multiplexer passthrough. |
| RPC, print, JSON or redirected stdout | Silent, even with inherited terminal variables. |

Only a TUI with terminal stdout and an idle agent emits output. The message is fixed: no prompts, responses, paths, session names or credentials leave the process. No shell commands, network calls, terminal queries, timers or OS-notification subprocesses are used. Terminal write errors are swallowed. Desktop delivery still depends on terminal support, OS permissions and notification settings; it is not acknowledged by the extension.

`PI_NOTIFY_PROTOCOL` selects `auto` (default), `off`, `osc99`, or `osc777`. An explicit protocol can support a terminal not auto-detected; use it only after checking that terminal's documentation. Unknown values disable output. Overrides never bypass Orca, multiplexer, dumb-terminal, non-TUI, non-TTY or idle guards. For another host integration that already alerts, set `PI_NOTIFY_PROTOCOL=off` before launching Pi.

On rivelino inside Orca, this extension deliberately adds **no second alert**. Host completion reporting is not proof that an OS popup is enabled; configure and verify that in Orca. In standalone Kitty, let Pi finish a prompt while another window has focus and check for a single notification.

## Verification

From the repository root, with Node >=22.19:

```bash
make check-notify
# Optional typecheck using the existing statusline development dependencies:
pi/statusline/node_modules/.bin/tsc -p pi/notify/tsconfig.json
```

The deterministic tests cover lifecycle timing, exact protocol bytes, host/transport/mode guards and write failures. Installation tests use disposable directories under ignored `.artifacts/`, exercise apply/verify and collision refusal, and preserve unrelated settings and extensions. `make check` includes these tests. They do not prove a desktop popup was displayed.
