# Pi permission-system audit

Audit date: 2026-07-20

## Verdict

**Defer global installation.** `@gotgenes/pi-permission-system@20.9.0` is actively maintained, provenance-backed, well-tested, and statically compatible with Pi 0.80.6. No malicious behavior was found in the reviewed source. However, current trust and integration gaps prevent treating it as a reliable global security boundary:

1. A global permission-system instance loads project and project-agent policy without checking `ctx.isProjectTrusted()`. Project policy has higher precedence than global policy, so an untrusted repository can loosen global denies. The package's accepted [project-trust ADR](https://github.com/gotgenes/pi-packages/blob/9fadd87bf0507b5272bea0812e6393463b1cf994/packages/pi-permission-system/docs/decisions/0001-project-trust-adoption.md#L15-L69) confirms the gap and defers the fix.
2. `pi-mcp-adapter@2.11.0` passes MCP arguments as a JSON string in `input.args`, while the permission system only extracts and previews `input.arguments`. Sensitive-path rules therefore do not inspect proxy arguments, and an `ask` prompt shows the target without those arguments. Unqualified adapter tool names can also be resolved to a server after the permission check, weakening server-level rules.
3. Adapter direct tools are ordinary extension-tool surfaces rather than `mcp`, and MCP App callbacks invoke servers outside Pi's `tool_call` event. An `mcp` rule cannot govern either path.
4. The bash gate does not distinguish output redirects from ordinary command paths. An auto-allowed command can write through `>` when the destination's path policy allows it; upstream issue [#609](https://github.com/gotgenes/pi-packages/issues/609) remains open.
5. The installed subprocess-based `pi-subagents@0.35.0` forwards direct-child prompts, but nested children target a headless parent and per-agent permission identity is not reliably selected.

A project-scoped pilot is reasonable only after explicit approval in a known trusted repository, using the conservative policy in [`pi/settings/pi-permission-system.config.example.json`](../pi/settings/pi-permission-system.config.example.json). Keep bash on `ask`, deny proxy MCP calls, disable adapter direct/App capabilities, avoid nested subagents, and leave composite tool wrappers denied until their nested-call behavior is tested.

The package was downloaded and inspected for this audit. It was **not installed, enabled, or loaded by Pi**.

## Audited artifact

