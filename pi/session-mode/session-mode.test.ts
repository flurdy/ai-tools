import assert from "node:assert/strict";
import test from "node:test";
import type { HeldWorktreeLease, WorktreeLeaseResult } from "./lease.ts";
import { registerSessionMode, type SessionModeDependencies } from "./session-mode.ts";

type Handler = (event: any, context: any) => unknown;

class FakePi {
	readonly handlers = new Map<string, Handler[]>();
	readonly commands = new Map<string, { handler: Handler }>();
	readonly appended: Array<{ type: string; data: unknown }> = [];
	readonly activeToolHistory: string[][] = [];
	readonly execCalls: string[][] = [];
	activeTools = ["read", "bash", "edit", "write", "questionnaire", "subagent"];
	planFlag = false;
	implementFlag = false;

	registerFlag(): void {}
	getFlag(name: string): boolean { return name === "plan" ? this.planFlag : name === "implement" ? this.implementFlag : false; }
	on(name: string, handler: Handler): void { this.handlers.set(name, [...(this.handlers.get(name) ?? []), handler]); }
	registerCommand(name: string, command: { handler: Handler }): void { this.commands.set(name, command); }
	getActiveTools(): string[] { return [...this.activeTools]; }
	setActiveTools(names: string[]): void { this.activeTools = [...names]; this.activeToolHistory.push([...names]); }
	appendEntry(type: string, data: unknown): void { this.appended.push({ type, data }); }
	async exec(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		this.execCalls.push([command, ...args]);
		return { code: 0, stdout: "", stderr: "" };
	}
	async emit(name: string, ctx: ReturnType<typeof context>, event: any = {}): Promise<unknown[]> {
		const results = [];
		for (const handler of this.handlers.get(name) ?? []) results.push(await handler(event, ctx));
		return results;
	}
}

function context(branch: any[] = []) {
	const statuses: Array<string | undefined> = [];
	const notifications: Array<{ message: string; level?: string }> = [];
	const ctx = {
		cwd: "/repo",
		mode: "tui",
		hasUI: true,
		idle: true,
		isIdle: () => ctx.idle,
		hasPendingMessages: () => false,
		sessionManager: { getBranch: () => branch, getSessionId: () => "session-1" },
		ui: {
			theme: { fg: (_tone: string, text: string) => text },
			setStatus: (_key: string, value: string | undefined) => statuses.push(value),
			notify: (message: string, level?: string) => notifications.push({ message, level }),
		},
	};
	return Object.assign(ctx, { statuses, notifications });
}

function held(releaseLog: string[] = []): HeldWorktreeLease {
	return {
		kind: "held",
		root: "/repo",
		holderPid: 123,
		lost: new Promise(() => undefined),
		async release() { releaseLog.push("release"); },
	};
}

function harness(results: WorktreeLeaseResult[] = [held()], options: Partial<SessionModeDependencies> = {}) {
	const pi = new FakePi();
	const acquisitions: string[] = [];
	const dependencies: SessionModeDependencies = {
		acquireLease: async () => {
			acquisitions.push("acquire");
			const result = results.shift();
			assert.ok(result);
			return result;
		},
		isDisabled: () => false,
		...options,
	};
	const controller = registerSessionMode(pi as never, dependencies);
	return { pi, acquisitions, controller };
}

test("defaults to implement and acquires before reporting write authority", async () => {
	const { pi, acquisitions, controller } = harness();
	const ctx = context();
	await pi.emit("session_start", ctx);
	assert.deepEqual(acquisitions, ["acquire"]);
	assert.equal(controller.state, "implement");
	assert.equal(ctx.statuses.at(-1), "implement");
	assert.deepEqual(pi.activeTools, ["read", "bash", "edit", "write", "questionnaire", "subagent"]);
});

test("explicit --plan wins over restored implement state and takes no lease", async () => {
	const branch = [{ type: "custom", customType: "session-mode", data: { version: 1, mode: "implement" } }];
	const { pi, acquisitions, controller } = harness([]);
	pi.planFlag = true;
	const ctx = context(branch);
	await pi.emit("session_start", ctx);
	assert.deepEqual(acquisitions, []);
	assert.equal(controller.state, "plan");
	assert.deepEqual(pi.activeTools, ["read", "bash", "questionnaire", "subagent"]);
});

