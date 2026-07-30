import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	RegisteredCommand,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	formatWatchStatus,
	registerWatchLoopExtension,
	type WatchLoopControllerDependencies,
} from "./index.ts";

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);

type EventHandler = (event: { type: string }, ctx: ExtensionContext) => unknown;

class FakePi {
	readonly tools = new Map<string, ToolDefinition>();
	readonly commands = new Map<string, RegisteredCommand>();
	readonly events = new Map<string, EventHandler[]>();
	readonly messages: string[] = [];
	throwOnSend = false;

	registerTool(tool: ToolDefinition): void {
		this.tools.set(tool.name, tool);
	}

	registerCommand(name: string, command: RegisteredCommand): void {
		this.commands.set(name, command);
	}

	on(name: string, handler: EventHandler): void {
		const handlers = this.events.get(name) ?? [];
		handlers.push(handler);
		this.events.set(name, handlers);
	}

	sendUserMessage(prompt: string): void {
		if (this.throwOnSend) throw new Error("Pi became busy");
		this.messages.push(prompt);
	}

	async emit(name: string, ctx: ExtensionContext): Promise<void> {
		for (const handler of this.events.get(name) ?? []) await handler({ type: name }, ctx);
	}
}

interface FakeTimer {
	callback: () => void;
	delay: number;
	cleared: boolean;
}

class FakeTimers {
	readonly timers: FakeTimer[] = [];

	setTimer = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
		const timer: FakeTimer = { callback, delay, cleared: false };
		this.timers.push(timer);
		return timer as unknown as ReturnType<typeof setTimeout>;
	};

	clearTimer = (handle: ReturnType<typeof setTimeout>): void => {
		(handle as unknown as FakeTimer).cleared = true;
	};

	fire(index: number): void {
		const timer = this.timers[index];
		if (!timer) return;
		timer.cleared = true;
		timer.callback();
	}

	active(): FakeTimer[] {
		return this.timers.filter((timer) => !timer.cleared);
	}
}

interface UiProbe {
	statuses: Array<string | undefined>;
	notifications: Array<{ message: string; level: string }>;
}

function context(probe: UiProbe, mode: ExtensionContext["mode"] = "tui"): ExtensionContext & { idle: boolean; pending: boolean } {
	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		cwd: "/tmp/watch-loop",
		idle: true,
		pending: false,
		isIdle: () => ctx.idle,
		hasPendingMessages: () => ctx.pending,
		ui: {
			setStatus(_key: string, value: string | undefined) {
				probe.statuses.push(value);
			},
			notify(message: string, level: string) {
				probe.notifications.push({ message, level });
			},
		},
	} as unknown as ExtensionContext & { idle: boolean; pending: boolean };
	return ctx;
}

function harness(options: { disabled?: boolean } = {}) {
	const pi = new FakePi();
	const timers = new FakeTimers();
	const probe: UiProbe = { statuses: [], notifications: [] };
	let now = NOW;
	const dependencies: WatchLoopControllerDependencies = {
		now: () => now,
		setTimer: timers.setTimer,
		clearTimer: timers.clearTimer,
		createWatchId: () => "watch-1",
		isDisabled: () => options.disabled === true,
	};
	const controller = registerWatchLoopExtension(pi as unknown as ExtensionAPI, dependencies);
	return { pi, timers, probe, controller, setNow: (value: number) => (now = value) };
}

async function callTool(
	pi: FakePi,
	params: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<Awaited<ReturnType<ToolDefinition["execute"]>>> {
	const tool = pi.tools.get("watch_loop");
	assert.ok(tool);
	return tool.execute("call-1", params, undefined, undefined, ctx);
}

function startParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		action: "start",
		protocolVersion: 1,
		label: "PRs",
		tickPrompt: "Load and follow the `pr-status` skill now, render its dashboard, then complete the watch tick.",
		mode: "fixed",
		initialDelaySeconds: 60,
		intervalSeconds: 120,
		missedCompletionPolicy: "retry",
		maxTicks: 5,
		...overrides,
	};
}

