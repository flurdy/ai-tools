import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { acquireWorktreeLease, type HeldWorktreeLease, type WorktreeLeaseResult } from "./lease.ts";
import { guardedToolBlockReason } from "./policy.ts";
import { verifiedReadOnlySubagents } from "./subagent-policy.ts";

export type SessionMode = "implement" | "plan";
export type SessionGuardState = "acquiring" | "implement" | "plan" | "implement-blocked" | "lost" | "unguarded";

interface PersistedSessionMode {
	version: 1;
	mode: SessionMode;
}

export interface SessionModeDependencies {
	acquireLease(cwd: string, options: { sessionId: string }): Promise<WorktreeLeaseResult>;
	isDisabled(): boolean;
	readOnlySubagents(cwd: string, preferredProvider?: string): Promise<ReadonlySet<string>>;
}

export interface SessionModeController {
	readonly mode: SessionMode;
	readonly state: SessionGuardState;
}

const STATE_LABELS: Record<SessionGuardState, string> = {
	acquiring: "acquiring",
	implement: "implement",
	plan: "plan",
	"implement-blocked": "conflict",
	lost: "lost",
	unguarded: "unguarded",
};

const STATE_TONES: Record<SessionGuardState, "success" | "warning" | "error"> = {
	acquiring: "warning",
	implement: "success",
	plan: "warning",
	"implement-blocked": "error",
	lost: "error",
	unguarded: "error",
};

function restoredMode(ctx: ExtensionContext): SessionMode | undefined {
	for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
		if (entry.type !== "custom" || entry.customType !== "session-mode") continue;
		const data = entry.data as Partial<PersistedSessionMode> | undefined;
		if (data?.version === 1 && (data.mode === "implement" || data.mode === "plan")) return data.mode;
	}
	return undefined;
}

