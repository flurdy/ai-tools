import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { acquireWorktreeLease, type HeldWorktreeLease, type WorktreeLeaseResult } from "./lease.ts";
import { guardedToolBlockReason, isObviousMutation } from "./policy.ts";

export type SessionMode = "implement" | "plan";
export type SessionGuardState = "acquiring" | "implement" | "plan" | "implement-blocked" | "lost" | "unguarded";

interface PersistedSessionMode {
	version: 1;
	mode: SessionMode;
}

export interface SessionModeDependencies {
	acquireLease(cwd: string, options: { sessionId: string }): Promise<WorktreeLeaseResult>;
	isDisabled(): boolean;
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
	},
): SessionModeController {
	let mode: SessionMode = "implement";
	let state: SessionGuardState = "acquiring";
	let lease: HeldWorktreeLease | undefined;
	let toolsBeforeGuard: string[] | undefined;
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

	function persistMode(): void {
		pi.appendEntry("session-mode", { version: 1, mode } satisfies PersistedSessionMode);
	}

	function guardLostLease(ctx: ExtensionContext, held: HeldWorktreeLease): void {
		void held.lost.then(() => {
			if (shuttingDown || lease !== held) return;
			lease = undefined;
			guardTools();
			setState(ctx, "lost");
			ctx.ui.notify("Worktree lease was lost. This session is now guarded.", "error");
		});
	}

	async function enterImplement(ctx: ExtensionContext): Promise<void> {
		mode = "implement";
		if (dependencies.isDisabled()) {
			const held = lease;
			lease = undefined;
			if (held) await held.release();
			restoreTools();
			setState(ctx, "unguarded");
			ctx.ui.notify("Session guard disabled by PI_SESSION_GUARD=0.", "warning");
			return;
		}
		if (lease && state === "implement") return;

		guardTools();
		setState(ctx, "acquiring");
		const result = await dependencies.acquireLease(ctx.cwd, { sessionId: ctx.sessionManager.getSessionId() });
		if (result.kind === "held") {
			lease = result;
			guardLostLease(ctx, result);
			restoreTools();
			setState(ctx, "implement");
			return;
		}
		if (result.kind === "contended") {
			setState(ctx, "implement-blocked");
			const holder = result.holder ? ` Holder session: ${result.holder.sessionId} (pid ${result.holder.pid}).` : "";
			ctx.ui.notify(`Another live session holds this worktree lease.${holder}`, "error");
			return;
		}

		restoreTools();
		setState(ctx, "unguarded");
		ctx.ui.notify(`Session guard unavailable (${result.reason}). This session is unguarded.`, "error");
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
			if (held) await held.release();
			await warnIfDirty(ctx);
			persistMode();
		},
	});

	pi.registerCommand("implement", {
		description: "Acquire the worktree lease before enabling implementation tools",
		handler: async (_args, ctx) => {
			if (rejectBusyTransition(ctx)) return;
			await enterImplement(ctx);
			persistMode();
		},
	});

	pi.on("tool_call", (event) => {
		if (state !== "plan" && state !== "implement-blocked" && state !== "lost" && state !== "acquiring") return;
		const directReason = guardedToolBlockReason(event.toolName);
		if (directReason) return { block: true, reason: directReason };
		if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown }).command;
			if (typeof command === "string" && isObviousMutation(command)) {
				return {
					block: true,
					reason: "Guarded session: obvious source, Git, package, system, or remote Beads mutation blocked. Use /implement first.",
				};
			}
		}
	});

	pi.on("before_agent_start", (event) => {
		if (state !== "plan" && state !== "implement-blocked" && state !== "lost") return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n[GUARDED SESSION]\nDo not modify files or repository state. Read-only analysis and ordinary local Beads triage are allowed. Ask the user to switch to /implement before source changes.`,
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
			setState(ctx, "plan");
			return;
		}
		await enterImplement(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true;
		const held = lease;
		lease = undefined;
		if (held) await held.release();
		restoreTools();
		ctx.ui.setStatus("session-mode", undefined);
	});

	return {
		get mode() { return mode; },
		get state() { return state; },
	};
}
