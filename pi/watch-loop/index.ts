import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import {
	WATCH_LOOP_PROTOCOL_VERSION,
	createIdleState,
	reduceWatchLoop,
	type WatchEvent,
	type WatchLoopState,
	type WatchOperationResult,
	type WatchStartConfig,
	type WatchTransition,
} from "./watch-loop.ts";

const STATUS_KEY = "pi-watch-loop";

const watchLoopParameters = Type.Object({
	action: StringEnum(["status", "start", "complete", "stop"] as const),
	protocolVersion: Type.Optional(Type.Integer()),
	watchId: Type.Optional(Type.String()),
	generation: Type.Optional(Type.Integer()),
	label: Type.Optional(Type.String()),
	tickPrompt: Type.Optional(Type.String()),
	mode: Type.Optional(StringEnum(["fixed", "adaptive"] as const)),
	initialDelaySeconds: Type.Optional(Type.Number()),
	intervalSeconds: Type.Optional(Type.Number()),
	missedCompletionPolicy: Type.Optional(StringEnum(["pause", "retry"] as const)),
	stopAt: Type.Optional(Type.String()),
	maxTicks: Type.Optional(Type.Integer()),
	allowIndefinite: Type.Optional(Type.Boolean()),
	outcome: Type.Optional(StringEnum(["continue", "stop"] as const)),
	delaySeconds: Type.Optional(Type.Number()),
	reason: Type.Optional(Type.String()),
});

type WatchLoopParameters = Static<typeof watchLoopParameters>;

export interface WatchLoopControllerDependencies {
	now: () => number;
	setTimer: (callback: () => void, delayMilliseconds: number) => ReturnType<typeof setTimeout>;
	clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
	createWatchId: () => string;
	isDisabled: () => boolean;
}

const defaultDependencies: WatchLoopControllerDependencies = {
	now: Date.now,
	setTimer: (callback, delayMilliseconds) => setTimeout(callback, delayMilliseconds),
	clearTimer: (timer) => clearTimeout(timer),
	createWatchId: randomUUID,
	isDisabled: () => process.env.PI_WATCH_LOOP_DISABLED === "1",
};

