import assert from "node:assert/strict";
import test from "node:test";
import {
	WATCH_LOOP_PROTOCOL_VERSION,
	createIdleState,
	reduceWatchLoop,
	type WatchEffect,
	type WatchLoopState,
	type WatchStartConfig,
} from "./watch-loop.ts";

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);

function config(overrides: Partial<WatchStartConfig> = {}): WatchStartConfig {
	return {
		label: "PRs",
		tickPrompt: "Load and follow the `pr-status` skill, render the dashboard, then complete the watch tick.",
		mode: "fixed",
		initialDelaySeconds: 60,
		intervalSeconds: 120,
		missedCompletionPolicy: "retry",
		maxTicks: 5,
		...overrides,
	};
}

function start(overrides: Partial<WatchStartConfig> = {}, now = NOW): WatchLoopState {
	const transition = reduceWatchLoop(createIdleState(), {
		type: "start",
		protocolVersion: WATCH_LOOP_PROTOCOL_VERSION,
		watchId: "watch-1",
		config: config(overrides),
		now,
	});
	assert.equal(transition.result?.ok, true);
	return transition.state;
}

function dispatch(state: WatchLoopState, now = NOW + 60_000): WatchLoopState {
	return reduceWatchLoop(state, { type: "timer_due", now, canDispatch: true }).state;
}

function effect<T extends WatchEffect["type"]>(effects: WatchEffect[], type: T): Extract<WatchEffect, { type: T }> | undefined {
	return effects.find((candidate): candidate is Extract<WatchEffect, { type: T }> => candidate.type === type);
}

test("exports protocol version 1 and starts bounded watches armed", () => {
	assert.equal(WATCH_LOOP_PROTOCOL_VERSION, 1);
	const transition = reduceWatchLoop(createIdleState(), {
		type: "start",
		protocolVersion: 1,
		watchId: "watch-1",
		config: config(),
		now: NOW,
	});

	assert.equal(transition.result?.ok, true);
	assert.equal(transition.state.status, "armed");
	assert.equal(transition.state.watch?.id, "watch-1");
	assert.equal(transition.state.nextRunAt, NOW + 60_000);
	assert.deepEqual(effect(transition.effects, "schedule"), { type: "schedule", delayMilliseconds: 60_000 });
});

test("requires protocol version 1 and an explicit deadline, budget, or indefinite opt-in", () => {
	const wrongVersion = reduceWatchLoop(createIdleState(), {
		type: "start",
		protocolVersion: 2,
		watchId: "watch-1",
		config: config(),
		now: NOW,
	});
	assert.equal(wrongVersion.result?.code, "protocol_mismatch");
	assert.equal(wrongVersion.state.status, "idle");

	const unbounded = reduceWatchLoop(createIdleState(), {
		type: "start",
		protocolVersion: 1,
		watchId: "watch-1",
		config: config({ maxTicks: undefined }),
		now: NOW,
	});
	assert.equal(unbounded.result?.code, "bounds_required");
	assert.equal(unbounded.state.status, "idle");

	const explicit = reduceWatchLoop(createIdleState(), {
		type: "start",
		protocolVersion: 1,
		watchId: "watch-1",
		config: config({ maxTicks: undefined, allowIndefinite: true }),
		now: NOW,
	});
	assert.equal(explicit.result?.ok, true);
	assert.equal(explicit.state.watch?.allowIndefinite, true);
});

test("validates mode-specific configuration without mutating state", () => {
	for (const invalidConfig of [
		config({ intervalSeconds: undefined }),
		config({ mode: "adaptive", intervalSeconds: 120 }),
		config({ maxTicks: 0 }),
		config({ label: "" }),
		config({ tickPrompt: "" }),
	]) {
		const transition = reduceWatchLoop(createIdleState(), {
			type: "start",
			protocolVersion: 1,
			watchId: "watch-1",
			config: invalidConfig,
			now: NOW,
		});
		assert.equal(transition.result?.ok, false);
		assert.equal(transition.state.status, "idle");
	}
});