test("registers one sequential tool, three commands, and lifecycle handlers without arming a timer", async () => {
	const { pi, timers, probe } = harness();
	assert.equal(pi.tools.get("watch_loop")?.executionMode, "sequential");
	assert.deepEqual([...pi.commands.keys()], ["watch-status", "watch-stop", "watch-resume"]);
	assert.ok(pi.events.has("session_start"));
	assert.ok(pi.events.has("agent_settled"));
	assert.ok(pi.events.has("session_shutdown"));
	assert.ok(pi.events.has("session_tree"));

	const ctx = context(probe);
	await pi.emit("session_start", ctx);
	assert.equal(timers.timers.length, 0);
	assert.equal(probe.statuses.at(-1), undefined);
});

test("reports protocol version and complete idle status without terminating the turn", async () => {
	const { pi, probe, controller } = harness();
	const result = await callTool(pi, { action: "status" }, context(probe, "print"));
	assert.equal(result.terminate, undefined);
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /Protocol: 1/);
	assert.equal((result.details as { state: { status: string } }).state.status, "idle");
	assert.equal(controller.state.status, "idle");
});

test("rejects start in every non-TUI mode without arming timers", async () => {
	for (const mode of ["rpc", "json", "print"] as const) {
		const { pi, timers, probe, controller } = harness();
		await assert.rejects(callTool(pi, startParams(), context(probe, mode)), /interactive TUI/);
		assert.equal(controller.state.status, "idle");
		assert.equal(timers.timers.length, 0);
	}
});

test("kill switch refuses start while status remains available", async () => {
	const { pi, timers, probe } = harness({ disabled: true });
	const ctx = context(probe);
	await callTool(pi, { action: "status" }, ctx);
	await assert.rejects(callTool(pi, startParams(), ctx), /PI_WATCH_LOOP_DISABLED/);
	assert.equal(timers.timers.length, 0);
});

test("starts, dispatches, and reschedules a fixed watch from completion time", async () => {
	const { pi, timers, probe, controller, setNow } = harness();
	const ctx = context(probe);
	const started = await callTool(pi, startParams(), ctx);
	assert.equal(started.terminate, true);
	assert.equal(controller.state.status, "armed");
	assert.equal(timers.active()[0]?.delay, 60_000);
	assert.match(probe.statuses.at(-1) ?? "", /watch: PRs/);

	setNow(NOW + 60_000);
	timers.fire(0);
	assert.equal(controller.state.status, "running");
	assert.equal(controller.state.generation, 1);
	assert.equal(pi.messages.length, 1);
	assert.match(pi.messages[0] ?? "", /watch-loop protocol 1 tick watch-1\/1/);
	assert.match(pi.messages[0] ?? "", /watch_loop complete/);

	setNow(NOW + 90_000);
	const completed = await callTool(
		pi,
		{ action: "complete", protocolVersion: 1, watchId: "watch-1", generation: 1, outcome: "continue" },
		ctx,
	);
	assert.equal(completed.terminate, true);
	assert.equal(controller.state.status, "armed");
	assert.equal(controller.state.nextRunAt, NOW + 210_000);
	assert.equal(timers.active()[0]?.delay, 120_000);

	await pi.emit("agent_settled", ctx);
	assert.equal(controller.state.status, "armed");
	assert.equal(controller.state.consecutiveMisses, 0);
});

test("keeps deadline enforcement active while a tick is running", async () => {
	const { pi, timers, probe, controller, setNow } = harness();
	const ctx = context(probe);
	await callTool(
		pi,
		startParams({ maxTicks: undefined, stopAt: new Date(NOW + 120_000).toISOString() }),
		ctx,
	);
	assert.equal(timers.active().length, 2);
	setNow(NOW + 60_000);
	timers.fire(0);
	assert.equal(controller.state.status, "running");
	setNow(NOW + 120_000);
	timers.fire(1);
	assert.equal(controller.state.status, "stopped");
	assert.equal(controller.state.generation, 2);
	assert.equal(timers.active().length, 0);
});

test("coalesces a busy timer and stale timer callback into one dispatch", async () => {
	const { pi, timers, probe, controller, setNow } = harness();
	const ctx = context(probe);
	await callTool(pi, startParams(), ctx);

	ctx.idle = false;
	setNow(NOW + 60_000);
	timers.fire(0);
	assert.equal(controller.state.due, true);
	assert.equal(pi.messages.length, 0);

	ctx.idle = true;
	await pi.emit("agent_settled", ctx);
	assert.equal(pi.messages.length, 1);
	assert.equal(controller.state.status, "running");

	timers.fire(0);
	assert.equal(pi.messages.length, 1);
});

