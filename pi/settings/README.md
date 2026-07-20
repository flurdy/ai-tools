# Pi settings starter and component catalog

A credential-free starting point for a personal Pi setup. It captures useful display, model-cycling, package, and shared-skill choices without copying authentication, MCP servers, caches, trust decisions, sessions, run history, or usage ledgers.

The examples are a **July 2026 snapshot**, not a universal configuration. Pi packages and extensions run with the user's full permissions; review every source before installing it.

## Files

- [`settings.example.json`](settings.example.json) — global Pi settings starter.
- [`mcp-adapter.safe-example.json`](mcp-adapter.safe-example.json) — adapter-level safety defaults with no MCP servers configured.
- [`pi-permission-system.config.example.json`](pi-permission-system.config.example.json) — conservative policy proposed by the [20.9.0 audit](../../docs/pi-permission-system-audit.md); the package remains deferred and is not in the settings starter.

None of these files contains credentials, account identifiers, local history, or generated state.

## Use the settings starter

Pi reads global settings from `~/.pi/agent/settings.json`. If that file already exists, do **not** overwrite it: inspect the example and merge only the keys you want. For a fresh setup, this non-overwriting copy is available:

```bash
mkdir -p ~/.pi/agent
cp -n "$PWD/pi/settings/settings.example.json" ~/.pi/agent/settings.json
```

Before restarting Pi:

1. Install or replace the `flurdy-dark` theme; the example expects this repo's [Pi theme](../theme/). Change `theme` to `dark` if you do not want it.
2. Run `/login` and `pi --list-models`. Remove models that are unavailable under your authentication and choose your own default. Model names and access change over time.
3. Audit each package below, then install only the ones you want. The unpinned package sources in the starter follow current releases; pin `@version` when reproducibility matters.
4. Keep `~/.claude/skills` only if you want Pi to discover reviewed Claude Code skills from that directory. A shared skill can contain executable helpers and agent instructions.
5. Restart Pi. Use `/settings` for common preferences and `pi config` to enable or disable package resources.

`defaultThinkingLevel: "medium"` is a balanced default, not a quality guarantee. `enabledModels` controls Ctrl+P cycling; it does not authenticate providers or make a model available.

## Component catalog

### Owned by this repository

| Component | Location | Purpose | Installation note |
| --- | --- | --- | --- |
| Flurdy dark theme | [`pi/theme/`](../theme/) | High-contrast Pi theme used by the starter. | Install the theme before selecting `flurdy-dark`. |
| Statusline | [`pi/statusline/`](../statusline/) | Custom footer with context, model, quota, Git, and session signals. | Optional local extension; review privacy-related display options. |
| Model tier router | [`pi/model-tier-router/`](../model-tier-router/) | Maps portable skill tiers to exact local models. | Uses a separate local router config; it is not installed by this starter. |
| Kitty tab title | [`pi/kitty-tab-title/`](../kitty-tab-title/) | Displays Pi session/repository state in Kitty tabs. | Kitty-specific and optional. |
| `APPEND_SYSTEM.md` example | [`pi/append-system/`](../append-system/) | Adds concise response and Git remote-safety guidance. | Opt-in system instructions, separate from settings and prompt templates. |
| Pi launcher | [`pi/launcher/`](../launcher/) | Selects checkouts, worktrees, and handoffs before launching Pi. | Contains local workflow assumptions; review before adopting. |

### Third-party Pi packages

These are upstream packages referenced by `settings.example.json`; this repository does not own or vendor them.

