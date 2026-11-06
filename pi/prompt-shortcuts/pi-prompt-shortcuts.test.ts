import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerPromptShortcuts, { PRESETS, describeKeyProbeInput } from "./pi-prompt-shortcuts.ts";

type InputListener = (data: string) => { consume?: boolean; data?: string } | undefined;

function harness(options: { probeTimeoutMs?: number } = {}) {
	const shortcuts = new Map<string, (ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => unknown>();
	const events = new Map<string, () => unknown>();
	const sent: string[] = [];
	const notices: string[] = [];
	const listeners = new Set<InputListener>();
	let throwOnSend = false;
	registerPromptShortcuts({
		registerShortcut: (key: string, options: { handler: (ctx: ExtensionContext) => unknown }) => shortcuts.set(key, options.handler),
		registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => unknown }) => commands.set(name, options.handler),
		on: (name: string, handler: () => unknown) => events.set(name, handler),
		sendUserMessage: (text: string) => {
			if (throwOnSend) throw new Error("send failed");
			sent.push(text);
		},
	} as unknown as ExtensionAPI, options);
	function context({ idle = true, pending = false, mode = "tui", draft = "" }: {
		idle?: boolean; pending?: boolean; mode?: string; draft?: string | Error;
	} = {}): ExtensionContext {
		return {
			mode, isIdle: () => idle, hasPendingMessages: () => pending,
			ui: {
				notify: (message: string) => notices.push(message),
				getEditorText: () => { if (draft instanceof Error) throw draft; return draft; },
				onTerminalInput: (listener: InputListener) => { listeners.add(listener); return () => listeners.delete(listener); },
			},
		} as unknown as ExtensionContext;
	}
	/** Feeds raw input to every listener the way pi-tui does: a consumed sequence stops propagation. */
	function input(data: string): boolean {
		for (const listener of listeners) if (listener(data)?.consume) return true;
		return false;
	}
	return { shortcuts, commands, events, sent, notices, listeners, context, input, failSend: () => { throwOnSend = true; } };
}

test("registers four quick prompts, the key probe and distinct non-Enter shortcuts", () => {
	const h = harness();
	assert.deepEqual([...h.commands.keys()], ["quick-continue", "quick-checkpoint", "quick-unblock", "quick-why", "quick-keyprobe"]);
	assert.deepEqual([...h.shortcuts.keys()], ["shift+alt+c", "shift+alt+s", "shift+alt+u", "shift+alt+w"]);
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
	h.events.get("session_start")!();
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
	assert.equal(h.input("\x1b[13;1:3u"), false, "the Enter release that submitted the command passes through");
	assert.equal(h.listeners.size, 1);
	assert.equal(h.input("\x1b[119:87;4u"), true);
	assert.match(h.notices[1]!, /1b 5b 31 31 39 3a 38 37 3b 34 75 \(ESC\[119:87;4u\)/);
	assert.equal(h.listeners.size, 0, "unsubscribes after one report");
	assert.equal(h.input("\x1b[119:87;4u"), false);
	assert.deepEqual(h.sent, []);
	h.shortcuts.get(PRESETS[3].shortcut)!(h.context());
	assert.equal(h.sent.length, 1, "the probe never sets the submission latch");
});

test("key probe never echoes ordinary text and times out cleanly", async () => {
	assert.match(describeKeyProbeInput("W"), /^Key probe received 1 byte\(s\) of ordinary text, not shown\.$/);
	assert.match(describeKeyProbeInput("secret draft"), /12 byte\(s\) of ordinary text/);
	assert.doesNotMatch(describeKeyProbeInput("secret draft"), /secret/);
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

test("presets preserve authorization boundaries without approval aliases", () => {
	for (const preset of PRESETS) {
		assert.match(preset.text, /not approval/);
		assert.match(preset.text, /billing/);
	}
	assert.match(PRESETS[0].text, /already.authorized/);
	assert.match(PRESETS[0].text, /restate it and stop/);
	for (const preset of PRESETS.slice(1)) assert.match(preset.text, /read-only/);
});
