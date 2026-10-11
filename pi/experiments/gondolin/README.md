# Gondolin bounded pilot — not for daily activation

Opt-in, **experimental** routing of Pi's native read/write/edit/bash/grep/find/ls and explicit
user Bash into a QEMU/KVM guest. This is not a full-agent sandbox. Pi, provider authentication,
custom tools, MCP and unproven child sessions stay on the host.

**Disposition: revise before adoption.** The ordinary-checkout pilot works, but the restricted
mount deliberately breaks global skill reads, Git/Beads operations, additional roots and file
only grants. Do not replace normal tooling or activate globally on this evidence.

## Fixed boundary

- Node >=24.11.0; Linux x86_64; `/usr/bin/qemu-system-x86_64` and accessible KVM.
- Exact `@earendil-works/gondolin@0.12.0`, locked with registry integrity. Reviewed source:
  [`6283697`](https://github.com/earendil-works/gondolin/tree/628369764fcd2c987b4b99e5159ec90d4febe53a).
- Alpine base 0.2.0 x86_64 image, build `3cd7a864-f023-5a35-9db1-39a1be5bdcca`.
  [Archive](https://github.com/earendil-works/gondolin/releases/download/image-alpine-base--0.2.0/gondolin-image-alpine-base-0.2.0-x86_64.tar.gz)
  SHA-256: `ee3054f1b948c481b35d3a5a4ff9eb3db67ea2e1fdb5159d869fee5ede085bab`.
  Verify before extraction; no implicit image downloads at extension startup.
- Exactly one vetted ordinary checkout is host-backed read/write at `/workspace`. No parent,
  siblings, home, SSH agent or host config mounts. Use synthetic, credential-free fixtures only.
- Explicit empty HTTP/TLS allowlist, internal-range blocking retained, synthetic DNS, no SSH,
  mapped TCP, WebSockets or ingress. Allowed-host configuration is deliberately not exposed yet.
- Guest environment is fixed HOME/PATH/LANG; Pi's supplied shell environment is not forwarded.
- Known secret/config/admin paths and host `node_modules` are hidden. Symlinks, hard-linked files
  and nested repository paths are refused; guest link creation is disabled. This is not an
  arbitrary-secret detector: a token in an ordinary source file would still be exposed.
- Native tool names and host-facing paths remain unchanged for session-mode. Only I/O maps to
  guest paths. Absolute guest paths are not valid native tool paths. Shell cwd is `/workspace`.
- Load the pilot before session-mode so outside-root native writes are refused before dynamic
  lease acquisition. This does not export or replicate session-mode authority.
- Known custom parallel wrappers are refused, not silently rerouted. Other custom tools remain
  host-side. Package activation remains the host guard's responsibility and is not validated here.
- Startup failures stay failures; there is no host-tool fallback. Each runtime attempts VM startup
  once. Shutdown awaits startup then closes the VM; reloading creates a fresh runtime.

A writable mount remains destructible. Guarded plan-mode Bash is still a command checker, not a
read-only filesystem. Explicit `!` commands bypass that checker as before, but execute in the guest.
An already-running shell is not revoked per filesystem operation after a mode change or lease loss.
No stronger promise is made about racing host edits, hostile same-user processes, hypervisor bugs,
resource exhaustion, or arbitrary custom extension execution.

## Preparation and isolated installation

Dependency/image downloads and VM execution require explicit pilot authorization. Never install
from the unreviewed `latest` image selector or enable scripts while resolving dependencies.

```sh
npm --prefix pi/experiments/gondolin ci --ignore-scripts --omit=optional --legacy-peer-deps --no-audit --no-fund
make check-gondolin-pilot
make apply-gondolin-pilot PILOT_AGENT_DIR=/absolute/ai-tools/.artifacts/pilot/agent
make verify-gondolin-pilot PILOT_AGENT_DIR=/absolute/ai-tools/.artifacts/pilot/agent
```

The installer refuses destinations outside this checkout's ignored `.artifacts`, canonicalizes
existing path components and refuses conflicting links. Default `make apply` is unchanged.
No live settings or launcher files are edited. Restart the isolated process after installation.

Launch a separate Pi with a fresh credential-free HOME, agent directory, working directory and
small synthetic Git checkout. Set only these pilot-specific environment variables:

- `GONDOLIN_PILOT=1`
- `GONDOLIN_PILOT_ASSETS=/absolute/verified/image-directory`
- `GONDOLIN_PILOT_STATE=/absolute/private/state-directory` (outside the mounted workspace)

Use a short isolated `TMPDIR`: QEMU Unix socket paths must fit the platform limit. Do not inherit
provider keys, SSH agent, proxies or personal config. Use explicit reviewed extensions with
`--no-extensions --no-mcp --no-skills --no-context-files --no-prompt-templates --offline` and a
scripted local provider, not a paid model. Point `-e` at the installed `gondolin-pilot` link and
load the reviewed session-mode extension afterward. Offline disables automatic host networking;
the guest boundary is the separate HTTP/TLS deny policy.

## Evidence and limits

Native policy tests exercise host containment, new paths, symlink/dangling-link/hardlink rejection,
hidden names, nested repositories, linked-worktree/submodule refusal and fixed environment.
`make check-gondolin-pilot` runs those tests and syntax checks without dependency installation,
a VM or a provider request. These are not TypeScript typechecks or security certification.

| Area | Bounded pilot evidence | Remaining gap |
|---|---|---|
| Guest execution | Real KVM boot, native read/write/edit/bash/ls/find/grep and write-through | No normal project build: image has Bash but lacks Git/ripgrep/toolchains |
| Confinement | Outside-root/hidden/link refusal, host-environment canary absent, HTTPS denied | Not an arbitrary-secret detector or host-race sandbox |
| Guard | Implement writes, plan writes denied, file-only outside mount refused, custom parallel wrapper refused | Lease-loss/revocation races and extra-root acquisition not proven |
| User Bash | Explicit `!` executes at `/workspace` | Not plan-mode read-only enforcement |
| Lifecycle | Startup, shell timeout and shutdown tested | Full reload/cancellation stress remains unverified |
| Host custom tools | Stay host-side by design | No MCP, activation, Orca, Kitty, notifier or statusline compatibility claim |
| Children | No sandbox inheritance assumed | Foreground/background pi-subagents not tested; treat as host-side/unconfined |

Grep/find are bounded pilot approximations, not native ripgrep/ignore-file parity. Searches cap
traversal at 2,000 entries and 64 levels; file samples at 1,000. Grep skips files over 64 KiB and
caps rendered results. Image reads and grep context lines are not supported. Do not infer absent
matches from this sample. Preserve raw smoke evidence only in ignored `.artifacts`; keep the
version/commit-qualified pilot decision with its owning work item.

The adapter was informed by Pi's MIT-licensed Gondolin example; upstream Gondolin is Apache-2.0.
No VM implementation or VFS security fork is maintained here. Remaining compatibility work needs
a separately reviewed design; sibling repositories must not be modified under this pilot.