export function registerSessionMode(
	pi: ExtensionAPI,
	dependencies: SessionModeDependencies = {
		acquireLease: (cwd, options) => acquireWorktreeLease(cwd, options),
		isDisabled: () => process.env.PI_SESSION_GUARD === "0",
		readOnlySubagents: (cwd, preferredProvider) => verifiedReadOnlySubagents(cwd, { preferredProvider }),
	},
): SessionModeController {
	let mode: SessionMode = "implement";
	let state: SessionGuardState = "acquiring";
	let lease: HeldWorktreeLease | undefined;
	let toolsBeforeGuard: string[] | undefined;
	let readOnlySubagents: ReadonlySet<string> = new Set();
	let readOnlySubagentGeneration = 0;
	let transitionGeneration = 0;
	let inFlightAcquisition: Promise<WorktreeLeaseResult> | undefined;
	let releaseBarrier: Promise<void> = Promise.resolve();
	const releases = new WeakMap<HeldWorktreeLease, Promise<void>>();
	let shuttingDown = false;

	pi.registerFlag("plan", {
		description: "Start in guarded plan mode without acquiring the worktree lease",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("implement", {
		description: "Start in implementation mode after acquiring the worktree lease",
		type: "boolean",
		default: false,
	});

	function setState(ctx: ExtensionContext, next: SessionGuardState): void {
		state = next;
		ctx.ui.setStatus("session-mode", ctx.ui.theme.fg(STATE_TONES[next], STATE_LABELS[next]));
	}

	function guardTools(): void {
		if (toolsBeforeGuard === undefined) toolsBeforeGuard = pi.getActiveTools();
		pi.setActiveTools(toolsBeforeGuard.filter((name) => name !== "edit" && name !== "write"));
	}

	function restoreTools(): void {
		if (toolsBeforeGuard === undefined) return;
		pi.setActiveTools(toolsBeforeGuard);
		toolsBeforeGuard = undefined;
	}

	function releaseHeld(held: HeldWorktreeLease): Promise<void> {
		const existing = releases.get(held);
		if (existing) return existing;
		const release = held.release();
		releaseBarrier = Promise.all([releaseBarrier, release]).then(() => undefined);
		releases.set(held, releaseBarrier);
		return releaseBarrier;
	}

	function persistMode(): void {
		pi.appendEntry("session-mode", { version: 1, mode } satisfies PersistedSessionMode);
	}

	async function refreshReadOnlySubagents(cwd: string, preferredProvider?: string): Promise<void> {
		const generation = ++readOnlySubagentGeneration;
		try {
			const verified = await dependencies.readOnlySubagents(cwd, preferredProvider);
			if (generation === readOnlySubagentGeneration) readOnlySubagents = verified;
		} catch {
			if (generation === readOnlySubagentGeneration) readOnlySubagents = new Set();
		}
	}

	function guardLostLease(ctx: ExtensionContext, held: HeldWorktreeLease): void {
		void held.lost.then(async () => {
			if (shuttingDown || lease !== held) return;
			lease = undefined;
			state = "lost";
			guardTools();
			setState(ctx, "lost");
			await refreshReadOnlySubagents(ctx.cwd, ctx.model?.provider);
			ctx.ui.notify("Worktree lease was lost. This session is now guarded.", "error");
		}).catch(() => {
			if (shuttingDown || state !== "lost") return;
			try {
				ctx.ui.setStatus("session-mode", ctx.ui.theme.fg(STATE_TONES.lost, STATE_LABELS.lost));
			} catch {
				// Lease loss is already enforced; status reporting is best effort.
			}
		});
	}

	function isCurrentImplement(generation: number): boolean {
		return generation === transitionGeneration && mode === "implement" && state === "acquiring" && !shuttingDown;
	}

	function isCurrentPlan(generation: number): boolean {
		return generation === transitionGeneration && mode === "plan" && !shuttingDown;
	}

	async function enterImplement(ctx: ExtensionContext): Promise<boolean> {
		const generation = ++transitionGeneration;
		mode = "implement";
		if (dependencies.isDisabled()) {
			const held = lease;
			lease = undefined;
			if (held) await releaseHeld(held);
			if (generation !== transitionGeneration || mode !== "implement" || shuttingDown) return false;
			restoreTools();
			setState(ctx, "unguarded");
			ctx.ui.notify("Session guard disabled by PI_SESSION_GUARD=0.", "warning");
			return true;
		}
		if (lease && state === "implement") return true;

		guardTools();
		setState(ctx, "acquiring");
		await releaseBarrier;
		if (!isCurrentImplement(generation)) return false;
		const acquisition = inFlightAcquisition
			?? dependencies.acquireLease(ctx.cwd, { sessionId: ctx.sessionManager.getSessionId() });
		inFlightAcquisition = acquisition;
		let result: WorktreeLeaseResult;
		try {
			result = await acquisition;
		} catch (error) {
			if (inFlightAcquisition === acquisition) inFlightAcquisition = undefined;
			throw error;
		}

		if (!isCurrentImplement(generation)) {
			const newerImplementOwnsResult = mode === "implement" && state === "acquiring" && !shuttingDown;
			if (!newerImplementOwnsResult) {
				if (inFlightAcquisition === acquisition) inFlightAcquisition = undefined;
				if (result.kind === "held") await releaseHeld(result);
			}
			return false;
		}
		if (inFlightAcquisition === acquisition) inFlightAcquisition = undefined;

		if (result.kind === "held") {
			lease = result;
			guardLostLease(ctx, result);
			readOnlySubagents = new Set();
			restoreTools();
			setState(ctx, "implement");
			return true;
		}
		if (result.kind === "contended") {
			await refreshReadOnlySubagents(ctx.cwd, ctx.model?.provider);
			if (!isCurrentImplement(generation)) return false;
			setState(ctx, "implement-blocked");
			const holder = result.holder ? ` Holder session: ${result.holder.sessionId} (pid ${result.holder.pid}).` : "";
			ctx.ui.notify(`Another live session holds this worktree lease.${holder}`, "error");
			return true;
		}

		restoreTools();
		setState(ctx, "unguarded");
		ctx.ui.notify(`Session guard unavailable (${result.reason}). This session is unguarded.`, "error");
		return true;
	}

	async function warnIfDirty(ctx: ExtensionContext): Promise<void> {
		try {
			const result = await pi.exec("git", ["-C", ctx.cwd, "status", "--porcelain"]);
			if (result.code === 0 && result.stdout.trim()) {
				ctx.ui.notify("Entering plan mode with a dirty worktree; existing changes remain on disk.", "warning");
			}
		} catch {
			// Dirty-state reporting is advisory; mode transition and lease release still proceed.
		}
	}

	function rejectBusyTransition(ctx: ExtensionContext): boolean {
		if (ctx.isIdle() && !ctx.hasPendingMessages()) return false;
		ctx.ui.notify("Cannot change session mode while Pi is busy.", "warning");
		return true;
	}

	pi.registerCommand("plan", {
		description: "Enter guarded plan mode and release the worktree lease",
		handler: async (_args, ctx) => {
			if (rejectBusyTransition(ctx)) return;
			const generation = ++transitionGeneration;
			mode = "plan";
			if (dependencies.isDisabled()) {
				restoreTools();
				setState(ctx, "unguarded");
			} else {
				guardTools();
				setState(ctx, "plan");
			}
			const held = lease;
			lease = undefined;
			if (held) await releaseHeld(held);
			if (!isCurrentPlan(generation)) return;
			await refreshReadOnlySubagents(ctx.cwd, ctx.model?.provider);
			if (!isCurrentPlan(generation)) return;
			await warnIfDirty(ctx);
			if (isCurrentPlan(generation)) persistMode();
		},
	});

	pi.registerCommand("implement", {
		description: "Acquire the worktree lease before enabling implementation tools",
		handler: async (_args, ctx) => {
			if (rejectBusyTransition(ctx)) return;
			if (await enterImplement(ctx)) persistMode();
		},
	});

	pi.on("tool_call", (event) => {
		if (state !== "plan" && state !== "implement-blocked" && state !== "lost" && state !== "acquiring") return;
		const reason = guardedToolBlockReason(event.toolName, event.input, { readOnlySubagents });
		if (reason) return { block: true, reason };
	});

	pi.on("model_select", (event, ctx) => {
		readOnlySubagents = new Set();
		void refreshReadOnlySubagents(ctx.cwd, event.model.provider);
	});

	pi.on("before_agent_start", (event) => {
		if (state !== "plan" && state !== "implement-blocked" && state !== "lost") return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n[GUARDED SESSION]\nDo not modify files or repository state. Read-only analysis, ordinary local Beads triage, safe subagent management, and verified direct read-only reviewers are allowed. Dynamic subagent workflows and writer agents remain blocked. Ask the user to switch to /implement before source changes.`,
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false;
		mode = pi.getFlag("plan") === true ? "plan" : pi.getFlag("implement") === true ? "implement" : (restoredMode(ctx) ?? "implement");
		if (dependencies.isDisabled()) {
			restoreTools();
			setState(ctx, "unguarded");
			ctx.ui.notify("Session guard disabled by PI_SESSION_GUARD=0.", "warning");
			return;
		}
		if (mode === "plan") {
			guardTools();
			await refreshReadOnlySubagents(ctx.cwd, ctx.model?.provider);
			setState(ctx, "plan");
			return;
		}
		await enterImplement(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true;
		transitionGeneration += 1;
		const pendingAcquisition = inFlightAcquisition;
		const held = lease;
		lease = undefined;
		if (held) await releaseHeld(held);
		if (pendingAcquisition) {
			try {
				const result = await pendingAcquisition;
				if (result.kind === "held") await releaseHeld(result);
			} catch {
				// Acquisition failure already leaves the session without write authority.
			}
			if (inFlightAcquisition === pendingAcquisition) inFlightAcquisition = undefined;
		}
		await releaseBarrier;
		readOnlySubagentGeneration += 1;
		readOnlySubagents = new Set();
		restoreTools();
		ctx.ui.setStatus("session-mode", undefined);
	});

	return {
		get mode() { return mode; },
		get state() { return state; },
	};
}
