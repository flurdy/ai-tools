# Pi Session Mode

Pi extension that keeps normal implementation fast while preventing two guarded Pi sessions from intentionally writing the same Git worktree.

This is a best-effort accidental-change guard, not a sandbox or security boundary.

## Modes

| Mode | Behavior |
| --- | --- |
| `implement` | Acquires the canonical Git-worktree lease before enabling write tools. This is the default for a new session. |
| `plan` | Takes no lease, hides `edit`/`write`, and blocks obvious model-driven mutations. |

Commands:

- `/plan`: guard tools first, release any held lease, warn if the worktree is dirty, and persist the mode on the active session branch.
- `/implement`: acquire the lease before restoring write tools.

The extension exposes `--plan` and `--implement` for launcher integration. `pl` provides the preferred Ctrl-P mode toggle. An explicit startup flag wins over restored branch state; otherwise the latest active-branch mode is restored.

The extension publishes full-text footer states: `implement`, `plan`, `conflict`, `lost`, and `unguarded`. `acquiring` is shown while `/implement` waits for the lease handshake. The companion statusline keeps those labels as its text fallback and normally maps them to `✅`, `🔍`, `⛔`, `💥`, `🚨`, and `⏳` respectively.

## Lease

The lease identity is the SHA-256 hash of `realpath(git rev-parse --show-toplevel)`. A private runtime directory contains:

- a stable `flock(1)` lock file, which is the authority;
- best-effort JSON holder metadata, which is diagnostic only.

A fixed child runs under nonblocking `flock`, prints a ready handshake, and then waits on a parent-owned pipe. Pi reports `implement` only after that handshake and metadata write complete. Releasing the pipe, normal shutdown, or process death releases the kernel lock. Unexpected holder exit moves the session immediately to guarded `lost` state.

Separate Git worktrees have separate canonical roots and can implement concurrently. A second session in the same worktree enters guarded `conflict` state and shows holder details when available.

The companion statusline may inspect the same stable lock path through the kernel's live lock table. In plan mode it renders a separate `🔒` cell when another same-user session holds the worktree lease. This read-only, asynchronous observation never trusts holder JSON, never takes the lock, and disappears when inspection is unavailable.

## Guarded policy

Guarded states:

- hide and independently block `edit` and `write`, and block the native `powershell` tool;
- allow read-only subagent management, status, validation, and cancellation operations;
- allow direct `reviewer`, `claude-code`, `codex-exec`, and `cursor-agent` calls only when pi-subagents resolves their effective tool or runner contracts as read-only in the active model-provider context;
- block alternate child cwd/scope, writer agents, resume/steer operations, explicit output paths, host gates, remote sharing, managed-worktree creation, and dynamic `workflowScript` launches;
- recursively inspect `multi_tool_use.parallel` and allow only named, input-checked read-only tools through a fail-closed nesting limit;
- block obvious model Bash file, package, Git, system, and destructive/remote Beads mutations;
- allow reads and ordinary local Beads triage, including local `.beads`/Dolt writes;
- inject concise guarded-mode guidance into the model system prompt.

The effective-agent check uses pi-subagents' installed resolver, including package, user, project, settings, and active-provider overrides. It rejects unexpected tool sets, outputs, extensions, native runners, nested delegation, unpinned external-CLI commands, and direct MCP tool grants. A model change clears previous approval before provider-aware verification completes. Missing or incompatible resolver APIs fail closed for direct agent launches while management and ordinary read tools remain available, and emit one visible warning per guarded episode. Effective agent definitions that simply do not match the read-only contract remain blocked without being reported as discovery failures.

The Bash policy is intentionally bounded. Unknown commands are allowed, constant `sh`/`bash`-family `-c` payloads are inspected recursively through a fail-closed nesting limit, and exact `/dev/null` output discards and file-descriptor duplication are allowed without treating real or dynamic redirect targets as safe. POSIX read-write (`<>`) redirects are mutations. Quoted-text handling only reduces common redirect false positives. Tests pin representative false-positive and false-negative boundaries.

## Explicit boundaries

- Typed `!` and `!!` Bash is not intercepted.
- `--no-extensions` bypasses the guard. In pi-subagents, an explicit extension list or a `denyExtensions` capability ceiling can also result in `--no-extensions`; treat that as the same silent bypass.
- Guarded mode does not yet allow dynamic multi-review `workflowScript` fan-out. That requires a pi-subagents pre-launch policy seam carrying each resolved child and host-step contract; display-only preflight lane metadata and script-text heuristics are not treated as authority.
- Writer children remain blocked in guarded mode, including managed-worktree launches. Switch to `/implement` before launching writers. A same-worktree child that loads the extension contends for the lease rather than inheriting authority.
- Trusted extensions run with user permissions and can bypass this policy.
- Other agents, editors, terminals, machines, and direct filesystem activity do not share this lease.
- Non-Git sessions acquire no cwd lock and remain visibly `unguarded`; a cwd lock would falsely imply protection for nested repositories.
- Nested repositories and initialized submodules are guarded only according to the canonical Git top-level resolved for the launched session.
- Missing Git, `flock`, runtime-directory access, or metadata writes fail open with a prominent `unguarded` state.

Set `PI_SESSION_GUARD=0` for the emergency fail-open kill switch.

## Install and verify

From the repository root:

```bash
make apply
cd pi/session-mode
npm install
npm test
npm run typecheck
```

Restart Pi after the extension is first linked. Later source changes can use `/reload`; reload shuts down and releases the old runtime before reacquiring in the new one. This ordering is verified against Pi 0.84.4 internals and must be rechecked on Pi upgrades.

To roll back, remove the managed extension link and restart Pi. Existing `session-mode` custom entries are inert without the extension.