test("restores plan only from the active branch", async () => {
	const activeBranch = [{ type: "custom", customType: "session-mode", data: { version: 1, mode: "plan" } }];
	const { pi, acquisitions, controller } = harness([]);
	await pi.emit("session_start", context(activeBranch));
	assert.equal(controller.state, "plan");
	assert.deepEqual(acquisitions, []);
});

test("explicit launcher implement mode wins over restored plan state", async () => {
	const activeBranch = [{ type: "custom", customType: "session-mode", data: { version: 1, mode: "plan" } }];
	const { pi, acquisitions, controller } = harness();
	pi.implementFlag = true;
	await pi.emit("session_start", context(activeBranch));
	assert.equal(controller.state, "implement");
	assert.deepEqual(acquisitions, ["acquire"]);
});

test("rejects both mode changes while Pi is busy", async () => {
	const implement = harness();
	const implementContext = context();
	await implement.pi.emit("session_start", implementContext);
	implementContext.idle = false;
	await implement.pi.commands.get("plan")?.handler("", implementContext);
	assert.equal(implement.controller.state, "implement");
	assert.equal(implement.pi.appended.length, 0);
	assert.match(implementContext.notifications.at(-1)?.message ?? "", /busy/i);

	const plan = harness([]);
	plan.pi.planFlag = true;
	const planContext = context();
	await plan.pi.emit("session_start", planContext);
	planContext.idle = false;
	await plan.pi.commands.get("implement")?.handler("", planContext);
	assert.equal(plan.controller.state, "plan");
	assert.deepEqual(plan.acquisitions, []);
	assert.equal(plan.pi.appended.length, 0);
});

test("plan disables writes before releasing, warns when dirty, and persists", async () => {
	const order: string[] = [];
	const lease = held(order);
	const { pi, controller } = harness([lease]);
	pi.setActiveTools = (names: string[]) => { order.push("guard"); pi.activeTools = [...names]; };
	pi.exec = async () => ({ code: 0, stdout: " M file.ts\n", stderr: "" });
	const ctx = context();
	await pi.emit("session_start", ctx);
	order.length = 0;
	await pi.commands.get("plan")?.handler("", ctx);
	assert.deepEqual(order, ["guard", "release"]);
	assert.equal(controller.state, "plan");
	assert.match(ctx.notifications.map((n) => n.message).join("\n"), /dirty/i);
	assert.deepEqual(pi.appended.at(-1), { type: "session-mode", data: { version: 1, mode: "plan" } });
});

test("clean /plan transition does not emit a dirty-worktree warning", async () => {
	const { pi } = harness();
	const ctx = context();
	await pi.emit("session_start", ctx);
	await pi.commands.get("plan")?.handler("", ctx);
	assert.doesNotMatch(ctx.notifications.map((n) => n.message).join("\n"), /dirty/i);
});

test("guarded state independently blocks hidden tools, mutating Bash, and subagents", async () => {
	const { pi } = harness([]);
	const ctx = context();
	pi.planFlag = true;
	await pi.emit("session_start", ctx);
	for (const [toolName, input] of [
		["write", { path: "x", content: "x" }],
		["bash", { command: "git commit -m nope" }],
		["subagent", { agent: "worker" }],
	] as const) {
		const [result] = await pi.emit("tool_call", ctx, { toolName, input });
		assert.equal((result as { block?: boolean })?.block, true, toolName);
	}
	const [readResult] = await pi.emit("tool_call", ctx, { toolName: "read", input: { path: "x" } });
	assert.equal(readResult, undefined);
});