test("clamps initial, fixed, and adaptive delays to safe bounds", () => {
	const started = reduceWatchLoop(createIdleState(), {
		type: "start",
		protocolVersion: 1,
		watchId: "watch-1",
		config: config({ initialDelaySeconds: 1, intervalSeconds: 7200 }),
		now: NOW,
	});
	assert.equal(started.state.watch?.initialDelaySeconds, 60);
	assert.equal(started.state.watch?.intervalSeconds, 3600);
	assert.deepEqual(started.result?.clamped, [
		{ field: "initialDelaySeconds", requested: 1, applied: 60 },
		{ field: "intervalSeconds", requested: 7200, applied: 3600 },
	]);

	const running = dispatch(start({ mode: "adaptive", intervalSeconds: undefined }), NOW + 60_000);
	const completed = reduceWatchLoop(running, {
		type: "complete",
		protocolVersion: 1,
		watchId: "watch-1",
		generation: 1,
		outcome: "continue",
		delaySeconds: 10_000,
		now: NOW + 90_000,
	});
	assert.equal(completed.state.nextRunAt, NOW + 90_000 + 3_600_000);
	assert.deepEqual(completed.result?.clamped, [{ field: "delaySeconds", requested: 10_000, applied: 3600 }]);
});

test("rejects a duplicate start while armed, running, or paused", () => {
	const states = [
		start(),
		dispatch(start()),
		{ ...dispatch(start({ missedCompletionPolicy: "pause" })), status: "paused" as const },
	];
	for (const state of states) {
		const transition = reduceWatchLoop(state, {
			type: "start",
			protocolVersion: 1,
			watchId: "watch-2",
			config: config(),
			now: NOW,
		});
		assert.equal(transition.result?.code, "watch_active");
		assert.equal(transition.state, state);
	}
});

test("marks one due tick while busy and dispatches it once after settlement", () => {
	const armed = start();
	const due = reduceWatchLoop(armed, { type: "timer_due", now: NOW + 60_000, canDispatch: false });
	assert.equal(due.state.status, "armed");
	assert.equal(due.state.due, true);
	assert.equal(due.state.nextRunAt, undefined);
	assert.equal(effect(due.effects, "dispatch"), undefined);

	const running = reduceWatchLoop(due.state, { type: "agent_settled", now: NOW + 70_000, canDispatch: true });
	assert.equal(running.state.status, "running");
	assert.equal(running.state.tickCount, 1);
	assert.equal(running.state.generation, 1);
	assert.equal(running.state.due, false);
	assert.equal(effect(running.effects, "dispatch")?.generation, 1);

	const duplicate = reduceWatchLoop(running.state, { type: "timer_due", now: NOW + 70_000, canDispatch: true });
	assert.equal(duplicate.state, running.state);
	assert.equal(effect(duplicate.effects, "dispatch"), undefined);
});

test("pauses without arming a timer when prompt injection fails", () => {
	const running = dispatch(start());
	const failed = reduceWatchLoop(running, {
		type: "dispatch_failed",
		now: NOW + 61_000,
		reason: "Pi became busy before injection",
	});
	assert.equal(failed.state.status, "paused");
	assert.equal(failed.state.consecutiveMisses, 1);
	assert.equal(failed.state.lastReason, "Pi became busy before injection");
	assert.equal(effect(failed.effects, "schedule"), undefined);
	assert.ok(effect(failed.effects, "clear_timer"));
});

test("measures fixed cadence from successful completion and resets misses", () => {
	const running = { ...dispatch(start()), consecutiveMisses: 2 };
	const completed = reduceWatchLoop(running, {
		type: "complete",
		protocolVersion: 1,
		watchId: "watch-1",
		generation: 1,
		outcome: "continue",
		now: NOW + 90_000,
	});
	assert.equal(completed.state.status, "armed");
	assert.equal(completed.state.nextRunAt, NOW + 210_000);
	assert.equal(completed.state.consecutiveMisses, 0);
	assert.deepEqual(effect(completed.effects, "schedule"), { type: "schedule", delayMilliseconds: 120_000 });
});

test("stops cleanly when a matching tick reports a terminal outcome", () => {
	const completed = reduceWatchLoop(dispatch(start()), {
		type: "complete",
		protocolVersion: 1,
		watchId: "watch-1",
		generation: 1,
		outcome: "stop",
		reason: "all PRs settled",
		now: NOW + 90_000,
	});
	assert.equal(completed.state.status, "stopped");
	assert.equal(completed.state.lastReason, "all PRs settled");
	assert.ok(effect(completed.effects, "clear_timer"));
});

