export const WATCH_LOOP_PROTOCOL_VERSION = 1 as const;
export const MIN_DELAY_SECONDS = 60;
export const MAX_DELAY_SECONDS = 3600;
export const MAX_CONSECUTIVE_MISSES = 3;

export type WatchStatus = "idle" | "armed" | "running" | "paused" | "stopped";
export type WatchMode = "fixed" | "adaptive";
export type MissedCompletionPolicy = "pause" | "retry";
export type CompletionOutcome = "continue" | "stop";

export interface WatchStartConfig {
	label: string;
	tickPrompt: string;
	mode: WatchMode;
	initialDelaySeconds: number;
	intervalSeconds?: number;
	missedCompletionPolicy: MissedCompletionPolicy;
	stopAt?: number;
	maxTicks?: number;
	allowIndefinite?: boolean;
}

export interface WatchDefinition extends WatchStartConfig {
	id: string;
	allowIndefinite: boolean;
}

export interface WatchLoopState {
	status: WatchStatus;
	watch?: WatchDefinition;
	generation: number;
	tickCount: number;
	consecutiveMisses: number;
	due: boolean;
	nextRunAt?: number;
	lastReason?: string;
	reservedGeneration?: number;
}

export type WatchEvent =
	| {
			type: "start";
			protocolVersion: number;
			watchId: string;
			config: WatchStartConfig;
			now: number;
	  }
	| { type: "timer_due"; now: number; canDispatch: boolean }
	| { type: "deadline_due"; now: number }
	| { type: "agent_settled"; now: number; canDispatch: boolean }
	| { type: "dispatch_failed"; now: number; reason: string }
	| {
			type: "complete";
			protocolVersion: number;
			watchId: string;
			generation: number;
			outcome: CompletionOutcome;
			delaySeconds?: number;
			reason?: string;
			now: number;
	  }
	| {
			type: "stop";
			protocolVersion: number;
			watchId: string;
			generation: number;
			reason?: string;
			now: number;
	  }
	| { type: "user_stop"; reason?: string; now: number }
	| { type: "resume"; now: number }
	| { type: "shutdown"; now: number; reason?: string };

export type WatchEffect =
	| { type: "schedule"; delayMilliseconds: number }
	| { type: "schedule_deadline"; delayMilliseconds: number }
	| { type: "clear_timer" }
	| { type: "dispatch"; watchId: string; generation: number; prompt: string }
	| { type: "notify"; level: "info" | "warning" | "error"; message: string };

export interface DelayClamp {
	field: "initialDelaySeconds" | "intervalSeconds" | "delaySeconds";
	requested: number;
	applied: number;
}

export interface WatchOperationResult {
	ok: boolean;
	code: string;
	message: string;
	clamped?: DelayClamp[];
}

export interface WatchTransition {
	state: WatchLoopState;
	effects: WatchEffect[];
	result?: WatchOperationResult;
}

export function createIdleState(): WatchLoopState {
	return {
		status: "idle",
		generation: 0,
		tickCount: 0,
		consecutiveMisses: 0,
		due: false,
	};
}

function unchanged(state: WatchLoopState): WatchTransition {
	return { state, effects: [] };
}

function invalid(state: WatchLoopState, code: string, message: string): WatchTransition {
	return { state, effects: [], result: { ok: false, code, message } };
}

