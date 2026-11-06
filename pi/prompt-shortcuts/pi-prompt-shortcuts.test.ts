import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerPromptShortcuts, { PRESETS, describeKeyProbeInput } from "./pi-prompt-shortcuts.ts";

type InputListener = (data: string) => { consume?: boolean; data?: string } | undefined;

function harness(options: { probeTimeoutMs?: number; runtimeVersion?: () => Promise<string> } = {}) {
	const shortcuts = new Map<string, (ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => unknown>();
	const events = new Map<string, (event?: unknown, ctx?: ExtensionContext) => unknown>();
	const sent: string[] = [];
	const sendOptions: unknown[] = [];
	const notices: string[] = [];
	const listeners = new Set<InputListener>();
	let availableCommands = [{ name: "plan", source: "extension" }, { name: "implement", source: "extension" }];
	let scopeInput: () => Promise<string | undefined> = async () => undefined;
	let throwOnSend = false;
	registerPromptShortcuts({
		registerShortcut: (key: string, options: { handler: (ctx: ExtensionContext) => unknown }) => shortcuts.set(key, options.handler),
		registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => unknown }) => commands.set(name, options.handler),
		on: (name: string, handler: (event?: unknown, ctx?: ExtensionContext) => unknown) => events.set(name, handler),
		getCommands: () => availableCommands,
		sendUserMessage: (text: string, options?: unknown) => {
			if (throwOnSend) throw new Error("send failed");
			sent.push(text);
			sendOptions.push(options);
		},
	} as unknown as ExtensionAPI, { runtimeVersion: async () => "1.4.0", ...options });
	function context(state: {
		idle?: boolean; pending?: boolean; mode?: string; draft?: string | Error;
	} = {}): ExtensionContext {
		return {
			mode: state.mode ?? "tui", isIdle: () => state.idle ?? true, hasPendingMessages: () => state.pending ?? false,
			ui: {
				notify: (message: string) => notices.push(message),
				getEditorText: () => { if (state.draft instanceof Error) throw state.draft; return state.draft ?? ""; },
				setEditorText: (text: string) => { state.draft = text; },
				input: () => scopeInput(),
				onTerminalInput: (listener: InputListener) => { listeners.add(listener); return () => listeners.delete(listener); },
			},
		} as unknown as ExtensionContext;
	}
	/** Mirrors pi-tui: transformations chain, consumption stops focus routing. */
	function input(data: string): { data: string; consumed: boolean } {
		for (const listener of listeners) {
			const result = listener(data);
			if (result?.consume) return { data, consumed: true };
			if (result?.data !== undefined) data = result.data;
		}
		return { data, consumed: false };
	}
	const start = (options = {}) => events.get("session_start")!({}, context(options));
	return {
		shortcuts, commands, events, sent, sendOptions, notices, listeners, context, input, start,
		failSend: () => { throwOnSend = true; },
		setCommands: (value: typeof availableCommands) => { availableCommands = value; },
		setScopeInput: (value: typeof scopeInput) => { scopeInput = value; },
	};
}

test("registers quick prompts, draft replies, mode actions and the key probe", () => {
	const h = harness();
	assert.deepEqual([...h.commands.keys()], ["quick-continue", "quick-checkpoint", "quick-unblock", "quick-why", "quick-yes", "quick-approved", "quick-plan", "quick-implement", "quick-keyprobe"]);
	assert.deepEqual([...h.shortcuts.keys()], ["shift+alt+c", "shift+alt+s", "shift+alt+u", "shift+alt+w", "shift+alt+y", "shift+alt+a", "shift+alt+p", "shift+alt+i"]);
	assert.deepEqual(h.sent, []);
});