test("keeps writes guarded until /implement finishes acquiring", async () => {
	let resolveLease: ((result: WorktreeLeaseResult) => void) | undefined;
	const pending = new Promise<WorktreeLeaseResult>((resolve) => (resolveLease = resolve));
	const { pi, controller } = harness([], { acquireLease: async () => pending });
	pi.planFlag = true;
	const ctx = context();
	await pi.emit("session_start", ctx);
	const transition = pi.commands.get("implement")?.handler("", ctx);
	await Promise.resolve();
	assert.equal(controller.state, "acquiring");
	assert.equal(pi.activeTools.includes("write"), false);
	resolveLease?.(held());
	await transition;
	assert.equal(controller.state, "implement");
	assert.equal(pi.activeTools.includes("write"), true);
});

test("contention and holder loss use the same guarded tool path", async () => {
	const contended = harness([{ kind: "contended", root: "/repo", holder: { root: "/repo", pid: 9, parentPid: 8, sessionId: "other", startedAt: "now" } }]);
	const contendedContext = context();
	await contended.pi.emit("session_start", contendedContext);
	assert.equal(contended.controller.state, "implement-blocked");
	assert.equal(contended.pi.activeTools.includes("write"), false);
	assert.match(contendedContext.notifications.at(-1)?.message ?? "", /other/);

	let lose: (() => void) | undefined;
	const lostLease: HeldWorktreeLease = {
		kind: "held",
		root: "/repo",
		holderPid: 10,
		lost: new Promise<void>((resolve) => (lose = resolve)),
		async release() {},
	};
	const lost = harness([lostLease]);
	const lostContext = context();
	await lost.pi.emit("session_start", lostContext);
	lose?.();
	await Promise.resolve();
	assert.equal(lost.controller.state, "lost");
	assert.equal(lost.pi.activeTools.includes("write"), false);
});

test("headless plan mode guards without prompting", async () => {
	const { pi, controller } = harness([]);
	pi.planFlag = true;
	const ctx = context();
	ctx.mode = "print";
	ctx.hasUI = false;
	await pi.emit("session_start", ctx);
	assert.equal(controller.state, "plan");
	assert.deepEqual(ctx.notifications, []);
	const [result] = await pi.emit("tool_call", ctx, { toolName: "write", input: { path: "x" } });
	assert.equal((result as { block?: boolean })?.block, true);
});

test("kill switch fails open with a prominent unguarded status", async () => {
	const { pi, acquisitions, controller } = harness([], { isDisabled: () => true });
	pi.planFlag = true;
	const ctx = context();
	await pi.emit("session_start", ctx);
	assert.deepEqual(acquisitions, []);
	assert.equal(controller.state, "unguarded");
	assert.equal(pi.activeTools.includes("write"), true);
	assert.equal(ctx.statuses.at(-1), "unguarded");
});

test("an already implementing session does not contend with its own lease", async () => {
	const { pi, acquisitions, controller } = harness();
	const ctx = context();
	await pi.emit("session_start", ctx);
	await pi.commands.get("implement")?.handler("", ctx);
	assert.deepEqual(acquisitions, ["acquire"]);
	assert.equal(controller.state, "implement");
});

test("reload lifecycle releases before reacquiring and exposes a lost race as conflict", async () => {
	const releases: string[] = [];
	const { pi, acquisitions, controller } = harness([
		held(releases),
		{ kind: "contended", root: "/repo" },
	]);
	const ctx = context();
	await pi.emit("session_start", ctx);
	await pi.emit("session_shutdown", ctx, { reason: "reload" });
	await pi.emit("session_start", ctx, { reason: "reload" });
	assert.deepEqual(releases, ["release"]);
	assert.deepEqual(acquisitions, ["acquire", "acquire"]);
	assert.equal(controller.state, "implement-blocked");
	assert.equal(ctx.statuses.at(-1), "conflict");
});

test("shutdown releases the held lease, restores tools, and clears status", async () => {
	const releases: string[] = [];
	const { pi } = harness([held(releases)]);
	const ctx = context();
	await pi.emit("session_start", ctx);
	await pi.commands.get("plan")?.handler("", ctx);
	await pi.emit("session_shutdown", ctx);
	assert.deepEqual(releases, ["release"]);
	assert.equal(pi.activeTools.includes("write"), true);
	assert.equal(ctx.statuses.at(-1), undefined);
});
