import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import piStatusline from "./pi-statusline.ts";

type Handler = (event: any, context: any) => unknown;

function registeredHandlers(): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	piStatusline({
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		getSessionName() {
			return "layout-test-session";
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

type Footer = { render(width: number): string[]; dispose(): void };

async function withFooter(run: (footer: Footer, statuses: Map<string, string>) => void) {
	let footerFactory: any;
	let component: Footer | undefined;
	const statuses = new Map<string, string>();
	const environment = [
		"PI_STATUSLINE_K8S_CONTEXT",
		"PI_STATUSLINE_CODEX_QUOTA",
		"PI_STATUSLINE_OPENROUTER_CREDITS",
		"PI_STATUSLINE_BEADS",
		"PI_STATUSLINE_GIT_DIVERGENCE",
		"PI_STATUSLINE_PR",
		"PI_STATUSLINE_GUARD_EMOJI",
		"PI_STATUSLINE",
	] as const;
	const previous = new Map(environment.map((name) => [name, process.env[name]]));
	for (const name of environment.slice(0, 6)) process.env[name] = "0";
	process.env.PI_STATUSLINE_GUARD_EMOJI = "1";
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
		await registeredHandlers().get("session_start")?.({}, ctx);
		assert.ok(footerFactory);
		component = footerFactory(
			{ requestRender() {} },
			{
				fg: (_tone: string, text: string) => `\x1b[32m${text}\x1b[0m`,
				bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
			},
			{
				getGitBranch: () => "feature/statusline-layout-test",
				getExtensionStatuses: () => statuses,
				onBranchChange: () => () => undefined,
			},
		);
		assert.ok(component);
		run(component, statuses);
	} finally {
		component?.dispose();
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

function verifyLayouts(footer: Footer, expectedGuard: string) {
	for (const layout of ["compact", "table"]) {
		process.env.PI_STATUSLINE = layout;
		for (const width of [1, 8, 20, 30, 80, 120, 180]) {
			const lines = footer.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `${layout} at ${width}`);
			if (layout === "table" && width === 180) {
				assert.equal(lines.length, 5);
				assert.equal(new Set(lines.map(visibleWidth)).size, 1);
			}
			if (layout === "compact" || width === 30) assert.equal(lines.length, 1);
			const plain = stripVTControlCharacters(lines.join("\n"));
			assert.doesNotMatch(plain, /leases:|api, web|🔒cwd|\x00|\x9b/);
			if (width >= 30) {
				const cells = plain.split(/[│\n]/).map((cell) => cell.trim());
				assert.equal(cells.filter((cell) => cell === expectedGuard).length, 1, `${layout} at ${width}: ${plain}`);
			}
		}
	}
}

for (const emojiEnabled of [true, false]) {
	for (const count of [1, 2, 32]) {
		test(`unifies ${count} worktree leases in emoji=${emojiEnabled} layouts`, () => withFooter((footer, statuses) => {
			process.env.PI_STATUSLINE_GUARD_EMOJI = emojiEnabled ? "1" : "0";
			statuses.set("session-mode", "\x1b[32mimplement\x1b[0m");
			statuses.set("session-mode-leases", `\x1b[32mleases:${count} api, web\x00\x9b\x1b[0m`);
			const suffix = count > 1 ? String(count) : "";
			verifyLayouts(footer, emojiEnabled ? `🔒${suffix}` : `implement${suffix ? ` ${suffix}` : ""}`);
		}));
	}
}

test("keeps non-implement states distinct without persistent lease or occupancy cells", () => withFooter((footer, statuses) => {
	statuses.set("session-mode-leases", "leases:32 api, web");
	for (const [state, emoji] of [["acquiring", "⏳"], ["plan", "🔍"], ["conflict", "⛔"], ["lost", "💥"], ["unguarded", "🚨"]]) {
		statuses.set("session-mode", `\x1b[31m${state}\x1b[0m`);
		process.env.PI_STATUSLINE_GUARD_EMOJI = "1";
		verifyLayouts(footer, emoji!);
		process.env.PI_STATUSLINE_GUARD_EMOJI = "0";
		verifyLayouts(footer, state!);
	}
}));

test("updates the unified cell as scopes change and disappear", () => withFooter((footer, statuses) => {
	statuses.set("session-mode", "implement");
	for (const [scopes, guard] of [["leases:2 api, web", "🔒2"], ["leases:1 child", "🔒"], ["leases:0", "✅"], ["invalid", "✅"], ["", "✅"]]) {
		statuses.set("session-mode-leases", scopes!);
		verifyLayouts(footer, guard!);
	}
	statuses.delete("session-mode");
	statuses.delete("session-mode-leases");
	assert.doesNotMatch(footer.render(180).join("\n"), /🔒|✅|leases:/);
}));