for (const preset of PRESETS) {
	test(`${preset.name}: shortcut and command send the same fixed text`, async () => {
		const shortcut = harness();
		shortcut.shortcuts.get(preset.shortcut)!(shortcut.context());
		assert.deepEqual(shortcut.sent, [preset.text]);
		const command = harness();
		await command.commands.get(`quick-${preset.name}`)!("  ", command.context());
		assert.deepEqual(command.sent, [preset.text]);
	});

	test(`${preset.name}: busy, queued and non-TUI contexts cannot send`, async () => {
		for (const options of [{ idle: false }, { pending: true }, { mode: "rpc" }, { mode: "json" }, { mode: "print" }]) {
			const h = harness();
			h.shortcuts.get(preset.shortcut)!(h.context(options));
			await h.commands.get(`quick-${preset.name}`)!("", h.context(options));
			assert.deepEqual(h.sent, []);
		}
	});

	test(`${preset.name}: preserve drafts and fail closed when editor cannot be read`, () => {
		for (const draft of ["half typed", " ", "\n", new Error("unavailable")]) {
			const h = harness();
			h.shortcuts.get(preset.shortcut)!(h.context({ draft }));
			assert.deepEqual(h.sent, []);
			assert.equal(h.notices.length, 1);
		}
	});

	test(`${preset.name}: reject command arguments rather than discard qualifications`, async () => {
		const h = harness();
		await h.commands.get(`quick-${preset.name}`)!("but don't edit anything", h.context());
		assert.deepEqual(h.sent, []);
		assert.match(h.notices[0]!, /arguments/);
	});
}

test("cross-preset double presses are refused before the host becomes busy", async () => {
	const h = harness();
	h.shortcuts.get(PRESETS[0].shortcut)!(h.context());
	h.shortcuts.get(PRESETS[1].shortcut)!(h.context());
	await h.commands.get("quick-why")!("", h.context());
	assert.equal(h.sent.length, 1);
	assert.match(h.notices[0]!, /submission/);
	for (const event of ["agent_start", "agent_end"]) h.events.get(event)?.();
	h.shortcuts.get(PRESETS[0].shortcut)!(h.context());
	assert.equal(h.sent.length, 1, "intermediate lifecycle events must not re-arm");
	h.events.get("agent_settled")!();
	h.shortcuts.get(PRESETS[0].shortcut)!(h.context());
	assert.equal(h.sent.length, 2);
});

test("session start resets the latch but never sends anything automatically", () => {
	const h = harness();
	h.shortcuts.get(PRESETS[0].shortcut)!(h.context());
	h.start();
	h.events.get("agent_settled")!();
	assert.equal(h.sent.length, 1);
	h.shortcuts.get(PRESETS[0].shortcut)!(h.context());
	assert.equal(h.sent.length, 2);
});

test("synchronous send failure reports the error and stays latched until reset", () => {
	const h = harness();
	h.failSend();
	assert.doesNotThrow(() => h.shortcuts.get(PRESETS[0].shortcut)!(h.context()));
	h.shortcuts.get(PRESETS[0].shortcut)!(h.context());
	assert.deepEqual(h.sent, []);
	assert.match(h.notices[0]!, /failed/);
	assert.match(h.notices[1]!, /submission/);
});