test("rejects stale protocol, watcher, generation, and duplicate completions", () => {
	const running = dispatch(start());
	for (const event of [
		{ protocolVersion: 2, watchId: "watch-1", generation: 1 },
		{ protocolVersion: 1, watchId: "watch-2", generation: 1 },
		{ protocolVersion: 1, watchId: "watch-1", generation: 0 },
	]) {
		const transition = reduceWatchLoop(running, {
			type: "complete",
			...event,
			outcome: "continue",
			now: NOW + 90_000,
		});
		assert.equal(transition.result?.ok, false);
		assert.equal(transition.state, running);
	}

	const stopped = reduceWatchLoop(running, {
		type: "complete",
		protocolVersion: 1,
		watchId: "watch-1",
		generation: 1,
		outcome: "stop",
		now: NOW + 90_000,
	}).state;
	const duplicate = reduceWatchLoop(stopped, {
		type: "complete",
		protocolVersion: 1,
		watchId: "watch-1",
		generation: 1,
		outcome: "stop",
		now: NOW + 91_000,
	});
	assert.equal(duplicate.result?.code, "not_running");
	assert.equal(duplicate.state, stopped);
});

test("requires matching tokens for model stop while user stop invalidates a running tick", () => {
	const running = dispatch(start());
	const staleModelStop = reduceWatchLoop(running, {
		type: "stop",
		protocolVersion: 1,
		watchId: "watch-1",
		generation: 0,
		reason: "stale",
		now: NOW + 61_000,
	});
	assert.equal(staleModelStop.result?.code, "generation_mismatch");
	assert.equal(staleModelStop.state, running);

	const userStopped = reduceWatchLoop(running, { type: "user_stop", reason: "operator stop", now: NOW + 62_000 });
	assert.equal(userStopped.state.status, "stopped");
	assert.equal(userStopped.state.generation, 2);
	const lateCompletion = reduceWatchLoop(userStopped.state, {
		type: "complete",
		protocolVersion: 1,
		watchId: "watch-1",
		generation: 1,
		outcome: "continue",
		now: NOW + 63_000,
	});
	assert.equal(lateCompletion.result?.ok, false);
	assert.equal(lateCompletion.state, userStopped.state);
});

test("applies pause and bounded retry policies to missed completions", () => {
	const paused = reduceWatchLoop(dispatch(start({ missedCompletionPolicy: "pause" })), {
		type: "agent_settled",
		now: NOW + 70_000,
		canDispatch: true,
	});
	assert.equal(paused.state.status, "paused");
	assert.equal(paused.state.consecutiveMisses, 1);

	let state = dispatch(start({ missedCompletionPolicy: "retry", maxTicks: 10 }));
	const first = reduceWatchLoop(state, { type: "agent_settled", now: NOW + 70_000, canDispatch: true });
	assert.equal(first.state.status, "armed");
	assert.equal(first.state.consecutiveMisses, 1);
	assert.equal(effect(first.effects, "schedule")?.delayMilliseconds, 60_000);

	state = dispatch(first.state, NOW + 130_000);
	const second = reduceWatchLoop(state, { type: "agent_settled", now: NOW + 140_000, canDispatch: true });
	assert.equal(second.state.status, "armed");
	assert.equal(second.state.consecutiveMisses, 2);
	assert.equal(effect(second.effects, "schedule")?.delayMilliseconds, 120_000);

	state = dispatch(second.state, NOW + 260_000);
	const third = reduceWatchLoop(state, { type: "agent_settled", now: NOW + 270_000, canDispatch: true });
	assert.equal(third.state.status, "paused");
	assert.equal(third.state.consecutiveMisses, 3);
	assert.equal(effect(third.effects, "schedule"), undefined);
});

test("keeps only a deadline timer while paused and stops when it expires", () => {
	const running = dispatch(
		start({ missedCompletionPolicy: "pause", maxTicks: undefined, stopAt: NOW + 120_000 }),
		NOW + 60_000,
	);
	const paused = reduceWatchLoop(running, {
		type: "agent_settled",
		now: NOW + 70_000,
		canDispatch: true,
	});
	assert.equal(paused.state.status, "paused");
	assert.equal(effect(paused.effects, "schedule_deadline")?.delayMilliseconds, 50_000);
	assert.equal(effect(paused.effects, "schedule"), undefined);

	const expired = reduceWatchLoop(paused.state, { type: "deadline_due", now: NOW + 120_000 });
	assert.equal(expired.state.status, "stopped");
	assert.equal(expired.state.lastReason, "deadline reached");
});

test("budget exhaustion wins over pausing after a missed final tick", () => {
	const running = dispatch(start({ missedCompletionPolicy: "pause", maxTicks: 1 }));
	const settled = reduceWatchLoop(running, {
		type: "agent_settled",
		now: NOW + 70_000,
		canDispatch: true,
	});
	assert.equal(settled.state.status, "stopped");
	assert.equal(settled.state.lastReason, "tick budget exhausted");
	assert.equal(effect(settled.effects, "schedule_deadline"), undefined);
});

