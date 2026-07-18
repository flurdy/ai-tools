import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { loadRouterConfig } from "./config.ts";
import modelTierRouter from "./index.ts";
import type { UsageRecordV1 } from "./usage.ts";
import {
	canonicalPath,
	decideTier,
	maxThinkingLevel,
	parseSkillRouting,
	requiresMeteredConfirmation,
	selectCandidate,
	shouldRestoreAfterRun,
	type TierRoute,
} from "./routing.ts";

function model(provider: string, id: string): Model<Api> {
	return { provider, id } as Model<Api>;
}

function assistantMessage(provider: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider,
		model: modelId,
		content: [],
		usage: {
			input: 10,
			output: 4,
			cacheRead: 2,
			cacheWrite: 0,
			totalTokens: 16,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.UTC(2026, 6, 16),
	};
}

const standard: TierRoute = {
	rank: 20,
	thinking: "high",
	candidates: [
		{ model: "missing/first", metered: false },
		{ model: "provider/model/id", metered: false },
	],
};

describe("skill routing metadata", () => {
	it("extracts router fields and ignores Claude and second-opinion model fields", () => {
		const metadata = parseSkillRouting(`---
name: review
model: haiku
model-tier: premium-review
model-cost-policy: deliberate-premium
model-metered-policy: ask-above-standard
model-second-opinion-tier: independent-reasoning
effort: xhigh
---
Body
`);
		assert.deepEqual(metadata, {
			tier: "premium-review",
			costPolicy: "deliberate-premium",
			meteredPolicy: "ask-above-standard",
			effort: "xhigh",
		});
	});
});

describe("tier decisions", () => {
	it("establishes a first tier and permits only higher-ranked upgrades", () => {
		assert.equal(decideTier(undefined, { tier: "standard", rank: 20 }), "initial");
		assert.equal(decideTier({ tier: "standard", rank: 20 }, { tier: "premium", rank: 40 }), "upgrade");
		assert.equal(decideTier({ tier: "premium", rank: 40 }, { tier: "cheap", rank: 10 }), "retain-lower");
	});

	it("upgrades focused coding to advanced coding without downshifting", () => {
		const focused = { tier: "focused-coding", rank: 25 };
		const advanced = { tier: "advanced-coding", rank: 30 };
		assert.equal(decideTier(focused, advanced), "upgrade");
		assert.equal(decideTier(advanced, focused), "retain-lower");
	});

	it("retains the root route for equal-ranked tiers", () => {
		assert.equal(decideTier({ tier: "premium-review", rank: 40 }, { tier: "premium-reasoning", rank: 40 }), "retain-equal");
	});

	it("permits thinking upgrades but not downgrades", () => {
		assert.equal(maxThinkingLevel("medium", "xhigh"), "xhigh");
		assert.equal(maxThinkingLevel("high", "low"), "high");
		assert.equal(maxThinkingLevel("max", "xhigh"), "max");
	});
});

describe("candidate selection", () => {
	it("requires confirmation for every metered candidate regardless of skill metadata", () => {
		const metered = { model: "provider/premium", metered: true };
		assert.equal(requiresMeteredConfirmation(metered), true);
		assert.equal(requiresMeteredConfirmation({ ...metered, metered: false }), false);
	});

	it("uses exact provider/model ids and configured fallback order", () => {
		const selected = selectCandidate(standard, [model("provider", "model/id"), model("other", "first")]);
		assert.deepEqual(selected, { model: "provider/model/id", metered: false });
	});

	it("returns undefined when no configured candidate is available", () => {
		assert.equal(selectCandidate(standard, [model("provider", "different")]), undefined);
	});
});

