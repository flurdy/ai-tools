import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifiedReadOnlySubagents, type ResolvedSubagentDefinition } from "./subagent-policy.ts";

const READ_ONLY_AGENTS: ResolvedSubagentDefinition[] = [
	{ name: "reviewer", source: "builtin", tools: ["read", "grep", "find", "ls"] },
	{ name: "claude-code", source: "builtin", runner: { type: "external-cli", adapter: "claude-code", command: "claude" } },
	{ name: "codex-exec", source: "builtin", runner: { type: "external-cli", adapter: "codex-exec", command: "codex" } },
	{ name: "cursor-agent", source: "builtin", runner: { type: "external-cli", adapter: "cursor-agent", command: "cursor-agent" } },
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
		{ name: "claude-code", source: "package", runner: { type: "external-cli", adapter: "claude-code-writer", command: "claude" } },
		...READ_ONLY_AGENTS.filter((agent) => agent.name === "codex-exec" || agent.name === "cursor-agent"),
	];
	assert.deepEqual(
		[...(await verifiedReadOnlySubagents("/repo", { discoverAgents: discovery(agents) }))].sort(),
		["codex-exec", "cursor-agent"],
	);
});

test("rejects effective output, extension, native runner, and direct MCP authority", async () => {
	for (const reviewer of [
		{ name: "reviewer", source: "project", tools: ["read"], output: "report.md" },
		{ name: "reviewer", source: "project", tools: ["read"], outputMode: "file-only" },
		{ name: "reviewer", source: "project", tools: ["read"], extensions: ["unsafe.ts"] },
		{ name: "reviewer", source: "project", tools: ["read"], extensions: "unsafe.ts" },
		{ name: "reviewer", source: "project", tools: ["read"], subagentOnlyExtensions: ["unsafe.ts"] },
		{ name: "reviewer", source: "project", tools: ["read"], subagentOnlyExtensions: {} },
		{ name: "reviewer", source: "project", tools: ["read"], runner: { type: "pi" } },
		{ name: "reviewer", source: "project", tools: ["read"], allowNestedSubagents: true },
		{ name: "reviewer", source: "project", tools: ["read"], allowNestedSubagents: "true" },
	]) {
		assert.deepEqual([...(await verifiedReadOnlySubagents("/repo", { discoverAgents: discovery([reviewer]) }))], []);
	}
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

test("rejects external adapters with an untrusted command", async () => {
	const agents = [{
		name: "claude-code",
		source: "project",
		runner: { type: "external-cli", adapter: "claude-code", command: "evil-wrapper" },
	}] as unknown as ResolvedSubagentDefinition[];
	assert.deepEqual([...(await verifiedReadOnlySubagents("/repo", { discoverAgents: discovery(agents) }))], []);
});

test("rejects external adapters with extra runner authority", async () => {
	const agents = [{
		name: "claude-code",
		source: "project",
		runner: { type: "external-cli", adapter: "claude-code", command: "claude", args: ["--dangerously-skip-permissions"] },
	}] as unknown as ResolvedSubagentDefinition[];
	assert.deepEqual([...(await verifiedReadOnlySubagents("/repo", { discoverAgents: discovery(agents) }))], []);
});

test("uses the active provider when resolving effective definitions", async () => {
	const agents = await verifiedReadOnlySubagents("/repo", {
		preferredProvider: "other",
		discoverAgents: async (_cwd, provider) => provider === "other"
			? [{ name: "reviewer", source: "project", tools: ["read", "write"] }]
			: READ_ONLY_AGENTS,
	});
	assert.deepEqual([...agents], []);
});

test("fails closed for malformed definitions", async () => {
	const malformed: ResolvedSubagentDefinition[] = [
		{ name: "reviewer", source: "builtin", tools: ["read", "bash"] },
		{ name: "codex-exec", source: "builtin", runner: { type: "external-cli", adapter: "codex-exec-writer", command: "codex" } },
	];
	assert.deepEqual([...(await verifiedReadOnlySubagents("/repo", { discoverAgents: discovery(malformed) }))], []);
});

test("surfaces discovery failures to the guarded controller", async () => {
	await assert.rejects(
		verifiedReadOnlySubagents("/repo", { discoverAgents: async () => { throw new Error("unavailable"); } }),
		/unavailable/,
	);
});

test("installed pi-subagents discovery contract remains loadable", async (t) => {
	const configured = process.env.PI_CODING_AGENT_DIR;
	const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
	const agentDir = configured === "~"
		? home
		: configured?.startsWith("~/") || configured?.startsWith("~\\")
			? join(home, configured.slice(2))
			: configured || join(home, ".pi", "agent");
	try {
		await readFile(join(agentDir, "npm", "node_modules", "pi-subagents", "package.json"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			t.skip("pi-subagents is not installed");
			return;
		}
		throw error;
	}

	await assert.doesNotReject(verifiedReadOnlySubagents(process.cwd()));
});