function clampDelay(field: DelayClamp["field"], requested: number, clamped: DelayClamp[]): number {
	const applied = Math.min(MAX_DELAY_SECONDS, Math.max(MIN_DELAY_SECONDS, requested));
	if (applied !== requested) clamped.push({ field, requested, applied });
	return applied;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function stopTransition(
	state: WatchLoopState,
	reason: string,
	options: { code?: string; ok?: boolean; invalidateGeneration?: boolean; notify?: boolean } = {},
): WatchTransition {
	const next: WatchLoopState = {
		...state,
		status: "stopped",
		generation: state.generation + (options.invalidateGeneration ? 1 : 0),
		due: false,
		nextRunAt: undefined,
		reservedGeneration: undefined,
		lastReason: reason,
	};
	const effects: WatchEffect[] = [{ type: "clear_timer" }];
	if (options.notify !== false) effects.push({ type: "notify", level: "warning", message: reason });
	return {
		state: next,
		effects,
		...(options.code
			? { result: { ok: options.ok ?? true, code: options.code, message: reason } }
			: {}),
	};
}

function boundStop(
	state: WatchLoopState,
	now: number,
	delayMilliseconds: number,
): { code: string; reason: string } | undefined {
	const watch = state.watch;
	if (!watch) return { code: "watch_missing", reason: "watch definition missing" };
	if (watch.stopAt !== undefined) {
		if (now >= watch.stopAt) return { code: "deadline_reached", reason: "deadline reached" };
		if (now + delayMilliseconds >= watch.stopAt) {
			return { code: "deadline_prevents_schedule", reason: "next tick would reach or cross the deadline" };
		}
	}
	if (watch.maxTicks !== undefined && state.tickCount >= watch.maxTicks) {
		return { code: "tick_budget_exhausted", reason: "tick budget exhausted" };
	}
	return undefined;
}

function deadlineEffect(state: WatchLoopState, now: number): WatchEffect[] {
	const stopAt = state.watch?.stopAt;
	if (stopAt === undefined || stopAt <= now) return [];
	return [{ type: "schedule_deadline", delayMilliseconds: stopAt - now }];
}

function scheduleTransition(
	state: WatchLoopState,
	now: number,
	delayMilliseconds: number,
	result: WatchOperationResult,
): WatchTransition {
	const bound = boundStop(state, now, delayMilliseconds);
	if (bound) return stopTransition(state, bound.reason, { code: bound.code, ok: true });
	const nextState: WatchLoopState = {
		...state,
		status: "armed",
		due: false,
		nextRunAt: now + delayMilliseconds,
		lastReason: result.message,
	};
	return {
		state: nextState,
		effects: [{ type: "schedule", delayMilliseconds }, ...deadlineEffect(nextState, now)],
		result,
	};
}

function tickPrompt(watch: WatchDefinition, generation: number): string {
	const cadence =
		watch.mode === "adaptive"
			? "For outcome continue, include a numeric delaySeconds recommendation."
			: "Fixed cadence is runtime-owned; do not include delaySeconds.";
	return `${watch.tickPrompt.trim()}\n\nThis is watch-loop protocol ${WATCH_LOOP_PROTOCOL_VERSION} tick ${watch.id}/${generation}. Render the full visible dashboard before your final action. Finish with watch_loop complete using protocolVersion ${WATCH_LOOP_PROTOCOL_VERSION}, watchId ${watch.id}, generation ${generation}, and outcome continue or stop. ${cadence}`;
}

function dispatchTransition(state: WatchLoopState, now: number, canDispatch: boolean): WatchTransition {
	if (state.status !== "armed" || !state.watch) return unchanged(state);
	const bound = boundStop(state, now, 0);
	if (bound) return stopTransition(state, bound.reason, { notify: true });
	if (!canDispatch) {
		return {
			state: { ...state, due: true, nextRunAt: undefined, lastReason: "tick due while Pi was busy" },
			effects: [],
		};
	}

	const generation = state.reservedGeneration ?? state.generation + 1;
	return {
		state: {
			...state,
			status: "running",
			generation,
			tickCount: state.tickCount + 1,
			due: false,
			nextRunAt: undefined,
			reservedGeneration: undefined,
			lastReason: `tick ${state.tickCount + 1} running`,
		},
		effects: [
			{
				type: "dispatch",
				watchId: state.watch.id,
				generation,
				prompt: tickPrompt(state.watch, generation),
			},
		],
	};
}

function pauseTransition(
	state: WatchLoopState,
	now: number,
	reason: string,
	options: { result?: WatchOperationResult; level?: "warning" | "error" } = {},
): WatchTransition {
	const bound = boundStop(state, now, 0);
	if (bound) return stopTransition(state, bound.reason, { code: bound.code, ok: true });
	const pausedState: WatchLoopState = {
		...state,
		status: "paused",
		due: false,
		nextRunAt: undefined,
		lastReason: reason,
	};
	return {
		state: pausedState,
		effects: [
			{ type: "clear_timer" },
			...deadlineEffect(pausedState, now),
			{ type: "notify", level: options.level ?? "warning", message: `${reason}; watch paused` },
		],
		...(options.result ? { result: options.result } : {}),
	};
}

function missedCompletion(
	state: WatchLoopState,
	now: number,
	reason: string,
	result?: WatchOperationResult,
): WatchTransition {
	if (state.status !== "running" || !state.watch) return unchanged(state);
	const misses = state.consecutiveMisses + 1;
	const missedState: WatchLoopState = {
		...state,
		consecutiveMisses: misses,
		due: false,
		nextRunAt: undefined,
		lastReason: reason,
	};

	if (state.watch.missedCompletionPolicy === "pause" || misses >= MAX_CONSECUTIVE_MISSES) {
		return pauseTransition(missedState, now, reason, { result });
	}

	const delayMilliseconds = MIN_DELAY_SECONDS * 2 ** (misses - 1) * 1000;
	return scheduleTransition(
		{ ...missedState, status: "armed" },
		now,
		delayMilliseconds,
		result ?? { ok: true, code: "miss_retry", message: `${reason}; retry ${misses} scheduled` },
	);
}

function validateRunningToken(
	state: WatchLoopState,
	protocolVersion: number,
	watchId: string,
	generation: number,
): WatchTransition | undefined {
	if (protocolVersion !== WATCH_LOOP_PROTOCOL_VERSION) {
		return invalid(state, "protocol_mismatch", `watch_loop protocol ${WATCH_LOOP_PROTOCOL_VERSION} required`);
	}
	if (state.status !== "running" || !state.watch) {
		return invalid(state, "not_running", "no running watch tick matches this action");
	}
	if (watchId !== state.watch.id) return invalid(state, "watch_id_mismatch", "watch ID does not match the running tick");
	if (generation !== state.generation) {
		return invalid(state, "generation_mismatch", "generation does not match the running tick");
	}
	return undefined;
}

function startTransition(state: WatchLoopState, event: Extract<WatchEvent, { type: "start" }>): WatchTransition {
	if (event.protocolVersion !== WATCH_LOOP_PROTOCOL_VERSION) {
		return invalid(state, "protocol_mismatch", `watch_loop protocol ${WATCH_LOOP_PROTOCOL_VERSION} required`);
	}
	if (["armed", "running", "paused"].includes(state.status)) {
		return invalid(state, "watch_active", "a watch is already active; stop it before starting another");
	}
	if (!event.watchId.trim()) return invalid(state, "invalid_watch_id", "watch ID is required");

	const input = event.config;
	if (!input.label.trim()) return invalid(state, "invalid_label", "watch label is required");
	if (!input.tickPrompt.trim()) return invalid(state, "invalid_tick_prompt", "a self-contained tick prompt is required");
	if (!isFiniteNumber(input.initialDelaySeconds)) {
		return invalid(state, "invalid_initial_delay", "initialDelaySeconds must be numeric");
	}
	if (input.mode === "fixed" && !isFiniteNumber(input.intervalSeconds)) {
		return invalid(state, "fixed_interval_required", "fixed mode requires intervalSeconds");
	}
	if (input.mode === "adaptive" && input.intervalSeconds !== undefined) {
		return invalid(state, "adaptive_interval_forbidden", "adaptive mode does not accept intervalSeconds");
	}
	if (input.maxTicks !== undefined && (!Number.isInteger(input.maxTicks) || input.maxTicks <= 0)) {
		return invalid(state, "invalid_tick_budget", "maxTicks must be a positive integer");
	}
	if (input.stopAt !== undefined && !isFiniteNumber(input.stopAt)) {
		return invalid(state, "invalid_deadline", "stopAt must be a valid timestamp");
	}
	if (input.stopAt === undefined && input.maxTicks === undefined && input.allowIndefinite !== true) {
		return invalid(state, "bounds_required", "set stopAt, maxTicks, or allowIndefinite: true");
	}

	const clamped: DelayClamp[] = [];
	const initialDelaySeconds = clampDelay("initialDelaySeconds", input.initialDelaySeconds, clamped);
	const intervalSeconds =
		input.mode === "fixed" && input.intervalSeconds !== undefined
			? clampDelay("intervalSeconds", input.intervalSeconds, clamped)
			: undefined;
	const watch: WatchDefinition = {
		...input,
		id: event.watchId,
		label: input.label.trim(),
		tickPrompt: input.tickPrompt.trim(),
		initialDelaySeconds,
		intervalSeconds,
		allowIndefinite: input.allowIndefinite === true,
	};
	const started: WatchLoopState = {
		status: "armed",
		watch,
		generation: 0,
		tickCount: 0,
		consecutiveMisses: 0,
		due: false,
		lastReason: "watch started",
	};
	return scheduleTransition(started, event.now, initialDelaySeconds * 1000, {
		ok: true,
		code: "started",
		message: clamped.length > 0 ? "watch started with clamped delays" : "watch started",
		...(clamped.length > 0 ? { clamped } : {}),
	});
}

export function reduceWatchLoop(state: WatchLoopState, event: WatchEvent): WatchTransition {
	switch (event.type) {
		case "start":
			return startTransition(state, event);
		case "timer_due":
			return dispatchTransition(state, event.now, event.canDispatch);
		case "deadline_due": {
			const stopAt = state.watch?.stopAt;
			if (stopAt === undefined || ["idle", "stopped"].includes(state.status)) return unchanged(state);
			if (event.now < stopAt) {
				return { state, effects: [{ type: "schedule_deadline", delayMilliseconds: stopAt - event.now }] };
			}
			return stopTransition(state, "deadline reached", {
				invalidateGeneration: state.status === "running",
			});
		}
		case "agent_settled":
			if (state.status === "armed" && state.due) return dispatchTransition(state, event.now, event.canDispatch);
			if (state.status === "running") {
				return missedCompletion(state, event.now, "tick settled without watch_loop complete");
			}
			return unchanged(state);
		case "dispatch_failed":
			if (state.status !== "running") return unchanged(state);
			return pauseTransition(
				{ ...state, consecutiveMisses: state.consecutiveMisses + 1 },
				event.now,
				event.reason,
				{ level: "error" },
			);
		case "complete": {
			const invalidToken = validateRunningToken(
				state,
				event.protocolVersion,
				event.watchId,
				event.generation,
			);
			if (invalidToken) return invalidToken;
			if (event.outcome === "stop") {
				return stopTransition(state, event.reason?.trim() || "watch requested stop", {
					code: "stopped",
					ok: true,
				});
			}

			const watch = state.watch;
			if (!watch) return invalid(state, "watch_missing", "watch definition missing");
			const clamped: DelayClamp[] = [];
			let delaySeconds: number;
			if (watch.mode === "adaptive") {
				if (!isFiniteNumber(event.delaySeconds)) {
					return missedCompletion(state, event.now, "adaptive completion omitted a numeric delay", {
						ok: false,
						code: "adaptive_delay_missing",
						message: "adaptive delay missing; missed-completion policy applied",
					});
				}
				delaySeconds = clampDelay("delaySeconds", event.delaySeconds, clamped);
			} else {
				delaySeconds = watch.intervalSeconds ?? MIN_DELAY_SECONDS;
			}
			return scheduleTransition(
				{ ...state, status: "armed", consecutiveMisses: 0 },
				event.now,
				delaySeconds * 1000,
				{
					ok: true,
					code: "continued",
					message: clamped.length > 0 ? "next tick scheduled with a clamped delay" : "next tick scheduled",
					...(clamped.length > 0 ? { clamped } : {}),
				},
			);
		}
		case "stop": {
			const invalidToken = validateRunningToken(
				state,
				event.protocolVersion,
				event.watchId,
				event.generation,
			);
			if (invalidToken) return invalidToken;
			return stopTransition(state, event.reason?.trim() || "watch stopped", { code: "stopped", ok: true });
		}
		case "user_stop":
			if (state.status === "idle" || state.status === "stopped") {
				return invalid(state, "no_active_watch", "no active watch to stop");
			}
			return stopTransition(state, event.reason?.trim() || "watch stopped by user", {
				code: "stopped",
				ok: true,
				invalidateGeneration: true,
			});
		case "resume": {
			if (state.status !== "paused" || !state.watch) {
				return invalid(state, "not_paused", "no paused watch to resume");
			}
			const generation = state.generation + 1;
			return scheduleTransition(
				{
					...state,
					status: "armed",
					generation,
					reservedGeneration: generation,
				},
				event.now,
				0,
				{ ok: true, code: "resumed", message: "watch resumed" },
			);
		}
		case "shutdown":
			if (state.status === "idle") return { state, effects: [{ type: "clear_timer" }] };
			return stopTransition(state, event.reason ?? "session shutdown", {
				invalidateGeneration: state.status === "running",
				notify: false,
			});
	}
}