describe("configuration", () => {
	it("loads global configuration and merges trusted project tiers", () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "model-tier-router.json"),
			JSON.stringify({
				enabled: true,
				tiers: {
					standard: { rank: 20, thinking: "high", candidates: [{ model: "global/standard", metered: false }] },
					cheap: { rank: 10, thinking: "low", candidates: [] },
				},
			}),
		);
		writeFileSync(
			join(cwd, ".pi", "model-tier-router.json"),
			JSON.stringify({
				restoreAfterRun: false,
				tiers: {
					standard: { rank: 25, thinking: "medium", candidates: [{ model: "project/standard", metered: true }] },
				},
			}),
		);

		const result = loadRouterConfig({ agentDir, cwd, projectTrusted: true });
		assert.equal(result.config.restoreAfterRun, false);
		assert.equal(result.config.tiers.standard.rank, 25);
		assert.equal(result.config.tiers.standard.candidates[0]?.model, "project/standard");
		assert.equal(result.config.tiers.cheap.rank, 10);
		assert.equal(result.loadedPaths.length, 2);
	});

	it("keeps retired tier names syntactically valid for migration", () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "model-tier-router.json"),
			JSON.stringify({
				tiers: {
					"standard-coding": { rank: 30, thinking: "high", candidates: [{ model: "legacy/coding", metered: false }] },
				},
			}),
		);

		const result = loadRouterConfig({ agentDir, cwd, projectTrusted: false });
		assert.equal(result.config.tiers["standard-coding"]?.candidates[0]?.model, "legacy/coding");
	});

	it("ignores an untrusted project override", () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "model-tier-router.json"), JSON.stringify({ enabled: true }));
		writeFileSync(join(cwd, ".pi", "model-tier-router.json"), JSON.stringify({ enabled: false }));

		const result = loadRouterConfig({ agentDir, cwd, projectTrusted: false });
		assert.equal(result.config.enabled, true);
		assert.deepEqual(result.loadedPaths, [join(agentDir, "model-tier-router.json")]);
	});

	it("loads an opt-in usage ledger only from global configuration", () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "model-tier-router.json"), JSON.stringify({ usageLedger: { enabled: true, retentionDays: 14, maxBytes: 4096 } }));
		writeFileSync(join(cwd, ".pi", "model-tier-router.json"), JSON.stringify({ usageLedger: { enabled: false, retentionDays: 7, maxBytes: 2048 } }));

		const result = loadRouterConfig({ agentDir, cwd, projectTrusted: true });
		assert.deepEqual(result.config.usageLedger, { enabled: true, retentionDays: 14, maxBytes: 4096 });
		assert.match(result.warnings.join("\n"), /usageLedger is global-only and was ignored/);
	});

	it("rejects candidates without an explicit metered classification", () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "model-tier-router.json"),
			JSON.stringify({
				tiers: {
					premium: { rank: 40, thinking: "high", candidates: [{ model: "provider/premium" }] },
				},
			}),
		);

		const result = loadRouterConfig({ agentDir, cwd, projectTrusted: false });
		assert.deepEqual(result.config.tiers.premium.candidates, []);
		assert.match(result.warnings.join("\n"), /must declare a boolean metered flag/);
	});
});

describe("path and restoration safety", () => {
	it("canonicalises symlinked skill paths", async () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const skillDir = join(root, "real-skill");
		mkdirSync(skillDir);
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: test\ndescription: test\n---\n");
		symlinkSync(skillDir, join(root, "linked-skill"));
		assert.equal(await canonicalPath("linked-skill/SKILL.md", root), join(skillDir, "SKILL.md"));
	});

	it("suppresses restoration after a manual model override", () => {
		assert.equal(shouldRestoreAfterRun(true, false), true);
		assert.equal(shouldRestoreAfterRun(true, true), false);
		assert.equal(shouldRestoreAfterRun(false, false), false);
	});
});

type EventHandler = (event: any, ctx: any) => unknown;

interface HarnessSkill {
	tier: string;
	rank: number;
	effort?: string;
	costPolicy?: string;
	meteredPolicy?: string;
	metered?: boolean;
	configure?: boolean;
	available?: boolean;
}

interface RouterHarnessOptions {
	clampThinking?: (requested: string, modelId: string) => string;
	confirm?: boolean;
	hasUI?: boolean;
	idle?: boolean;
	restoreAfterRun?: boolean;
	setModelResults?: Record<string, boolean[]>;
}