test("treats missing adaptive delay as a protocol miss without hot-looping", () => {
	const running = dispatch(start({ mode: "adaptive", intervalSeconds: undefined, missedCompletionPolicy: "pause" }));
	const transition = reduceWatchLoop(running, {
		type: "complete",
		protocolVersion: 1,
		watchId: "watch-1",
		generation: 1,
		outcome: "continue",
		now: NOW + 90_000,
	});
	assert.equal(transition.result?.code, "adaptive_delay_missing");
	assert.equal(transition.state.status, "paused");
	assert.equal(effect(transition.effects, "schedule"), undefined);
});

test("stops when budget is exhausted before scheduling another tick", () => {
	const running = dispatch(start({ maxTicks: 1 }));
	const completed = reduceWatchLoop(running, {
		type: "complete",
		protocolVersion: 1,
		watchId: "watch-1",
		generation: 1,
		outcome: "continue",
		now: NOW + 90_000,
	});
	assert.equal(completed.state.status, "stopped");
	assert.equal(completed.result?.code, "tick_budget_exhausted");
	assert.equal(effect(completed.effects, "schedule"), undefined);
});

test("deadline wins before scheduling and before overdue dispatch", () => {
	const tooLate = reduceWatchLoop(createIdleState(), {
		type: "start",
		protocolVersion: 1,
		watchId: "watch-1",
		config: config({ maxTicks: undefined, stopAt: NOW + 30_000 }),
		now: NOW,
	});
	assert.equal(tooLate.state.status, "stopped");
	assert.equal(tooLate.result?.code, "deadline_prevents_schedule");

	const armed = start({ maxTicks: undefined, stopAt: NOW + 120_000 });
	const expired = reduceWatchLoop(armed, { type: "timer_due", now: NOW + 120_000, canDispatch: true });
	assert.equal(expired.state.status, "stopped");
	assert.equal(expired.state.lastReason, "deadline reached");
	assert.equal(effect(expired.effects, "dispatch"), undefined);
});

test("deadline invalidates a running generation before a late completion", () => {
	const running = dispatch(start({ maxTicks: undefined, stopAt: NOW + 120_000 }), NOW + 60_000);
	const expired = reduceWatchLoop(running, { type: "deadline_due", now: NOW + 120_000 });
	assert.equal(expired.state.status, "stopped");
	assert.equal(expired.state.generation, 2);
	const late = reduceWatchLoop(expired.state, {
		type: "complete",
		protocolVersion: 1,
		watchId: "watch-1",
		generation: 1,
		outcome: "continue",
		now: NOW + 121_000,
	});
	assert.equal(late.result?.code, "not_running");
	assert.equal(late.state, expired.state);
});

test("resume invalidates the paused generation and schedules one immediate tick", () => {
	const paused = reduceWatchLoop(dispatch(start({ missedCompletionPolicy: "pause" })), {
		type: "agent_settled",
		now: NOW + 70_000,
		canDispatch: true,
	}).state;
	const resumed = reduceWatchLoop(paused, { type: "resume", now: NOW + 80_000 });
	assert.equal(resumed.state.status, "armed");
	assert.equal(resumed.state.generation, 2);
	assert.equal(resumed.state.nextRunAt, NOW + 80_000);
	assert.equal(effect(resumed.effects, "schedule")?.delayMilliseconds, 0);

	const running = reduceWatchLoop(resumed.state, { type: "timer_due", now: NOW + 80_000, canDispatch: true });
	assert.equal(running.state.status, "running");
	assert.equal(running.state.generation, 2);
	assert.equal(effect(running.effects, "dispatch")?.generation, 2);
});

test("shutdown clears timers and due markers without persistence", () => {
	const due = reduceWatchLoop(start(), { type: "timer_due", now: NOW + 60_000, canDispatch: false }).state;
	const shutdown = reduceWatchLoop(due, { type: "shutdown", now: NOW + 61_000, reason: "session tree changed" });
	assert.equal(shutdown.state.status, "stopped");
	assert.equal(shutdown.state.due, false);
	assert.equal(shutdown.state.nextRunAt, undefined);
	assert.equal(shutdown.state.lastReason, "session tree changed");
	assert.ok(effect(shutdown.effects, "clear_timer"));
});