| Item | Evidence |
| --- | --- |
| Package | `@gotgenes/pi-permission-system@20.9.0` |
| Source | [`pi-permission-system-v20.9.0`](https://github.com/gotgenes/pi-packages/tree/pi-permission-system-v20.9.0/packages/pi-permission-system) |
| Commit | [`9fadd87bf0507b5272bea0812e6393463b1cf994`](https://github.com/gotgenes/pi-packages/commit/9fadd87bf0507b5272bea0812e6393463b1cf994) |
| npm tarball SHA-512 | `0562ee5a30419025fccb6a9e6efb8ad937ba3ec2161bc9303edd0097964638b1b9390f35ad0eeb5f22c9aa6e0903c5f83e7113ce7e55dc5c6cfb94d53630a0b0` |
| Provenance | [npm publish and SLSA attestations](https://registry.npmjs.org/-/npm/v1/attestations/@gotgenes%2fpi-permission-system@20.9.0) bind that digest to the source commit and GitHub Actions run |
| Release CI | [Successful release-commit CI](https://github.com/gotgenes/pi-packages/actions/runs/29696720403) |

The npm tarball's runtime source matched the tagged source. npm's packaging step only removed the `prepack` script, resolved workspace catalog versions, and added the generated public declaration bundle. There are no install, postinstall, or prepare lifecycle scripts in the package's own published manifest, and no bundled executable, native, or WebAssembly files. The runtime dependencies are `tree-sitter-bash`, `web-tree-sitter`, and `zod`; the resolved graph also includes `node-addon-api` and `node-gyp-build`. `tree-sitter-bash@0.25.1` has an install-time `node-gyp-build` script even though this extension loads its WASM artifact at runtime. A temporary exact-version graph using Pi's `--legacy-peer-deps` behavior resolved six production dependencies and reported zero known vulnerabilities with `npm audit` on the audit date.

The package has one npm maintainer and a high release rate: 162 versions were published between 2026-05-03 and 2026-07-19, including 20 semver-major lines. That is strong maintenance activity but also substantial policy churn. Pin every installation and review the changelog, source diff, provenance, and CI before changing the pin. The release commit itself is unsigned; npm trusted publishing and provenance reduce registry tampering risk but do not replace maintainer or workflow trust. The publishing workflow also references GitHub Actions by mutable major tags rather than immutable SHAs ([workflow](https://github.com/gotgenes/pi-packages/blob/9fadd87bf0507b5272bea0812e6393463b1cf994/.github/workflows/ci.yml)).

## Security behavior

Positive controls verified in source:

- The extension registers `before_agent_start`, `input`, and `tool_call` gates ([composition root](https://github.com/gotgenes/pi-packages/blob/9fadd87bf0507b5272bea0812e6393463b1cf994/packages/pi-permission-system/src/index.ts#L258-L277)).
- Unexpected gate errors return `{ block: true }` and emit a review entry instead of allowing the tool ([fail-closed boundary](https://github.com/gotgenes/pi-packages/blob/9fadd87bf0507b5272bea0812e6393463b1cf994/packages/pi-permission-system/src/handlers/tool-call-boundary.ts#L37-L64)).
- Rules default to `ask`, support wildcard surfaces, and use last-match-wins ordering ([rule evaluator](https://github.com/gotgenes/pi-packages/blob/9fadd87bf0507b5272bea0812e6393463b1cf994/packages/pi-permission-system/src/rule.ts#L70-L115)).
- Denied tools and skills are removed from the agent prompt before execution, while the tool set is restrict-only ([agent preparation](https://github.com/gotgenes/pi-packages/blob/9fadd87bf0507b5272bea0812e6393463b1cf994/packages/pi-permission-system/src/handlers/before-agent-start.ts#L17-L95)).
- Invalid scope configuration is rejected and contributes no allow rules, so missing rules fall back to `ask` ([config validation](https://github.com/gotgenes/pi-packages/blob/9fadd87bf0507b5272bea0812e6393463b1cf994/packages/pi-permission-system/src/config-loader.ts#L139-L174)).
- Runtime side effects are limited to config/log/forwarding files, a periodic forwarding poller, and an `npm root -g` discovery fallback. No runtime network client or arbitrary dynamic code execution was found in the extension source.

Critical limitation: session startup configures the manager from `ctx.cwd` unconditionally ([lifecycle](https://github.com/gotgenes/pi-packages/blob/9fadd87bf0507b5272bea0812e6393463b1cf994/packages/pi-permission-system/src/handlers/lifecycle.ts#L35-L64)), and permission resolution merges project scopes after global scope ([manager](https://github.com/gotgenes/pi-packages/blob/9fadd87bf0507b5272bea0812e6393463b1cf994/packages/pi-permission-system/src/permission-manager.ts#L164-L202)). No production code calls `ctx.isProjectTrusted()`. A global install can therefore be weakened by project-owned `.pi/extensions/pi-permission-system/config.json` and `.pi/agents/*.md` before the repository is trusted.

This remains a policy layer, not a sandbox. An allowed tool retains the full authority of the Pi process, extension code itself runs with user permissions, and the model can use any capability reachable through an allowed tool.

## Compatibility matrix

| Component | Result | Notes |
| --- | --- | --- |
| Pi 0.80.6 | Static pass | The package declares Pi/TUI peers `>=0.79.0` and Node `>=22` ([manifest](https://github.com/gotgenes/pi-packages/blob/9fadd87bf0507b5272bea0812e6393463b1cf994/packages/pi-permission-system/package.json#L65-L95)). Pi 0.80.6 exports every API used by the extension: `getAgentDir`, `getPackageDir`, the required lifecycle events, and active-tool methods. |
| Node runtime | Pass | The Pi 0.80.6 launcher uses Homebrew Node 26.5.0, satisfying Node `>=22`. The interactive shell's Node 18 can emit engine warnings during npm operations; Pi's runtime is unaffected. If installation is approved, run package management through Homebrew's Node/npm path. |
| Pi package manager | Pass | Pi 0.80.6 installs managed npm packages with `--legacy-peer-deps`, so the extension's Pi peer declarations do not install a second coding-agent runtime. |
| `pi-mcp-adapter@2.11.0` | Blocked | Target rules partly work because the adapter registers `mcp` and supplies `input.tool`. Path extraction and argument previews do not: the adapter supplies `input.args` as a JSON string ([adapter source](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/index.ts#L256-L290)), while the permission package reads `input.arguments.path` ([extractor](https://github.com/gotgenes/pi-packages/blob/9fadd87bf0507b5272bea0812e6393463b1cf994/packages/pi-permission-system/src/access-intent/tool-input-path.ts#L29-L47)) and formats `input.arguments` ([formatter](https://github.com/gotgenes/pi-packages/blob/9fadd87bf0507b5272bea0812e6393463b1cf994/packages/pi-permission-system/src/builtin-tool-input-formatters.ts#L39-L72)). Server rules can also miss unqualified tools resolved by adapter metadata after the gate. Adapter direct tools use generated extension-tool names, and MCP App `/proxy/tools/call` invokes the server directly ([UI server](https://github.com/nicobailon/pi-mcp-adapter/blob/82724dccc13a49310530898f922bafff12b7f3fe/ui-server.ts#L326-L352)); neither path is controlled by the `mcp` surface. |
| `pi-subagents@0.35.0` | Partial | This is not the package's native `@gotgenes/pi-subagents` integration, but it sets `PI_SUBAGENT_PARENT_SESSION` ([launcher source](https://github.com/nicobailon/pi-subagents/blob/eed01ccd0d25fa59e234dcbd2fc040ae429fca49/src/runs/shared/pi-args.ts#L270-L286)), so direct-child `ask` forwarding should work. Its own documentation limits reliable forwarding to direct children; nested children target a headless parent and cannot surface the prompt ([README](https://github.com/nicobailon/pi-subagents/blob/eed01ccd0d25fa59e234dcbd2fc040ae429fca49/README.md#L418-L428)). The installed package exports the child agent name in `PI_SUBAGENT_CHILD_AGENT`, but permission-system only uses that variable as a child-detection hint; per-agent `permission:` frontmatter is not reliably selected for these subprocess children. |
| Jira/Confluence direct tools | Policy-compatible | Exact tool-name wildcard rules can separate read operations from mutations. `jira_download_attachments` writes locally under a non-`path` argument and must remain `ask`. |
| Figma direct tools | Policy-compatible | Read-only `figma_*` calls can be allowed. `figma_render_nodes` may write through `outputDir`, which the generic path extractor does not inspect, so it remains `ask`. |
| Web-access tools | Policy-compatible | `web_search` and `fetch_content` can transmit queries or local content to external services and remain `ask`; stored-result retrieval can be allowed. |
| Skills | Partial | Loaded skills are filtered and `/skill:<name>` is gated. The gate only associates direct `read` calls with skills present in Pi's active skill prompt; arbitrary files that merely contain skill-like instructions are governed by path/tool policy, not the `skill` surface. |
| Composite wrappers | Unverified | No source for the harness-provided `multi_tool_use.parallel` wrapper was found in Pi or the installed packages. Deny it until a live test proves nested calls are individually gated. |

A live extension-load smoke test was intentionally not performed because loading with `pi -e` would enable the package. Static API compatibility and the release CI are the available evidence before approval.

## Proposed least-privilege policy

The example policy is deliberately conservative:

- universal fallback is `ask`;
- sensitive credential paths are hard-denied across file tools and bash;
- ordinary in-project reads are allowed, while writes and edits ask;
- every bash command asks because redirect writes cannot currently be separated;
- MCP status is allowed, but proxy MCP calls are denied because adapter arguments are opaque to the gate;
- adapter direct tools and MCP App callbacks must be disabled separately because they do not use the `mcp` surface;
- skills and direct subagent launches ask; nested subagents are outside the pilot;
- authenticated Jira/Confluence reads and Figma reads are allowed, while mutations and local downloads/renders ask;
- outbound web search/fetch asks;
- yolo mode and the authorizer chain stay disabled;
- review logging and double-confirmation stay enabled;
- only reviewed skill and handoff directories bypass repeated external-directory prompts for read-only tools.

Copying the file is not an installation step. If a project-scoped pilot is approved later, place a reviewed copy at the project config location, not in general Pi settings:

```text
<project>/.pi/extensions/pi-permission-system/config.json
```

A later global rollout would instead use `~/.pi/agent/extensions/pi-permission-system/config.json`.

Do not use session-wide approvals for bash, MCP, mutation tools, external directories, or composite wrappers. Their suggested wildcard can be broader than the one call being reviewed.

## Installation and update policy

1. Do not add the package to the global package list until project policy loading honors `ctx.isProjectTrusted()`.
2. Require adapter support for parsed MCP arguments/path extraction, dependable server attribution, and enforceable direct/App call boundaries before enabling MCP under this policy.
3. Resolve or explicitly retain the all-bash-`ask` mitigation for output redirects before a global rollout.
4. If a pilot is approved, use the exact source `npm:@gotgenes/pi-permission-system@20.9.0`; never use an unpinned spec.
5. Use project scope only in a known trusted, clean project with no production credentials. Disable MCP direct tools/App-capable servers and nested subagents.
6. Verify the npm integrity/provenance, tagged source diff, release CI, dependency audit, dependency lifecycle scripts, and open security-relevant issues before every pin change.
7. Start with the supplied policy unchanged. Run read, write, bash, sensitive-path, external-directory, direct-child subagent, headless, and untrusted-project checks before loosening rules.
8. Treat a malformed config warning, missing review log, forwarding timeout, unexpected unregistered-tool block, or project policy applied before trust as a failed pilot; remove or disable the package rather than switching on yolo mode.
9. Keep Pi's existing Git remote-approval rules. A permission dialog is an additional execution gate, not permission to bypass workflow policy.

## Residual risks

- The extension and every other Pi package still execute with the user's full OS permissions.
- A global instance can be weakened by untrusted project policy until the accepted project-trust ADR is implemented.
- MCP proxy arguments and non-standard path fields can bypass `path` and `external_directory` inspection unless their provider registers a custom extractor.
- MCP direct tools are separate surfaces, and MCP App server calls do not emit Pi `tool_call` events.
- Bash parsing is intentionally conservative but incomplete for output redirects, control-flow bodies, bare or variable-derived paths, and wrappers; wrappers are prompted, not sandboxed.
- `ask` in headless or misrouted subagent contexts denies or can wait up to ten minutes; nested subprocess children are the current practical gap.
- Per-agent permission overrides are not reliable for the installed subprocess-based subagent package.
- Read-only authenticated tools can still disclose private Jira, Confluence, Figma, or web content to the active model.
- Review logs may contain tool names, paths, commands, and bounded input previews. Protect and expire them as sensitive operational data.
- High release velocity and a single publisher increase review burden even with valid npm provenance.