interface RouterHarness {
	ctx: any;
	emit(event: string, payload?: Record<string, unknown>): Promise<unknown[]>;
	stageSkill(name: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
	startSkill(name: string): Promise<void>;
	invokeSkill(name: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
	loadSkillsForTurn(...names: string[]): Promise<void>;
	readSkill(name: string): Promise<void>;
	invokeCommand(name: string, args?: string): Promise<void>;
	selectManually(next: Model<Api>): Promise<void>;
	setIdle(next: boolean): void;
	confirmations: Array<{ title: string; message: string }>;
	modelSelectionAttempts: string[];
	modelSelections: string[];
	thinkingSelections: string[];
	notifications: string[];
	usageRecords: UsageRecordV1[];
}

async function createRouterHarness(
	skills: Record<string, HarnessSkill>,
	options: RouterHarnessOptions = {},
): Promise<RouterHarness> {
	const root = mkdtempSync(join(tmpdir(), "model-tier-router-events-"));
	const cwd = join(root, "project");
	const skillDir = join(root, "skills");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(skillDir, { recursive: true });

	const commands: Array<Record<string, any>> = [];
	const skillsByName = new Map<string, Skill>();
	const tiers: Record<string, unknown> = {};
	for (const [name, skill] of Object.entries(skills)) {
		const path = join(skillDir, `${name}.md`);
		const routingMetadata = [
			`model-tier: ${skill.tier}`,
			skill.effort ? `effort: ${skill.effort}` : undefined,
			skill.costPolicy ? `model-cost-policy: ${skill.costPolicy}` : undefined,
			skill.meteredPolicy ? `model-metered-policy: ${skill.meteredPolicy}` : undefined,
		].filter((line): line is string => line !== undefined);
		writeFileSync(path, `---\nname: ${name}\ndescription: test\n${routingMetadata.join("\n")}\n---\nRun ${name}.\n`);
		const sourceInfo = {
			path,
			source: "skill",
			scope: "project" as const,
			origin: "top-level" as const,
			baseDir: skillDir,
		};
		commands.push({
			name: `skill:${name}`,
			source: "skill",
			sourceInfo,
		});
		skillsByName.set(name, {
			name,
			description: "test",
			filePath: path,
			baseDir: skillDir,
			sourceInfo,
			disableModelInvocation: false,
		});
		if (skill.configure !== false) {
			tiers[skill.tier] = {
				rank: skill.rank,
				thinking: "high",
				candidates: [{ model: `provider/${skill.tier}`, metered: skill.metered ?? false }],
			};
		}
	}
	writeFileSync(
		join(cwd, ".pi", "model-tier-router.json"),
		JSON.stringify({ enabled: true, routeImplicitSkillReads: true, restoreAfterRun: options.restoreAfterRun ?? true, tiers }),
	);

	const original = model("provider", "original");
	let currentModel = original;
	let thinking = "low";
	const available = [
		original,
		model("provider", "manual"),
		...Object.values(skills)
			.filter((skill) => skill.available !== false)
			.map((skill) => model("provider", skill.tier)),
	];
	const handlers = new Map<string, EventHandler[]>();
	const registeredCommands = new Map<string, { handler: (args: string, ctx: any) => unknown }>();
	const setModelResults = new Map(
		Object.entries(options.setModelResults ?? {}).map(([id, results]) => [id, [...results]]),
	);
	let idle = options.idle ?? true;
	const confirmations: Array<{ title: string; message: string }> = [];
	const modelSelectionAttempts: string[] = [];
	const modelSelections: string[] = [];
	const thinkingSelections: string[] = [];
	const notifications: string[] = [];
	const usageRecords: UsageRecordV1[] = [];

	const ctx = {
		cwd,
		hasUI: options.hasUI ?? true,
		mode: "tui",
		get model() {
			return currentModel;
		},
		modelRegistry: { getAvailable: () => available },
		isIdle: () => idle,
		isProjectTrusted: () => true,
		sessionManager: { getSessionId: () => "test-session" },
		ui: {
			confirm: async (title: string, message: string) => {
				confirmations.push({ title, message });
				return options.confirm ?? true;
			},
			notify: (message: string) => notifications.push(message),
			setStatus: () => undefined,
		},
	};

	async function emit(event: string, payload: Record<string, unknown> = {}): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const handler of handlers.get(event) ?? []) results.push(await handler({ type: event, ...payload }, ctx));
		return results;
	}

