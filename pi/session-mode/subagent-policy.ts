import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const READ_ONLY_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
const EXTERNAL_READ_ONLY_ADAPTERS = new Map([
	["claude-code", { adapter: "claude-code", command: "claude" }],
	["codex-exec", { adapter: "codex-exec", command: "codex" }],
	["cursor-agent", { adapter: "cursor-agent", command: "cursor-agent" }],
]);
const READ_ONLY_AGENT_NAMES = ["reviewer", ...EXTERNAL_READ_ONLY_ADAPTERS.keys()];

export interface ResolvedSubagentDefinition {
	name?: unknown;
	source?: unknown;
	tools?: unknown;
	mcpDirectTools?: unknown;
	runner?: unknown;
	output?: unknown;
	outputMode?: unknown;
	extensions?: unknown;
	subagentOnlyExtensions?: unknown;
	allowNestedSubagents?: unknown;
}

export interface ReadOnlySubagentDiscoveryOptions {
	agentDir?: string;
	preferredProvider?: string;
	discoverAgents?(cwd: string, provider?: string): Promise<ResolvedSubagentDefinition[]>;
}

function agentDirFromEnvironment(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
	if (configured === "~") return home;
	if (configured?.startsWith("~/") || configured?.startsWith("~\\")) return path.join(home, configured.slice(2));
	return configured || path.join(home, ".pi", "agent");
}

async function discoverEffectiveAgents(cwd: string, agentDir: string, preferredProvider?: string): Promise<ResolvedSubagentDefinition[]> {
	const modulePath = path.join(agentDir, "npm", "node_modules", "pi-subagents", "src", "agents", "agents.ts");
	const module = await import(pathToFileURL(modulePath).href) as { discoverAgents?: unknown };
	if (typeof module.discoverAgents !== "function") throw new Error("pi-subagents discovery API is unavailable");
	const result = module.discoverAgents(cwd, "both", preferredProvider) as { agents?: unknown; scope?: unknown } | undefined;
	if (!result || !Array.isArray(result.agents) || result.scope !== "both") {
		throw new Error("pi-subagents discovery API returned an incompatible result");
	}
	const agents = result.agents;
	return agents as ResolvedSubagentDefinition[];
}

function hasConfiguredArrayAuthority(value: unknown): boolean {
	return value !== undefined && (!Array.isArray(value) || value.length > 0);
}

function hasAuthorityBeyondReadOnlyContract(agent: ResolvedSubagentDefinition): boolean {
	return agent.output !== undefined
		|| agent.outputMode !== undefined
		|| hasConfiguredArrayAuthority(agent.extensions)
		|| hasConfiguredArrayAuthority(agent.subagentOnlyExtensions)
		|| (agent.allowNestedSubagents !== undefined && agent.allowNestedSubagents !== false)
		|| hasConfiguredArrayAuthority(agent.mcpDirectTools);
}

function isReadOnlyContract(name: string, agent: ResolvedSubagentDefinition): boolean {
	if (hasAuthorityBeyondReadOnlyContract(agent)) return false;
	if (name === "reviewer") {
		return agent.runner === undefined
			&& Array.isArray(agent.tools)
			&& agent.tools.length > 0
			&& agent.tools.every((tool) => typeof tool === "string" && READ_ONLY_TOOL_NAMES.has(tool));
	}
	const expected = EXTERNAL_READ_ONLY_ADAPTERS.get(name);
	if (!expected || !agent.runner || typeof agent.runner !== "object") return false;
	const runner = agent.runner as { type?: unknown; adapter?: unknown; command?: unknown; promptDelivery?: unknown };
	if (Object.keys(runner).some((key) => key !== "type" && key !== "adapter" && key !== "command" && key !== "promptDelivery")) return false;
	return runner.type === "external-cli"
		&& runner.adapter === expected.adapter
		&& runner.command === expected.command
		&& (runner.promptDelivery === undefined || runner.promptDelivery === "stdin")
		&& agent.tools === undefined;
}

export async function verifiedReadOnlySubagents(
	cwd: string,
	options: ReadOnlySubagentDiscoveryOptions = {},
): Promise<ReadonlySet<string>> {
	const agentDir = options.agentDir ?? agentDirFromEnvironment();
	const agents = await (options.discoverAgents ?? ((target, provider) => discoverEffectiveAgents(target, agentDir, provider)))(cwd, options.preferredProvider);
	const verified = new Set<string>();
	for (const name of READ_ONLY_AGENT_NAMES) {
		const agent = agents.find((candidate) => candidate.name === name);
		if (agent && isReadOnlyContract(name, agent)) verified.add(name);
	}
	return verified;
}
