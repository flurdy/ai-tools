import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const READ_ONLY_TOOL_NAMES = new Set(["read", "grep", "find", "ls"]);
const EXTERNAL_READ_ONLY_ADAPTERS = new Map([
	["claude-code", "claude-code"],
	["codex-exec", "codex-exec"],
	["cursor-agent", "cursor-agent"],
]);
const READ_ONLY_AGENT_NAMES = ["reviewer", ...EXTERNAL_READ_ONLY_ADAPTERS.keys()];

export interface ResolvedSubagentDefinition {
	name?: unknown;
	source?: unknown;
	tools?: unknown;
	mcpDirectTools?: unknown;
	runner?: {
		type?: unknown;
		adapter?: unknown;
	} | unknown;
}

export interface ReadOnlySubagentDiscoveryOptions {
	agentDir?: string;
	discoverAgents?(cwd: string): Promise<ResolvedSubagentDefinition[]>;
}

function agentDirFromEnvironment(): string {
	const configured = process.env.PI_CODING_AGENT_DIR;
	const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
	if (configured === "~") return home;
	if (configured?.startsWith("~/") || configured?.startsWith("~\\")) return path.join(home, configured.slice(2));
	return configured || path.join(home, ".pi", "agent");
}

async function discoverEffectiveAgents(cwd: string, agentDir: string): Promise<ResolvedSubagentDefinition[]> {
	const modulePath = path.join(agentDir, "npm", "node_modules", "pi-subagents", "src", "agents", "agents.ts");
	const module = await import(pathToFileURL(modulePath).href) as {
		discoverAgents?: (cwd: string, scope: "both") => { agents?: unknown };
	};
	const agents = module.discoverAgents?.(cwd, "both").agents;
	if (!Array.isArray(agents)) throw new Error("pi-subagents discovery API returned no agents");
	return agents as ResolvedSubagentDefinition[];
}

function isReadOnlyContract(name: string, agent: ResolvedSubagentDefinition): boolean {
	if (agent.mcpDirectTools !== undefined && (!Array.isArray(agent.mcpDirectTools) || agent.mcpDirectTools.length > 0)) return false;
	if (name === "reviewer") {
		return Array.isArray(agent.tools)
			&& agent.tools.length > 0
			&& agent.tools.every((tool) => typeof tool === "string" && READ_ONLY_TOOL_NAMES.has(tool));
	}
	const expectedAdapter = EXTERNAL_READ_ONLY_ADAPTERS.get(name);
	if (!agent.runner || typeof agent.runner !== "object") return false;
	const runner = agent.runner as { type?: unknown; adapter?: unknown };
	return runner.type === "external-cli" && runner.adapter === expectedAdapter && agent.tools === undefined;
}

export async function verifiedReadOnlySubagents(
	cwd: string,
	options: ReadOnlySubagentDiscoveryOptions = {},
): Promise<ReadonlySet<string>> {
	try {
		const agentDir = options.agentDir ?? agentDirFromEnvironment();
		const agents = await (options.discoverAgents ?? ((target) => discoverEffectiveAgents(target, agentDir)))(cwd);
		const verified = new Set<string>();
		for (const name of READ_ONLY_AGENT_NAMES) {
			const agent = agents.find((candidate) => candidate.name === name);
			if (agent && isReadOnlyContract(name, agent)) verified.add(name);
		}
		return verified;
	} catch {
		return new Set();
	}
}