	const pi = {
		on(event: string, handler: EventHandler) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: any) => unknown }) {
			registeredCommands.set(name, command);
		},
		getCommands: () => commands,
		getThinkingLevel: () => thinking,
		setThinkingLevel(next: string) {
			thinking = options.clampThinking?.(next, currentModel.id) ?? next;
			thinkingSelections.push(thinking);
		},
		async setModel(next: Model<Api>) {
			const id = `${next.provider}/${next.id}`;
			modelSelectionAttempts.push(id);
			const configuredResults = setModelResults.get(id);
			if ((configuredResults?.shift() ?? true) === false) return false;
			const previousModel = currentModel;
			currentModel = next;
			modelSelections.push(id);
			await emit("model_select", { model: next, previousModel, source: "set" });
			return true;
		},
	} as unknown as ExtensionAPI;

	modelTierRouter(pi, {
		usageLedger: {
			start() {},
			health: () => ({ pending: 0, dropped: 0, writeErrors: 0 }),
			enqueue: (record) => usageRecords.push(record),
			drainWithin: async () => undefined,
			readRecords: async () => ({ records: [...usageRecords], skipped: 0 }),
		},
	});
	await emit("session_start", { reason: "startup" });

	async function stageSkill(name: string, options: { streamingBehavior?: "steer" | "followUp" } = {}): Promise<void> {
		await emit("input", {
			text: `/skill:${name}`,
			source: "interactive",
			streamingBehavior: options.streamingBehavior,
		});
	}

	async function startSkill(name: string): Promise<void> {
		const command = commands.find((item) => item.name === `skill:${name}`);
		assert.ok(command);
		await emit("before_agent_start", {
			prompt: `<skill name="${name}" location="${command.sourceInfo.path}">\nReferences are relative to ${skillDir}.\n\nRun ${name}.\n</skill>`,
			systemPromptOptions: { skills: [] },
		});
	}

	return {
		ctx,
		emit,
		stageSkill,
		startSkill,
		async invokeSkill(name, options = {}) {
			await stageSkill(name, options);
			if (!options.streamingBehavior) await startSkill(name);
		},
		async loadSkillsForTurn(...names) {
			const loaded = names.map((name) => skillsByName.get(name));
			assert.ok(loaded.every((skill) => skill !== undefined));
			await emit("before_agent_start", {
				prompt: "Use a loaded skill when relevant.",
				systemPromptOptions: { skills: loaded },
			});
		},
		async readSkill(name) {
			const skill = skillsByName.get(name);
			assert.ok(skill);
			await emit("tool_call", { toolName: "read", toolCallId: `read-${name}`, input: { path: skill.filePath } });
		},
		async invokeCommand(name, args = "") {
			const command = registeredCommands.get(name);
			assert.ok(command);
			await command.handler(args, ctx);
		},
		async selectManually(next) {
			const previousModel = currentModel;
			currentModel = next;
			await emit("model_select", { model: next, previousModel, source: "set" });
		},
		setIdle(next) {
			idle = next;
		},
		confirmations,
		modelSelectionAttempts,
		modelSelections,
		thinkingSelections,
		notifications,
		usageRecords,
	};
}