test("key probe reports the first key sequence once, consumes it and sends nothing", async () => {
	const h = harness();
	await h.commands.get("quick-keyprobe")!("", h.context());
	assert.equal(h.listeners.size, 1);
	assert.match(h.notices[0]!, /armed/);
	assert.equal(h.input("\x1b[13;1:3u").consumed, false, "the Enter release that submitted the command passes through");
	assert.equal(h.listeners.size, 1);
	assert.equal(h.input("\x1b[119:87;4u").consumed, true);
	assert.match(h.notices[1]!, /1b 5b 31 31 39 3a 38 37 3b 34 75 \(ESC\[119:87;4u\)/);
	assert.equal(h.listeners.size, 0, "unsubscribes after one report");
	assert.equal(h.input("\x1b[119:87;4u").consumed, false);
	assert.deepEqual(h.sent, []);
	h.shortcuts.get(PRESETS[3].shortcut)!(h.context());
	assert.equal(h.sent.length, 1, "the probe never sets the submission latch");
});

test("key probe never echoes ordinary text and times out cleanly", async () => {
	assert.match(describeKeyProbeInput("W"), /^Key probe received 1 byte\(s\) of ordinary text, not shown\.$/);
	assert.match(describeKeyProbeInput("secret draft"), /12 byte\(s\) of ordinary text/);
	assert.doesNotMatch(describeKeyProbeInput("secret draft"), /secret/);
	assert.doesNotMatch(describeKeyProbeInput("\x1bsecret draft"), /secret/);
	assert.doesNotMatch(describeKeyProbeInput("\x1b[200~private\x1b[201~"), /private/);
	assert.match(describeKeyProbeInput("\x1bW"), /1b 57 \(ESCW\)/);
	assert.match(describeKeyProbeInput("\x01"), /01 \(\\x01\)/);
	assert.match(describeKeyProbeInput(`\x1b[${"9".repeat(40)}u`), /ordinary text, not shown/);

	const h = harness({ probeTimeoutMs: 5 });
	await h.commands.get("quick-keyprobe")!("", h.context());
	assert.equal(h.listeners.size, 1);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(h.listeners.size, 0, "timeout unsubscribes");
	assert.match(h.notices[1]!, /no key sequence reached Pi/);
	assert.deepEqual(h.sent, []);
	await h.commands.get("quick-keyprobe")!("", h.context());
	assert.equal(h.listeners.size, 1, "re-arms after a timeout");
	h.events.get("session_shutdown")!();
	assert.equal(h.listeners.size, 0, "shutdown releases an armed probe");
});

test("key probe refuses arguments, busy hosts, non-TUI modes and double arming", async () => {
	const h = harness();
	const run = (args = "", options = {}) => h.commands.get("quick-keyprobe")!(args, h.context(options));
	await run("now");
	assert.match(h.notices[0]!, /arguments/);
	for (const options of [{ idle: false }, { pending: true }, { mode: "rpc" }, { mode: "print" }]) await run("", options);
	assert.equal(h.listeners.size, 0);
	await run();
	await run();
	assert.equal(h.listeners.size, 1);
	assert.match(h.notices.at(-1)!, /already waiting/);
	assert.deepEqual(h.sent, []);
	h.events.get("session_shutdown")!();
});

test("legacy Orca Alt+Shift chords are translated without bypassing normal focus routing", () => {
	const h = harness();
	h.start();
	for (const shortcut of h.shortcuts.keys()) {
		const letter = shortcut.at(-1)!;
		assert.deepEqual(h.input(`\x1b${letter.toUpperCase()}`), {
			data: `\x1b[${letter.charCodeAt(0)};4u`, consumed: false,
		});
	}
	assert.deepEqual(h.sent, [], "raw input translation never directly invokes a shortcut");
	for (const data of ["\x1bw", "\x1bB", "\x1bF", "\x1bX", "\x1bWx", "x\x1bW", "\x1b\x1bW", "\x1b[200~\x1bW\x1b[201~", "\x1b[120:67;4u", "\x1b[119:87;4:3u", "W"]) {
		assert.deepEqual(h.input(data), { data, consumed: false });
	}
	assert.equal(h.listeners.size, 1);
	h.start();
	assert.equal(h.listeners.size, 1, "repeated session_start replaces the listener");
	h.events.get("session_shutdown")!();
	assert.equal(h.listeners.size, 0);
});

test("the probe sees original legacy bytes; compatibility resumes after the capture", async () => {
	const h = harness();
	h.start();
	await h.commands.get("quick-keyprobe")!("", h.context());
	assert.deepEqual(h.input("\x1bW"), { data: "\x1bW", consumed: true });
	assert.match(h.notices.at(-1)!, /1b 57 \(ESCW\)/);
	assert.deepEqual(h.input("\x1bW"), { data: "\x1b[119;4u", consumed: false });
	assert.deepEqual(h.sent, []);
	h.events.get("session_shutdown")!();
});

for (const [name, key] of [["yes", "y"], ["approved", "a"]]) {
	test(`${name}: inserts exact text without sending and preserves an existing draft`, async () => {
		const h = harness();
		const state = { draft: "" };
		const ctx = h.context(state);
		await h.shortcuts.get(`shift+alt+${key}`)!(ctx);
		assert.equal(state.draft, name);
		assert.deepEqual(h.sent, []);
		await h.shortcuts.get(`shift+alt+${key}`)!(ctx);
		assert.equal(state.draft, name, "duplicate press cannot append/replace the draft");
		assert.match(h.notices.at(-1)!, /draft/);
		state.draft = "";
		await h.commands.get(`quick-${name}`)!("", ctx);
		assert.equal(state.draft, name, "clearing allows a later deliberate insertion");
		assert.deepEqual(h.sent, []);
	});
}

for (const name of ["yes", "approved", "plan", "implement"]) {
	test(`${name}: refuses busy, queued, non-TUI, draft, unreadable editor and command arguments`, async () => {
		for (const state of [{ idle: false }, { pending: true }, { mode: "rpc" }, { mode: "print" }, { draft: "half typed" }, { draft: " " }, { draft: new Error("unavailable") }]) {
			const h = harness();
			const ctx = h.context(state);
			await h.commands.get(`quick-${name}`)!("", ctx);
			assert.deepEqual(h.sent, []);
			if (state.draft instanceof Error) assert.throws(() => ctx.ui.getEditorText());
			else assert.equal(ctx.ui.getEditorText(), state.draft ?? "");
		}
		const h = harness();
		await h.commands.get(`quick-${name}`)!("but only this one", h.context());
		assert.match(h.notices.at(-1)!, /arguments/);
		assert.deepEqual(h.sent, []);
	});
}

test("Plan dispatches the exact registered command without a model-turn latch", async () => {
	const h = harness();
	await h.shortcuts.get("shift+alt+p")!(h.context());
	assert.deepEqual(h.sent, ["/plan"]);
	assert.deepEqual(h.sendOptions, [{ expandPromptTemplates: true }]);
	await h.commands.get("quick-plan")!("", h.context());
	assert.deepEqual(h.sent, ["/plan", "/plan"], "normal repeated Plan dispatch is explicitly allowed");
	h.shortcuts.get(PRESETS[0].shortcut)!(h.context());
	assert.equal(h.sent.length, 3, "a finished mode command does not wait for agent_settled");
	await h.commands.get("quick-plan")!("", h.context());
	assert.equal(h.sent.length, 3, "pending model submission still blocks mode shortcuts");
});

for (const name of ["plan", "implement"]) {
	test(`${name}: absent, ambiguous and non-extension commands never fall through to a model`, async () => {
		for (const commands of [[], [{ name: `${name}:1`, source: "extension" }, { name: `${name}:2`, source: "extension" }], [{ name, source: "prompt" }], [{ name, source: "extension" }, { name, source: "extension" }]]) {
			const h = harness();
			h.setCommands(commands);
			h.setScopeInput(async () => "/tmp/worktree");
			await h.commands.get(`quick-${name}`)!("", h.context());
			assert.deepEqual(h.sent, []);
			assert.match(h.notices.at(-1)!, /registered extension command/);
		}
	});
}

test("mode dispatch refuses older or unknown Pi APIs instead of sending slash-command prose", async () => {
	for (const version of ["0.80.6", "1.3.0", "unknown"]) {
		const h = harness({ runtimeVersion: async () => version });
		await h.commands.get("quick-plan")!("", h.context());
		assert.deepEqual(h.sent, []);
		assert.match(h.notices.at(-1)!, /require Pi 1.4.0/);
	}
});

test("Implement requires an explicit literal absolute worktree path and does not latch later commands", async () => {
	const h = harness();
	const root = '/tmp/worktree with spaces/quote"and\\slash';
	h.setScopeInput(async () => root);
	await h.shortcuts.get("shift+alt+i")!(h.context());
	assert.deepEqual(h.sent, [`/implement ${JSON.stringify(root)}`]);
	assert.deepEqual(h.sendOptions, [{ expandPromptTemplates: true }]);
	await h.commands.get("quick-plan")!("", h.context());
	assert.equal(h.sent.at(-1), "/plan");
	for (const answer of [undefined, "", "  ", "relative/path", '""', "/tmp/a\n/tmp/b", "/tmp/a\t", "/tmp/a\x00", `/${"a".repeat(4096)}`]) {
		const refused = harness();
		refused.setScopeInput(async () => answer);
		await refused.commands.get("quick-implement")!("", refused.context());
		assert.deepEqual(refused.sent, [], JSON.stringify(answer));
	}
});

test("Implement protects the scope dialog and rechecks state after the user answers", async () => {
	for (const change of ["busy", "queue", "draft", "provider", "session", "shutdown"] as const) {
		const h = harness();
		const state = { idle: true, pending: false, draft: "" };
		const ctx = h.context(state);
		let answer!: (value: string) => void;
		h.setScopeInput(() => new Promise((resolve) => { answer = resolve; }));
		const running = h.commands.get("quick-implement")!("", ctx);
		await h.commands.get("quick-implement")!("", ctx);
		await h.commands.get("quick-plan")!("", ctx);
		assert.deepEqual(h.sent, [], "no shortcut dispatch while scope selection is open");
		if (change === "busy") state.idle = false;
		if (change === "queue") state.pending = true;
		if (change === "draft") state.draft = "new draft";
		if (change === "provider") h.setCommands([]);
		if (change === "session") h.start();
		if (change === "shutdown") h.events.get("session_shutdown")!();
		answer("/tmp/worktree");
		await running;
		assert.deepEqual(h.sent, [], change);
	}
});

test("Implement dialog errors release our guard without dispatching or swallowing later actions", async () => {
	const h = harness();
	h.setScopeInput(async () => { throw new Error("dialog failed"); });
	await h.commands.get("quick-implement")!("", h.context());
	assert.deepEqual(h.sent, []);
	assert.match(h.notices.at(-1)!, /failed/);
	await h.commands.get("quick-plan")!("", h.context());
	assert.deepEqual(h.sent, ["/plan"]);
});

test("stale host-version lookup cannot dispatch after session replacement", async () => {
	let resolveVersion!: (value: string) => void;
	const h = harness({ runtimeVersion: () => new Promise((resolve) => { resolveVersion = resolve; }) });
	const pending = h.commands.get("quick-plan")!("", h.context());
	h.start();
	resolveVersion("1.4.0");
	await pending;
	assert.deepEqual(h.sent, []);
});

test("compatibility output matches the actual Pi host parser", { skip: !process.env.PI_TUI_KEYS_MODULE }, async () => {
	const { matchesKey } = await import(process.env.PI_TUI_KEYS_MODULE!);
	const h = harness();
	h.start();
	for (const key of h.shortcuts.keys()) {
		const raw = `\x1b${key.at(-1)!.toUpperCase()}`;
		assert.equal(matchesKey(raw, key), false, "regression fixture fails on the host without translation");
		assert.equal(matchesKey(h.input(raw).data, key), true, `translated ${key} matches the host parser`);
	}
	assert.equal(matchesKey(h.input("\x1bY").data, "y"), false, "translation cannot answer a modal as an unmodified y");
	assert.equal(matchesKey(h.input("\x1bY").data, "enter"), false);
	h.events.get("session_shutdown")!();
});

test("presets preserve authorization boundaries; affirmative actions never reuse these prompt sends", () => {
	for (const preset of PRESETS) {
		assert.match(preset.text, /not approval/);
		assert.match(preset.text, /billing/);
	}
	assert.match(PRESETS[0].text, /already.authorized/);
	assert.match(PRESETS[0].text, /restate it and stop/);
	for (const preset of PRESETS.slice(1)) assert.match(preset.text, /read-only/);
});
