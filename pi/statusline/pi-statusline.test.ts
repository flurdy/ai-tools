import assert from "node:assert/strict";
import test from "node:test";
import piStatusline from "./pi-statusline.ts";

type Handler = (event: any, context: any) => unknown;

function registeredHandlers(): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	piStatusline({
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	} as never);
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
