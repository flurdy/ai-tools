import assert from "node:assert/strict";
import test from "node:test";
import { verifiedReadOnlySubagents, type ResolvedSubagentDefinition } from "./subagent-policy.ts";

const READ_ONLY_AGENTS: ResolvedSubagentDefinition[] = [
	{ name: "reviewer", source: "builtin", tools: ["read", "grep", "find", "ls"] },
	{ name: "claude-code", source: "builtin", runner: { type: "external-cli", adapter: "claude-code" } },
	{ name: "codex-exec", source: "builtin", runner: { type: "external-cli", adapter: "codex-exec" } },
	{ name: "cursor-agent", source: "builtin", runner: { type: "external-cli", adapter: "cursor-agent" } },
];

function discovery(agents: ResolvedSubagentDefinition[]) {
	return async () => agents;
}

test("verifies effective read-only builtin contracts", async () => {
	assert.deepEqual(
		[...(await verifiedReadOnlySubagents("/repo", { discoverAgents: discovery(READ_ONLY_AGENTS) }))].sort(),
		["claude-code", "codex-exec", "cursor-agent", "reviewer"],
	);
});

test("rejects effective package, user, or project definitions that add write authority", async () => {
	const agents: ResolvedSubagentDefinition[] = [
		{ name: "reviewer", source: "project", tools: ["read", "write"] },
		{ name: "claude-code", source: "package", runner: { type: "external-cli", adapter: "claude-code-writer" } },
		...READ_ONLY_AGENTS.filter((agent) => agent.name === "codex-exec" || agent.name === "cursor-agent"),
	];
	assert.deepEqual(
		[...(await verifiedReadOnlySubagents("/repo", { discoverAgents: discovery(agents) }))].sort(),
		["codex-exec", "cursor-agent"],
	);
});

test("rejects reviewers with direct MCP tool authority", async () => {
	const agents = [{
		name: "reviewer",
		source: "project",
		tools: ["read", "grep", "find", "ls"],
		mcpDirectTools: ["filesystem/write_file"],
	}] as unknown as ResolvedSubagentDefinition[];
	assert.deepEqual([...(await verifiedReadOnlySubagents("/repo", { discoverAgents: discovery(agents) }))], []);
});

test("fails closed for missing, malformed, or unresolvable definitions", async () => {
	const malformed: ResolvedSubagentDefinition[] = [
		{ name: "reviewer", source: "builtin", tools: ["read", "bash"] },
		{ name: "codex-exec", source: "builtin", runner: { type: "external-cli", adapter: "codex-exec-writer" } },
	];
	assert.deepEqual([...(await verifiedReadOnlySubagents("/repo", { discoverAgents: discovery(malformed) }))], []);
	assert.deepEqual([...(await verifiedReadOnlySubagents("/repo", { discoverAgents: async () => { throw new Error("unavailable"); } }))], []);
});