describe("extension lifecycle", () => {
	it("stages explicit routing until the expanded skill starts, then restores after settlement", async () => {
		const harness = await createRouterHarness({ review: { tier: "standard", rank: 20, effort: "medium" } });
		await harness.stageSkill("review");
		assert.deepEqual(harness.modelSelections, []);

		await harness.startSkill("review");
		assert.deepEqual(harness.confirmations, []);
		assert.deepEqual(harness.modelSelections, ["provider/standard"]);
		assert.equal(harness.ctx.model.id, "standard");
		assert.match(harness.notifications.join("\n"), /review → standard → provider\/standard \(thinking:medium\)/);

		await harness.emit("agent_settled");
		assert.deepEqual(harness.modelSelections, ["provider/standard", "provider/original"]);
		assert.deepEqual(harness.thinkingSelections, ["medium", "low"]);
		assert.match(harness.notifications.join("\n"), /restored provider\/original \(thinking:low\)/);
	});

	it("simulates idle and non-idle settlement plus registered command invocation", async () => {
		const harness = await createRouterHarness({}, { idle: false });
		assert.equal(harness.ctx.isIdle(), false);
		await harness.emit("agent_settled");

		harness.setIdle(true);
		assert.equal(harness.ctx.isIdle(), true);
		await harness.emit("agent_settled");

		await harness.invokeCommand("model-tier", "status");
		assert.match(harness.notifications.join("\n"), /active tier: \(none\)/);
	});

	it("simulates configured setModel failures without changing the active model", async () => {
		const harness = await createRouterHarness(
			{ review: { tier: "standard", rank: 20 } },
			{ setModelResults: { "provider/standard": [false] } },
		);
		await harness.invokeSkill("review");

		assert.deepEqual(harness.modelSelectionAttempts, ["provider/standard"]);
		assert.deepEqual(harness.modelSelections, []);
		assert.equal(harness.ctx.model.id, "original");
		assert.match(harness.notifications.join("\n"), /could not select provider\/standard/);
	});

	it("requires and captures explicit metered confirmation without skill policy metadata", async () => {
		const harness = await createRouterHarness({
			review: { tier: "premium", rank: 40, metered: true },
		});
		await harness.invokeSkill("review");

		assert.equal(harness.confirmations.length, 1);
		assert.match(harness.confirmations[0]?.message ?? "", /review requests premium → provider\/premium/);
		assert.deepEqual(harness.modelSelections, ["provider/premium"]);
	});

	it("simulates declined and unavailable metered confirmation", async () => {
		const skill = { review: { tier: "premium", rank: 40, metered: true, meteredPolicy: "unrecognised-policy" } };
		const declined = await createRouterHarness(skill, { confirm: false });
		await declined.invokeSkill("review");
		assert.equal(declined.confirmations.length, 1);
		assert.deepEqual(declined.modelSelectionAttempts, []);
		assert.equal(declined.ctx.model.id, "original");
		assert.match(declined.notifications.join("\n"), /declined metered provider\/premium/);

		const headless = await createRouterHarness(skill, { hasUI: false });
		await headless.invokeSkill("review");
		assert.deepEqual(headless.confirmations, []);
		assert.deepEqual(headless.modelSelectionAttempts, []);
		assert.equal(headless.ctx.model.id, "original");
	});

	it("routes an unmetered implicit skill only after its loaded file is read", async () => {
		const harness = await createRouterHarness({ review: { tier: "standard", rank: 20 } });
		await harness.loadSkillsForTurn("review");
		assert.deepEqual(harness.modelSelections, []);

		await harness.readSkill("review");
		assert.deepEqual(harness.confirmations, []);
		assert.deepEqual(harness.modelSelections, ["provider/standard"]);
	});

	it("skips an initial metered implicit skill read without prompting or changing the model", async () => {
		const harness = await createRouterHarness({
			review: { tier: "premium", rank: 40, metered: true },
		});
		await harness.loadSkillsForTurn("review");

		await harness.readSkill("review");

		assert.deepEqual(harness.confirmations, []);
		assert.deepEqual(harness.modelSelectionAttempts, []);
		assert.equal(harness.ctx.model.id, "original");
		assert.match(harness.notifications.join("\n"), /implicit skill reads do not prompt/);
	});

	it("skips a nested metered implicit skill read without prompting or changing the active route", async () => {
		const harness = await createRouterHarness({
			build: { tier: "standard", rank: 20 },
			audit: { tier: "premium", rank: 40, metered: true, meteredPolicy: "ask-above-standard" },
		});
		await harness.invokeSkill("build");
		await harness.loadSkillsForTurn("audit");

		await harness.readSkill("audit");

		assert.deepEqual(harness.confirmations, []);
		assert.deepEqual(harness.modelSelectionAttempts, ["provider/standard"]);
		assert.equal(harness.ctx.model.id, "standard");
		assert.match(harness.notifications.join("\n"), /implicit skill reads do not prompt/);
	});

	it("discards stale routes when a later input handler changes the request", async () => {
		const harness = await createRouterHarness({ review: { tier: "standard", rank: 20 } });
		await harness.stageSkill("review");
		await harness.emit("before_agent_start", { prompt: "A later input handler changed the request", systemPromptOptions: { skills: [] } });

		assert.deepEqual(harness.modelSelections, []);
	});

	it("keeps the active route when a skill is queued during streaming", async () => {
		const harness = await createRouterHarness({
			build: { tier: "standard", rank: 20 },
			audit: { tier: "premium", rank: 40 },
		});
		await harness.invokeSkill("build");
		await harness.stageSkill("audit", { streamingBehavior: "followUp" });

		assert.deepEqual(harness.modelSelections, ["provider/standard"]);
		assert.equal(harness.ctx.model.id, "standard");
		assert.match(harness.notifications.join("\n"), /skipped routing queued \/skill:audit/);

		await harness.emit("agent_settled");
		assert.equal(harness.ctx.model.id, "original");
	});

	it("raises nested effort without downgrading the active model or thinking", async () => {
		const harness = await createRouterHarness({
			build: { tier: "standard", rank: 30, effort: "medium" },
			"deep-check": { tier: "cheap", rank: 10, effort: "xhigh" },
			"quick-check": { tier: "cheap", rank: 10, effort: "low" },
		});
		await harness.invokeSkill("build");
		await harness.invokeSkill("deep-check");
		await harness.invokeSkill("quick-check");

		assert.deepEqual(harness.modelSelections, ["provider/standard"]);
		assert.deepEqual(harness.thinkingSelections, ["medium", "xhigh"]);
		assert.match(harness.notifications.join("\n"), /raised thinking to xhigh for nested deep-check/);
		assert.equal(harness.ctx.model.id, "standard");
	});

	it("preserves requested effort across model-specific clamping and later upgrades", async () => {
		const harness = await createRouterHarness(
			{
				deep: { tier: "limited", rank: 20, effort: "xhigh" },
				upgrade: { tier: "capable", rank: 40, effort: "low" },
			},
			{
				clampThinking: (requested, modelId) => modelId === "limited" && requested === "xhigh" ? "high" : requested,
			},
		);
		await harness.invokeSkill("deep");
		await harness.invokeSkill("upgrade");

		assert.deepEqual(harness.modelSelections, ["provider/limited", "provider/capable"]);
		assert.deepEqual(harness.thinkingSelections, ["high", "xhigh"]);
	});

	it("raises effort even when a higher-tier model is unavailable", async () => {
		const harness = await createRouterHarness({
			build: { tier: "standard", rank: 30, effort: "medium" },
			audit: { tier: "unavailable", rank: 40, effort: "xhigh", available: false },
		});
		await harness.invokeSkill("build");
		await harness.invokeSkill("audit");

		assert.deepEqual(harness.modelSelections, ["provider/standard"]);
		assert.deepEqual(harness.thinkingSelections, ["medium", "xhigh"]);
		assert.equal(harness.ctx.model.id, "standard");
	});

	it("does not route nested skills after a manual model selection", async () => {
		const harness = await createRouterHarness({
			build: { tier: "standard", rank: 20 },
			audit: { tier: "premium", rank: 40 },
		});
		await harness.invokeSkill("build");
		await harness.selectManually(model("provider", "manual"));
		await harness.invokeSkill("audit");

		assert.deepEqual(harness.modelSelections, ["provider/standard"]);
		assert.equal(harness.ctx.model.id, "manual");
		assert.match(harness.notifications.join("\n"), /skipped audit after a manual model selection/);

		await harness.emit("agent_settled");
		assert.equal(harness.ctx.model.id, "manual");
	});

	it("attributes finalized responses across a nested tier upgrade", async () => {
		const harness = await createRouterHarness({
			build: { tier: "standard", rank: 20 },
			audit: { tier: "premium", rank: 40 },
		});
		await harness.invokeSkill("build");
		await harness.emit("message_end", { message: assistantMessage("provider", "standard") });
		await harness.invokeSkill("audit");
		await harness.emit("message_end", { message: assistantMessage("provider", "premium") });

		assert.equal(harness.usageRecords.length, 2);
		assert.equal(harness.usageRecords[0]?.tier, "standard");
		assert.equal(harness.usageRecords[1]?.tier, "premium");
		assert.equal(harness.usageRecords[0]?.routeRunId, harness.usageRecords[1]?.routeRunId);
		assert.deepEqual(harness.usageRecords.map((record) => record.responseIndex), [1, 2]);
		assert.deepEqual(harness.usageRecords[1]?.routedSkills, ["build", "audit"]);
	});

	it("starts fresh attribution for each run when restoration is disabled", async () => {
		const harness = await createRouterHarness({ build: { tier: "standard", rank: 20 } }, { restoreAfterRun: false });
		await harness.invokeSkill("build");
		await harness.emit("message_end", { message: assistantMessage("provider", "standard") });
		await harness.emit("agent_settled");
		await harness.invokeSkill("build");
		await harness.emit("message_end", { message: assistantMessage("provider", "standard") });

		assert.equal(harness.usageRecords.length, 2);
		assert.notEqual(harness.usageRecords[0]?.routeRunId, harness.usageRecords[1]?.routeRunId);
		assert.deepEqual(harness.usageRecords.map((record) => record.responseIndex), [1, 1]);
	});

	it("stops attribution after a manual override or settlement", async () => {
		const harness = await createRouterHarness({ build: { tier: "standard", rank: 20 } });
		await harness.invokeSkill("build");
		await harness.selectManually(model("provider", "manual"));
		await harness.emit("message_end", { message: assistantMessage("provider", "manual") });
		assert.equal(harness.usageRecords.length, 0);

		const settled = await createRouterHarness({ build: { tier: "standard", rank: 20 } });
		await settled.invokeSkill("build");
		await settled.emit("agent_settled");
		await settled.emit("message_end", { message: assistantMessage("provider", "original") });
		assert.equal(settled.usageRecords.length, 0);
	});

	it("treats inherited object keys as unknown tiers", async () => {
		const harness = await createRouterHarness({ inherited: { tier: "toString", rank: 20, configure: false } });
		await harness.invokeSkill("inherited");

		assert.deepEqual(harness.modelSelections, []);
		assert.match(harness.notifications.join("\n"), /unknown or unconfigured tier toString/);
	});
});
