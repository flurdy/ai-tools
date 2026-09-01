import assert from "node:assert/strict";
import test from "node:test";
import piStatusline from "./pi-statusline.ts";

type Handler = (event: any, context: any) => unknown;

function registeredHandlers(dependencies?: unknown): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	piStatusline({
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		getSessionName() {
			return "layout-test-session";
		},
	} as never, dependencies as never);
	return handlers;
}

function model(provider = "openrouter") {
	return {
		provider,
		id: "openai/statusline-integration-test",
		cost: { input: 5 },
	};
}

function context(sessionId: string, tokens: number | null, notifications: string[], activeModel = model()) {
	return {
		model: activeModel,
		getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: tokens === null ? null : tokens / 10_000 }),
		sessionManager: { getSessionId: () => sessionId },
		ui: { notify: (message: string) => notifications.push(message) },
	};
}

test("wires manual model selection to a visible OpenRouter warning", () => {
	const notifications: string[] = [];
	const handlers = registeredHandlers();
	const selectedModel = model();

	handlers.get("model_select")?.(
		{ model: selectedModel, previousModel: undefined, source: "set" },
		context("integration-model-select", 200_000, notifications, selectedModel),
	);

	assert.equal(notifications.length, 1);
	assert.match(notifications[0] ?? "", /OpenRouter cost warning/);
});

test("includes a submitted prompt when it crosses the first-request threshold", () => {
	const notifications: string[] = [];
	const handlers = registeredHandlers();

	handlers.get("before_agent_start")?.(
		{ prompt: "four", images: undefined, systemPrompt: "", systemPromptOptions: {} },
		context("integration-prompt", 99_999, notifications),
	);

	assert.equal(notifications.length, 1);
	assert.match(notifications[0] ?? "", /100,000 context tokens/);
});

test("wires continuing turns to threshold crossing without tool-loop spam", () => {
	const notifications: string[] = [];
	const handlers = registeredHandlers();
	const turn = handlers.get("turn_start");

	turn?.({ turnIndex: 0, timestamp: 0 }, context("integration-turn", 99_999, notifications));
	turn?.({ turnIndex: 1, timestamp: 1 }, context("integration-turn", 100_000, notifications));
	turn?.({ turnIndex: 2, timestamp: 2 }, context("integration-turn", 100_000, notifications));

	assert.equal(notifications.length, 1);
});

test("pins emoji guard and plan occupancy cells in narrow and wide footer layouts", async () => {
	const handlers = registeredHandlers({
		probeLeaseOccupancy: async () => ({ kind: "held", root: "/tmp" }),
	});
	let footerFactory: any;
	let component: any;
	let sessionMode = "implement";
	const environment = [
		"PI_STATUSLINE_K8S_CONTEXT",
		"PI_STATUSLINE_CODEX_QUOTA",
		"PI_STATUSLINE_OPENROUTER_CREDITS",
		"PI_STATUSLINE_BEADS",
		"PI_STATUSLINE_GIT_DIVERGENCE",
		"PI_STATUSLINE_GUARD_OCCUPANCY_SETTLE",
		"PI_STATUSLINE",
	] as const;
	const previous = new Map(environment.map((name) => [name, process.env[name]]));
	for (const name of environment.slice(0, 5)) process.env[name] = "0";
	process.env.PI_STATUSLINE_GUARD_OCCUPANCY_SETTLE = "0";
	try {
		const ctx = {
			cwd: "/tmp",
			mode: "tui",
			model: { provider: "test", id: "model", contextWindow: 1000 },
			getContextUsage: () => ({ tokens: 0 }),
			sessionManager: { getBranch: () => [] },
			ui: {
				setWidget() {},
				setFooter(factory: any) { footerFactory = factory; },
			},
		};
		await handlers.get("session_start")?.({}, ctx);
		assert.ok(footerFactory);
		component = footerFactory(
			{ requestRender() {} },
			{
				fg: (_tone: string, text: string) => text,
				bold: (text: string) => text,
			},
			{
				getGitBranch: () => "feature/statusline-layout-test",
				getExtensionStatuses: () => new Map([["session-mode", sessionMode]]),
				onBranchChange: () => () => undefined,
			},
		);
		const expected = new Map([
			["acquiring", "⏳"],
			["implement", "✅"],
			["plan", "🔍"],
			["conflict", "⛔"],
			["lost", "💥"],
			["unguarded", "🚨"],
		]);
		for (const [state, emoji] of expected) {
			sessionMode = state;
			process.env.PI_STATUSLINE = "compact";
			assert.match(component.render(30).join("\n"), new RegExp(emoji));
			process.env.PI_STATUSLINE = "table";
			const wide = component.render(120);
			assert.ok(wide.length > 1);
			assert.match(wide.join("\n"), new RegExp(emoji));
		}

		sessionMode = "plan";
		process.env.PI_STATUSLINE = "compact";
		component.render(30);
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(component.render(30).join("\n"), /🔍\s*│\s*🔒/);
		process.env.PI_STATUSLINE = "table";
		const occupiedTable = component.render(120);
		assert.ok(occupiedTable.length > 1);
		assert.match(occupiedTable.join("\n"), /🔍\s*│\s*🔒/);
		sessionMode = "implement";
		assert.doesNotMatch(component.render(120).join("\n"), /🔒/);
	} finally {
		component?.dispose();
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
});