| Package | Provides | Prerequisites and boundaries |
| --- | --- | --- |
| [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) | Lazy MCP proxy, server discovery, direct-tool opt-ins, OAuth flows, and output guards. | Installing the adapter does not safely configure servers. Audit every MCP command, URL, environment mapping, and auth flow separately. |
| [`@pi-stef/atlassian`](https://github.com/sfiorini/pi-stef/tree/main/packages/atlassian) | Jira and Confluence tools plus story context. | Requires Atlassian site/email/token configuration outside this repo. Keep secret files user-readable only. |
| [`@pi-stef/figma`](https://github.com/sfiorini/pi-stef/tree/main/packages/figma) | Figma REST tools and compact design context. | Private/team files require a Figma token and suitable scopes. Do not commit its token config. |
| [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) | Structured clarification questionnaires. | TUI-oriented; restart Pi after installation. Localization is optional. |
| [`pi-subagents`](https://github.com/nicobailon/pi-subagents) | Child agents, chains, parallel work, reviews, and async runs. | No initial config required, but child models can add cost and execute tools. Review agents, model routing, and tool boundaries. |
| [`pi-web-access`](https://github.com/nicobailon/pi-web-access) | Web search, URL/PDF/GitHub fetching, and video analysis. | Basic search can work without a key; other providers use separate secrets. `ffmpeg` and `yt-dlp` are optional for frame extraction. |
| [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) | Ephemeral model execution checklist and overlay. | Use it for current-session execution, not as a durable issue tracker. Restart Pi after installation. |
| [`@gotgenes/pi-permission-system`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-permission-system) | Host-level allow/ask/deny gates for tools, bash, paths, MCP, skills, and subagents. | Global installation is deferred by the [20.9.0 audit](../../docs/pi-permission-system-audit.md). Do not install unpinned or enable yolo mode; use the conservative policy only for an explicitly approved pilot. |

Install reviewed packages individually so each source is visible:

```bash
pi install npm:pi-mcp-adapter
pi install npm:@pi-stef/atlassian
pi install npm:@pi-stef/figma
pi install npm:@juicesharp/rpiv-ask-user-question
pi install npm:pi-subagents
pi install npm:pi-web-access
pi install npm:@juicesharp/rpiv-todo
```

Project-scoped installation uses `-l` and requires project trust. Use `pi list` to inspect installed package sources and `pi config` to control which resources load.

### Bundled Pi extension examples

These examples come from Pi itself, not this repository or the third-party packages above. Find them under the installed Pi package's `examples/extensions/` directory and read the source before copying it into `~/.pi/agent/extensions/`.

| Upstream example | What it demonstrates | Important limitation |
| --- | --- | --- |
| [`confirm-destructive.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/examples/extensions/confirm-destructive.ts) | Confirmation before `/new`, session switching, and forking. | It does not gate shell commands, file deletion, Git pushes, or arbitrary tools. |
| [`notify.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/examples/extensions/notify.ts) | Terminal/OS notification when an agent run ends. | Behavior depends on terminal and platform; inspect the PowerShell/OSC implementation. |
| [`protected-paths.ts`](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/examples/extensions/protected-paths.ts) | Blocking built-in `write` and `edit` calls for configured path substrings. | It is illustrative, not a sandbox: shell commands and other mutation tools are outside its guard. Adapt its path matching before relying on it. |

Copied examples become your code to maintain. A Pi upgrade may improve the upstream example without updating your copy.

## Safe MCP boundary

MCP server definitions are executable integration configuration, not ordinary Pi settings. A stdio server can launch a local command; a remote server can receive data and invoke authenticated APIs. Treat either as third-party code with access to whatever environment, files, headers, and credentials you grant it.

The safe example intentionally contains **no servers**. It only keeps proxy mode, automatic auth, sampling auto-approval, and direct tools conservative while retaining the adapter's output guard:

```bash
mkdir -p ~/.pi/agent
cp -n "$PWD/pi/settings/mcp-adapter.safe-example.json" \
  ~/.pi/agent/mcp.json
```

If an MCP config already exists, do not overwrite it; merge reviewed adapter settings manually. An empty `mcpServers` object provides no MCP capability until you add a server.

Before adding or importing any server:

1. Prefer the adapter's `/mcp setup` preview and standard `.mcp.json` or `~/.config/mcp/mcp.json` locations.
2. Audit `command`, `args`, `cwd`, `url`, `headers`, `env`, OAuth settings, and every exposed/direct tool.
3. Reference secrets through narrowly scoped environment variables or the integration's dedicated secret store; never place literal tokens in this repository.
4. Keep `directTools` false or narrowly list reviewed tools. More direct tools increase prompt size and capability exposure.
5. Keep output guarding enabled. Spilled temporary output can still contain sensitive data and needs appropriate cleanup.

Do not treat `@gotgenes/pi-permission-system@20.9.0` as a complete safety wrapper around `pi-mcp-adapter@2.11.0`: proxy arguments use an input shape its path gate does not inspect, direct tools use separate permission surfaces, and MCP App callbacks do not pass through Pi's tool-call gate. Keep the adapter's own conservative settings; see the [permission-system audit](../../docs/pi-permission-system-audit.md).

Never derive a shareable example by copying raw `mcp.json`, `.mcp.json`, `auth.json`, token files, `mcp-cache.json`, trust files, session JSONL, subagent run artifacts, web-search configuration, package caches, run history, or model-usage ledgers. Build examples from documented schemas and empty placeholders instead.
