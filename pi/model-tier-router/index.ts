import { readFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Skill } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { loadRouterConfig, type LoadedRouterConfig } from "./config.ts";
import {
	canonicalPath,
	decideTier,
	findExactModel,
	parseSkillRouting,
	requiresMeteredConfirmation,
	selectCandidate,
	shouldRestoreAfterRun,
	type SkillRoutingMetadata,
	type ThinkingLevel,
} from "./routing.ts";

const STATUS_KEY = "model-tier-router";

interface RunState {
	originalModel: Model<Api> | undefined;
	originalThinking: ThinkingLevel;
	activeTier: string;
	activeRank: number;
	routedSkills: string[];
	manualModelOverride: boolean;
	restorePending: boolean;
}

function modelId(model: Model<Api> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "(none)";
}

export default function modelTierRouter(pi: ExtensionAPI): void {
	let loaded: LoadedRouterConfig | undefined;
	let enabledOverride: boolean | undefined;
	let run: RunState | undefined;
	let switchingModel = false;
	let loadedSkills = new Map<string, Skill>();
	const warningKeys = new Set<string>();
	const unavailableWarnings: string[] = [];

	function isEnabled(): boolean {
		return enabledOverride ?? loaded?.config.enabled ?? true;
	}

	function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	}

	function warnOnce(ctx: ExtensionContext, key: string, message: string): void {
		if (warningKeys.has(key)) return;
		warningKeys.add(key);
		unavailableWarnings.push(message);
		notify(ctx, `model-tier: ${message}`, "warning");
	}

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(STATUS_KEY, run ? `tier:${run.activeTier}${run.restorePending ? ":restore-pending" : ""}` : undefined);
	}

	function reloadConfig(ctx: ExtensionContext): void {
		loaded = loadRouterConfig({
			agentDir: getAgentDir(),
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
			configDirName: CONFIG_DIR_NAME,
		});
		for (const warning of loaded.warnings) notify(ctx, `model-tier: ${warning}`, "warning");
	}

	function readMetadata(path: string, ctx: ExtensionContext): SkillRoutingMetadata | undefined {
		try {
			return parseSkillRouting(readFileSync(path, "utf8"));
		} catch (error) {
			warnOnce(ctx, `skill:${path}`, `could not read skill metadata from ${path}: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	}

	async function routeSkill(skillName: string, path: string, ctx: ExtensionContext): Promise<void> {
		if (!isEnabled() || !loaded) return;
		if (run?.restorePending) {
			warnOnce(ctx, "restore-pending", `skipped ${skillName} while restoration of ${modelId(run.originalModel)} is pending`);
			return;
		}
		const metadata = readMetadata(path, ctx);
		if (!metadata?.tier) return;

		const route = loaded.config.tiers[metadata.tier];
		if (!route) {
			warnOnce(ctx, `tier:${metadata.tier}`, `unknown or unconfigured tier ${metadata.tier}; retained ${modelId(ctx.model)}`);
			return;
		}

		const decision = decideTier(run ? { tier: run.activeTier, rank: run.activeRank } : undefined, {
			tier: metadata.tier,
			rank: route.rank,
		});
		if (decision === "retain-lower" || decision === "retain-equal") {
			if (run && !run.routedSkills.includes(skillName)) run.routedSkills.push(skillName);
			if (decision === "retain-lower") {
				notify(ctx, `model-tier: retained ${run?.activeTier}; ignored nested ${metadata.tier}`, "info");
			}
			return;
		}

		const available = ctx.modelRegistry.getAvailable();
		const candidate = selectCandidate(route, available);
		const target = candidate ? findExactModel(candidate, available) : undefined;
		if (!candidate || !target) {
			warnOnce(ctx, `unavailable:${metadata.tier}`, `no available candidate for ${metadata.tier}; retained ${modelId(ctx.model)}`);
			return;
		}

		if (requiresMeteredConfirmation(candidate, metadata)) {
			if (!ctx.hasUI) {
				warnOnce(ctx, `metered:${metadata.tier}`, `skipped metered ${candidate.model} for ${metadata.tier} because no confirmation UI is available`);
				return;
			}
			const policies = [metadata.costPolicy, metadata.meteredPolicy].filter(Boolean).join(", ");
			const confirmed = await ctx.ui.confirm(
				"Use metered model?",
				`${skillName} requests ${metadata.tier} → ${candidate.model}${policies ? ` (${policies})` : ""}. Continue?`,
			);
			if (!confirmed) {
				warnOnce(ctx, `metered:${metadata.tier}`, `declined metered ${candidate.model} for ${metadata.tier}`);
				return;
			}
		}

		const originalModel = run?.originalModel ?? ctx.model;
		const originalThinking = run?.originalThinking ?? pi.getThinkingLevel();
		switchingModel = true;
		let switched = false;
		try {
			switched = await pi.setModel(target);
			if (switched) pi.setThinkingLevel(route.thinking);
		} finally {
			switchingModel = false;
		}
		if (!switched) {
			warnOnce(ctx, `switch:${candidate.model}`, `could not select ${candidate.model}; retained ${modelId(ctx.model)}`);
			return;
		}

		if (!run) {
			run = {
				originalModel,
				originalThinking,
				activeTier: metadata.tier,
				activeRank: route.rank,
				routedSkills: [skillName],
				manualModelOverride: false,
				restorePending: false,
			};
		} else {
			run.activeTier = metadata.tier;
			run.activeRank = route.rank;
			if (!run.routedSkills.includes(skillName)) run.routedSkills.push(skillName);
		}
		updateStatus(ctx);
		notify(ctx, `model-tier: ${skillName} → ${metadata.tier} → ${candidate.model}`, "info");
	}

	async function restore(ctx: ExtensionContext, announce: boolean): Promise<void> {
		const state = run;
		if (!state || !loaded) return;
		const shouldRestore = shouldRestoreAfterRun(loaded.config.restoreAfterRun, state.manualModelOverride);
		if (!shouldRestore) {
			run = undefined;
			updateStatus(ctx);
			return;
		}

		switchingModel = true;
		let restored = false;
		try {
			restored = state.originalModel ? await pi.setModel(state.originalModel) : true;
			if (restored) pi.setThinkingLevel(state.originalThinking);
		} finally {
			switchingModel = false;
		}
		if (restored) {
			run = undefined;
			if (announce) notify(ctx, `model-tier: restored ${modelId(state.originalModel)}`, "info");
		} else {
			state.restorePending = true;
			notify(ctx, `model-tier: could not restore ${modelId(state.originalModel)}; will retry when the agent next settles`, "warning");
		}
		updateStatus(ctx);
	}

	pi.on("session_start", (_event, ctx) => {
		reloadConfig(ctx);
		updateStatus(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || !isEnabled()) return { action: "continue" };
		const match = event.text.match(/^\/(skill:[^\s]+)(?:\s|$)/);
		if (!match) return { action: "continue" };
		const invocation = match[1];
		const command = pi.getCommands().find((item) => {
			const name = (item as typeof item & { invocationName?: string }).invocationName ?? item.name;
			const source = (item as typeof item & { source?: string }).source ?? item.sourceInfo.source;
			return name === invocation && source === "skill";
		});
		if (command) await routeSkill(invocation.slice("skill:".length), command.sourceInfo.path, ctx);
		return { action: "continue" };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const entries = await Promise.all(
			(event.systemPromptOptions.skills ?? []).map(async (skill) => {
				const path = await canonicalPath(skill.filePath, ctx.cwd);
				return path ? ([path, skill] as const) : undefined;
			}),
		);
		loadedSkills = new Map(entries.filter((entry): entry is readonly [string, Skill] => entry !== undefined));
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!isEnabled() || !loaded?.config.routeImplicitSkillReads || !isToolCallEventType("read", event)) return;
		const path = await canonicalPath(event.input.path, ctx.cwd);
		if (!path) return;
		const skill = loadedSkills.get(path);
		if (skill) await routeSkill(skill.name, skill.filePath, ctx);
	});

	pi.on("model_select", (event, ctx) => {
		if (!run || switchingModel || event.source === "restore") return;
		run.manualModelOverride = true;
		if (run.restorePending) {
			run = undefined;
			updateStatus(ctx);
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		await restore(ctx, true);
		loadedSkills.clear();
		warningKeys.clear();
		unavailableWarnings.length = 0;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		await restore(ctx, false);
		loadedSkills.clear();
	});

	pi.registerCommand("model-tier", {
		description: "Show, reload, enable, or disable model-tier routing",
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (action === "reload") {
				enabledOverride = undefined;
				reloadConfig(ctx);
				notify(ctx, `model-tier: reloaded ${loaded?.loadedPaths.join(", ") || "defaults"}`, "info");
				return;
			}
			if (action === "on" || action === "off") {
				enabledOverride = action === "on";
				notify(ctx, `model-tier: ${action}`, "info");
				return;
			}
			if (action !== "status") {
				notify(ctx, "Usage: /model-tier status|reload|on|off", "warning");
				return;
			}
			const lines = [
				`enabled: ${isEnabled()}`,
				`active tier: ${run?.activeTier ?? "(none)"}`,
				`skills: ${run?.routedSkills.join(", ") || "(none)"}`,
				`selected model: ${modelId(ctx.model)}`,
				`original model: ${modelId(run?.originalModel)}`,
				`restoration pending: ${Boolean(run && loaded?.config.restoreAfterRun && !run.manualModelOverride)}`,
				`restoration retry pending: ${run?.restorePending ?? false}`,
				`manual model override: ${run?.manualModelOverride ?? false}`,
				`config: ${loaded?.loadedPaths.join(", ") || "defaults"}`,
				`warnings: ${unavailableWarnings.join("; ") || "(none)"}`,
			];
			notify(ctx, lines.join("\n"), "info");
		},
	});
}