function requiredNumber(value: number | undefined, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} is required and must be numeric`);
	return value;
}

function requiredString(value: string | undefined, name: string): string {
	if (!value?.trim()) throw new Error(`${name} is required`);
	return value;
}

function parseStopAt(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error("stopAt must be an ISO-8601 timestamp");
	return parsed;
}

function canDispatch(ctx: ExtensionContext): boolean {
	return ctx.isIdle() && !ctx.hasPendingMessages();
}

function formatDuration(milliseconds: number): string {
	if (milliseconds <= 0) return "due";
	const seconds = Math.ceil(milliseconds / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.ceil(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	return `${Math.ceil(minutes / 60)}h`;
}

export function formatWatchStatus(state: WatchLoopState, now = Date.now()): string {
	const lines = [`Protocol: ${WATCH_LOOP_PROTOCOL_VERSION}`, `State: ${state.status}`];
	const watch = state.watch;
	if (!watch) return lines.join("\n");

	lines.push(`Watch: ${watch.label} (${watch.id})`, `Mode: ${watch.mode}`);
	if (state.status === "armed") {
		lines.push(state.due ? "Next run: due when Pi is idle" : `Next run: ${formatDuration((state.nextRunAt ?? now) - now)}`);
	} else if (state.status === "running") {
		lines.push(`Running generation: ${state.generation}`);
	} else if (state.status === "paused") {
		lines.push("Next run: paused until /watch-resume");
	}
	lines.push(
		`Ticks: ${state.tickCount}/${watch.maxTicks ?? "unbounded"}`,
		`Consecutive misses: ${state.consecutiveMisses}`,
	);
	if (watch.mode === "fixed") lines.push(`Interval: ${watch.intervalSeconds}s from completion`);
	else lines.push("Interval: adaptive (60-3600s)");
	if (watch.stopAt !== undefined) lines.push(`Deadline: ${new Date(watch.stopAt).toISOString()}`);
	if (watch.maxTicks !== undefined) lines.push(`Tick budget: ${watch.maxTicks}`);
	if (watch.allowIndefinite && watch.stopAt === undefined && watch.maxTicks === undefined) {
		lines.push("Bounds: explicitly indefinite for this Pi process");
	}
	if (state.lastReason) lines.push(`Last reason: ${state.lastReason}`);
	return lines.join("\n");
}

function footerStatus(state: WatchLoopState, now: number): string | undefined {
	const label = state.watch?.label;
	if (!label || state.status === "idle" || state.status === "stopped") return undefined;
	if (state.status === "paused") return `watch: ${label} · paused`;
	if (state.status === "running") return `watch: ${label} · running`;
	if (state.due) return `watch: ${label} · due`;
	return `watch: ${label} · ${formatDuration((state.nextRunAt ?? now) - now)}`;
}

export class WatchLoopController {
	private currentState = createIdleState();
	private tickTimer: ReturnType<typeof setTimeout> | undefined;
	private tickTimerToken = 0;
	private deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	private deadlineTimerToken = 0;
	private currentContext: ExtensionContext | undefined;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly dependencies: WatchLoopControllerDependencies,
	) {}

	get state(): WatchLoopState {
		return this.currentState;
	}

	bind(ctx: ExtensionContext): void {
		this.currentContext = ctx;
		this.updateFooter(ctx);
	}

	transition(event: WatchEvent, ctx: ExtensionContext): WatchTransition {
		this.currentContext = ctx;
		const transition = reduceWatchLoop(this.currentState, event);
		this.apply(transition, ctx);
		return transition;
	}

	onAgentSettled(ctx: ExtensionContext): void {
		this.currentContext = ctx;
		if (this.currentState.status !== "running" && !(this.currentState.status === "armed" && this.currentState.due)) {
			return;
		}
		this.apply(
			reduceWatchLoop(this.currentState, {
				type: "agent_settled",
				now: this.dependencies.now(),
				canDispatch: canDispatch(ctx),
			}),
			ctx,
		);
	}

	shutdown(ctx: ExtensionContext, reason = "session shutdown"): void {
		this.currentContext = ctx;
		this.apply(
			reduceWatchLoop(this.currentState, { type: "shutdown", now: this.dependencies.now(), reason }),
			ctx,
		);
		this.currentContext = undefined;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	private apply(transition: WatchTransition, ctx: ExtensionContext): void {
		this.currentState = transition.state;
		for (const effect of transition.effects) {
			switch (effect.type) {
				case "schedule":
					this.scheduleTick(effect.delayMilliseconds);
					break;
				case "schedule_deadline":
					this.scheduleDeadline(effect.delayMilliseconds);
					break;
				case "clear_timer":
					this.clearTimers();
					break;
				case "notify":
					if (ctx.hasUI) ctx.ui.notify(effect.message, effect.level);
					break;
				case "dispatch":
					try {
						this.pi.sendUserMessage(effect.prompt);
					} catch (error) {
						const reason = error instanceof Error ? error.message : "Pi rejected watch-loop prompt injection";
						this.apply(
							reduceWatchLoop(this.currentState, {
								type: "dispatch_failed",
								now: this.dependencies.now(),
								reason,
							}),
							ctx,
						);
					}
					break;
			}
		}
		this.updateFooter(ctx);
	}

	private scheduleTick(delayMilliseconds: number): void {
		this.clearTickTimer();
		const token = this.tickTimerToken;
		this.tickTimer = this.dependencies.setTimer(() => {
			if (token !== this.tickTimerToken) return;
			this.tickTimer = undefined;
			this.tickTimerToken += 1;
			const ctx = this.currentContext;
			if (!ctx) return;
			this.apply(
				reduceWatchLoop(this.currentState, {
					type: "timer_due",
					now: this.dependencies.now(),
					canDispatch: canDispatch(ctx),
				}),
				ctx,
			);
		}, delayMilliseconds);
	}

	private scheduleDeadline(delayMilliseconds: number): void {
		this.clearDeadlineTimer();
		const token = this.deadlineTimerToken;
		this.deadlineTimer = this.dependencies.setTimer(() => {
			if (token !== this.deadlineTimerToken) return;
			this.deadlineTimer = undefined;
			this.deadlineTimerToken += 1;
			const ctx = this.currentContext;
			if (!ctx) return;
			this.apply(
				reduceWatchLoop(this.currentState, {
					type: "deadline_due",
					now: this.dependencies.now(),
				}),
				ctx,
			);
		}, delayMilliseconds);
	}

	private clearTickTimer(): void {
		this.tickTimerToken += 1;
		if (this.tickTimer) this.dependencies.clearTimer(this.tickTimer);
		this.tickTimer = undefined;
	}

	private clearDeadlineTimer(): void {
		this.deadlineTimerToken += 1;
		if (this.deadlineTimer) this.dependencies.clearTimer(this.deadlineTimer);
		this.deadlineTimer = undefined;
	}

	private clearTimers(): void {
		this.clearTickTimer();
		this.clearDeadlineTimer();
	}

	private updateFooter(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		ctx.ui.setStatus(STATUS_KEY, footerStatus(this.currentState, this.dependencies.now()));
	}
}

function toolResult(result: WatchOperationResult, state: WatchLoopState) {
	return {
		content: [{ type: "text" as const, text: `${result.message}\n\n${formatWatchStatus(state)}` }],
		details: { protocolVersion: WATCH_LOOP_PROTOCOL_VERSION, result, state },
		terminate: true,
	};
}

function statusResult(state: WatchLoopState) {
	return {
		content: [{ type: "text" as const, text: formatWatchStatus(state) }],
		details: { protocolVersion: WATCH_LOOP_PROTOCOL_VERSION, state },
	};
}

function throwIfRejected(transition: WatchTransition, previousState: WatchLoopState): void {
	if (transition.result?.ok !== false || transition.state !== previousState) return;
	throw new Error(transition.result.message);
}

export function registerWatchLoopExtension(
	pi: ExtensionAPI,
	dependencies: WatchLoopControllerDependencies = defaultDependencies,
): WatchLoopController {
	const controller = new WatchLoopController(pi, dependencies);

	pi.registerTool({
		name: "watch_loop",
		label: "Watch Loop",
		description:
			"Control one in-memory protocol-v1 fixed or adaptive watch loop in the current interactive Pi session. Delays are clamped to 60-3600 seconds. Output is bounded and state is never restored after reload or exit.",
		promptSnippet: "Start, complete, stop, or inspect one bounded in-session watch loop",
		promptGuidelines: [
			"Use watch_loop status before starting a watch and require protocol version 1.",
			"Use watch_loop start only with a self-contained tick prompt plus a deadline, tick budget, or allowIndefinite: true.",
			"During an injected watch tick, render the visible dashboard before finishing with matching watch_loop complete tokens.",
		],
		parameters: watchLoopParameters,
		executionMode: "sequential",
		async execute(_toolCallId, params: WatchLoopParameters, _signal, _onUpdate, ctx) {
			controller.bind(ctx);
			if (params.action === "status") return statusResult(controller.state);

			const previousState = controller.state;
			let transition: WatchTransition;
			switch (params.action) {
				case "start": {
					if (dependencies.isDisabled()) {
						throw new Error("watch_loop start is disabled by PI_WATCH_LOOP_DISABLED=1");
					}
					if (ctx.mode !== "tui") {
						throw new Error(`watch_loop start requires an interactive TUI; current mode is ${ctx.mode}`);
					}
					const mode = params.mode;
					const missedCompletionPolicy = params.missedCompletionPolicy;
					if (!mode) throw new Error("mode is required");
					if (!missedCompletionPolicy) throw new Error("missedCompletionPolicy is required");
					const config: WatchStartConfig = {
						label: requiredString(params.label, "label"),
						tickPrompt: requiredString(params.tickPrompt, "tickPrompt"),
						mode,
						initialDelaySeconds: requiredNumber(params.initialDelaySeconds, "initialDelaySeconds"),
						intervalSeconds: params.intervalSeconds,
						missedCompletionPolicy,
						stopAt: parseStopAt(params.stopAt),
						maxTicks: params.maxTicks,
						allowIndefinite: params.allowIndefinite,
					};
					transition = controller.transition(
						{
							type: "start",
							protocolVersion: requiredNumber(params.protocolVersion, "protocolVersion"),
							watchId: dependencies.createWatchId(),
							config,
							now: dependencies.now(),
						},
						ctx,
					);
					break;
				}
				case "complete":
					if (!params.outcome) throw new Error("outcome is required");
					transition = controller.transition(
						{
							type: "complete",
							protocolVersion: requiredNumber(params.protocolVersion, "protocolVersion"),
							watchId: requiredString(params.watchId, "watchId"),
							generation: requiredNumber(params.generation, "generation"),
							outcome: params.outcome,
							delaySeconds: params.delaySeconds,
							reason: params.reason,
							now: dependencies.now(),
						},
						ctx,
					);
					break;
				case "stop":
					transition = controller.transition(
						{
							type: "stop",
							protocolVersion: requiredNumber(params.protocolVersion, "protocolVersion"),
							watchId: requiredString(params.watchId, "watchId"),
							generation: requiredNumber(params.generation, "generation"),
							reason: params.reason,
							now: dependencies.now(),
						},
						ctx,
					);
					break;
			}

			throwIfRejected(transition, previousState);
			if (!transition.result) throw new Error("watch_loop action produced no result");
			return toolResult(transition.result, transition.state);
		},
	});

	pi.registerCommand("watch-status", {
		description: "Show the current in-memory watch-loop state",
		handler: async (_args, ctx) => {
			controller.bind(ctx);
			ctx.ui.notify(formatWatchStatus(controller.state, dependencies.now()), "info");
		},
	});

	pi.registerCommand("watch-stop", {
		description: "Stop the current in-memory watch loop",
		handler: async (_args, ctx) => {
			const transition = controller.transition(
				{ type: "user_stop", reason: "watch stopped by user", now: dependencies.now() },
				ctx,
			);
			if (transition.result?.ok === false) ctx.ui.notify(transition.result.message, "warning");
		},
	});

	pi.registerCommand("watch-resume", {
		description: "Resume one paused watch with an immediate tick",
		handler: async (_args, ctx) => {
			const transition = controller.transition({ type: "resume", now: dependencies.now() }, ctx);
			if (transition.result?.ok === false) ctx.ui.notify(transition.result.message, "warning");
			else if (transition.result) ctx.ui.notify(transition.result.message, "info");
		},
	});

	pi.on("session_start", (_event, ctx) => controller.bind(ctx));
	pi.on("agent_settled", (_event, ctx) => controller.onAgentSettled(ctx));
	pi.on("session_tree", (_event, ctx) => controller.shutdown(ctx, "session tree changed"));
	pi.on("session_shutdown", (_event, ctx) => controller.shutdown(ctx));

	return controller;
}

export default function watchLoopExtension(pi: ExtensionAPI): void {
	registerWatchLoopExtension(pi);
}