test("pauses without a timer when sendUserMessage loses the idle race", async () => {
	const { pi, timers, probe, controller, setNow } = harness();
	const ctx = context(probe);
	await callTool(pi, startParams(), ctx);
	pi.throwOnSend = true;
	setNow(NOW + 60_000);
	timers.fire(0);
	assert.equal(controller.state.status, "paused");
	assert.equal(timers.active().length, 0);
	assert.match(probe.notifications.at(-1)?.message ?? "", /Pi became busy/);
});

test("user stop invalidates a running generation and rejects its late completion", async () => {
	const { pi, timers, probe, controller, setNow } = harness();
	const ctx = context(probe);
	await callTool(pi, startParams(), ctx);
	setNow(NOW + 60_000);
	timers.fire(0);

	const stop = pi.commands.get("watch-stop");
	assert.ok(stop);
	await stop.handler("", ctx as never);
	assert.equal(controller.state.status, "stopped");
	assert.equal(controller.state.generation, 2);
	await assert.rejects(
		callTool(
			pi,
			{ action: "complete", protocolVersion: 1, watchId: "watch-1", generation: 1, outcome: "continue" },
			ctx,
		),
		/no running watch tick/,
	);
	assert.equal(timers.active().length, 0);
});

test("adaptive completion without a delay applies the pause policy and terminates safely", async () => {
	const { pi, timers, probe, controller, setNow } = harness();
	const ctx = context(probe);
	await callTool(
		pi,
		startParams({ mode: "adaptive", intervalSeconds: undefined, missedCompletionPolicy: "pause" }),
		ctx,
	);
	setNow(NOW + 60_000);
	timers.fire(0);
	const result = await callTool(
		pi,
		{ action: "complete", protocolVersion: 1, watchId: "watch-1", generation: 1, outcome: "continue" },
		ctx,
	);
	assert.equal(result.terminate, true);
	assert.equal(controller.state.status, "paused");
	assert.equal(timers.active().length, 0);
});

test("resume schedules an immediate generation and shutdown clears it without persistence", async () => {
	const { pi, timers, probe, controller, setNow } = harness();
	const ctx = context(probe);
	await callTool(
		pi,
		startParams({ missedCompletionPolicy: "pause" }),
		ctx,
	);
	setNow(NOW + 60_000);
	timers.fire(0);
	await pi.emit("agent_settled", ctx);
	assert.equal(controller.state.status, "paused");

	const resume = pi.commands.get("watch-resume");
	assert.ok(resume);
	await resume.handler("", ctx as never);
	assert.equal(controller.state.status, "armed");
	assert.equal(timers.active()[0]?.delay, 0);

	await pi.emit("session_shutdown", ctx);
	assert.equal(controller.state.status, "stopped");
	assert.equal(timers.active().length, 0);
	assert.equal(probe.statuses.at(-1), undefined);
});

test("tree navigation stops the in-memory watch instead of carrying it to another branch", async () => {
	const { pi, timers, probe, controller } = harness();
	const ctx = context(probe);
	await callTool(pi, startParams(), ctx);
	await pi.emit("session_tree", ctx);
	assert.equal(controller.state.status, "stopped");
	assert.equal(controller.state.lastReason, "session tree changed");
	assert.equal(timers.active().length, 0);
	assert.equal(probe.statuses.at(-1), undefined);
});

test("status text exposes cadence, budget, misses, reason, and explicit bounds", async () => {
	const { pi, probe, controller } = harness();
	const ctx = context(probe);
	await callTool(pi, startParams({ maxTicks: 3, stopAt: new Date(NOW + 3_600_000).toISOString() }), ctx);
	const text = formatWatchStatus(controller.state, NOW);
	assert.match(text, /Protocol: 1/);
	assert.match(text, /State: armed/);
	assert.match(text, /Mode: fixed/);
	assert.match(text, /Ticks: 0\/3/);
	assert.match(text, /Consecutive misses: 0/);
	assert.match(text, /Deadline: 2026-/);
	assert.match(text, /Last reason: watch started/);
});
