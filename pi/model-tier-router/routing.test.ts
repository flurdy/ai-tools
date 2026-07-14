import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadRouterConfig } from "./config.ts";
import modelTierRouter from "./index.ts";
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
	it("requires metered confirmation only when skill policy asks for it", () => {
		const metered = { model: "provider/premium", metered: true };
		assert.equal(requiresMeteredConfirmation(metered, {}), false);
		assert.equal(requiresMeteredConfirmation(metered, { meteredPolicy: "ask-above-standard" }), true);
		assert.equal(requiresMeteredConfirmation(metered, { meteredPolicy: "cap-or-ask" }), true);
		assert.equal(requiresMeteredConfirmation(metered, { meteredPolicy: "ask-before-metered-panel" }), true);
		assert.equal(requiresMeteredConfirmation(metered, { costPolicy: "deliberate-premium" }), true);
		assert.equal(requiresMeteredConfirmation(metered, { meteredPolicy: "never" }), false);
		assert.equal(requiresMeteredConfirmation({ ...metered, metered: false }, { costPolicy: "deliberate-premium" }), false);
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

interface RouterHarness {
	ctx: any;
	emit(event: string, payload?: Record<string, unknown>): Promise<unknown[]>;
	stageSkill(name: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
	startSkill(name: string): Promise<void>;
	invokeSkill(name: string, options?: { streamingBehavior?: "steer" | "followUp" }): Promise<void>;
	selectManually(next: Model<Api>): Promise<void>;
	modelSelections: string[];
	thinkingSelections: string[];
	notifications: string[];
}

async function createRouterHarness(
	skills: Record<string, { tier: string; rank: number; effort?: string; configure?: boolean; available?: boolean }>,
	options: { clampThinking?: (requested: string, modelId: string) => string } = {},
): Promise<RouterHarness> {
	const root = mkdtempSync(join(tmpdir(), "model-tier-router-events-"));
	const cwd = join(root, "project");
	const skillDir = join(root, "skills");
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	mkdirSync(skillDir, { recursive: true });

	const commands: Array<Record<string, any>> = [];
	const tiers: Record<string, unknown> = {};
	for (const [name, skill] of Object.entries(skills)) {
		const path = join(skillDir, `${name}.md`);
		writeFileSync(
			path,
			`---\nname: ${name}\ndescription: test\nmodel-tier: ${skill.tier}${skill.effort ? `\neffort: ${skill.effort}` : ""}\n---\nRun ${name}.\n`,
		);
		commands.push({
			name: `skill:${name}`,
			source: "skill",
			sourceInfo: { path, source: "skill", scope: "project", origin: "top-level" },
		});
		if (skill.configure !== false) {
			tiers[skill.tier] = {
				rank: skill.rank,
				thinking: "high",
				candidates: [{ model: `provider/${skill.tier}`, metered: false }],
			};
		}
	}
	writeFileSync(
		join(cwd, ".pi", "model-tier-router.json"),
		JSON.stringify({ enabled: true, routeImplicitSkillReads: true, restoreAfterRun: true, tiers }),
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
	const modelSelections: string[] = [];
	const thinkingSelections: string[] = [];
	const notifications: string[] = [];

	const ctx = {
		cwd,
		hasUI: true,
		mode: "tui",
		get model() {
			return currentModel;
		},
		modelRegistry: { getAvailable: () => available },
		isProjectTrusted: () => true,
		ui: {
			confirm: async () => true,
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
		registerCommand() {},
		getCommands: () => commands,
		getThinkingLevel: () => thinking,
		setThinkingLevel(next: string) {
			thinking = options.clampThinking?.(next, currentModel.id) ?? next;
			thinkingSelections.push(thinking);
		},
		async setModel(next: Model<Api>) {
			const previousModel = currentModel;
			currentModel = next;
			modelSelections.push(`${next.provider}/${next.id}`);
			await emit("model_select", { model: next, previousModel, source: "set" });
			return true;
		},
	} as unknown as ExtensionAPI;

	modelTierRouter(pi);
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
		async selectManually(next) {
			const previousModel = currentModel;
			currentModel = next;
			await emit("model_select", { model: next, previousModel, source: "set" });
		},
		modelSelections,
		thinkingSelections,
		notifications,
	};
}

describe("extension lifecycle", () => {
	it("stages explicit routing until the expanded skill starts, then restores after settlement", async () => {
		const harness = await createRouterHarness({ review: { tier: "standard", rank: 20, effort: "medium" } });
		await harness.stageSkill("review");
		assert.deepEqual(harness.modelSelections, []);

		await harness.startSkill("review");
		assert.deepEqual(harness.modelSelections, ["provider/standard"]);
		assert.equal(harness.ctx.model.id, "standard");

		await harness.emit("agent_settled");
		assert.deepEqual(harness.modelSelections, ["provider/standard", "provider/original"]);
		assert.deepEqual(harness.thinkingSelections, ["medium", "low"]);
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

	it("treats inherited object keys as unknown tiers", async () => {
		const harness = await createRouterHarness({ inherited: { tier: "toString", rank: 20, configure: false } });
		await harness.invokeSkill("inherited");

		assert.deepEqual(harness.modelSelections, []);
		assert.match(harness.notifications.join("\n"), /unknown or unconfigured tier toString/);
	});
});
