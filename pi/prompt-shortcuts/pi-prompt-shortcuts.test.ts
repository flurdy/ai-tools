import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerPromptShortcuts, { PRESETS } from "./pi-prompt-shortcuts.ts";

function harness() {
	const shortcuts = new Map<string, (ctx: ExtensionContext) => unknown>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => unknown>();
	const events = new Map<string, () => unknown>();
	const sent: string[] = [];
	const notices: string[] = [];
	let throwOnSend = false;
	registerPromptShortcuts({
		registerShortcut: (key: string, options: { handler: (ctx: ExtensionContext) => unknown }) => shortcuts.set(key, options.handler),
		registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionContext) => unknown }) => commands.set(name, options.handler),
		on: (name: string, handler: () => unknown) => events.set(name, handler),
		sendUserMessage: (text: string) => {
			if (throwOnSend) throw new Error("send failed");
			sent.push(text);
		},
	} as unknown as ExtensionAPI);
	function context({ idle = true, pending = false, mode = "tui", draft = "" }: {
		idle?: boolean; pending?: boolean; mode?: string; draft?: string | Error;
	} = {}): ExtensionContext {
		return {
			mode, isIdle: () => idle, hasPendingMessages: () => pending,
			ui: {
				notify: (message: string) => notices.push(message),
				getEditorText: () => { if (draft instanceof Error) throw draft; return draft; },
			},
		} as unknown as ExtensionContext;
	}
	return { shortcuts, commands, events, sent, notices, context, failSend: () => { throwOnSend = true; } };
}

test("registers only four namespaced commands and distinct non-Enter shortcuts", () => {
	const h = harness();
	assert.deepEqual([...h.commands.keys()], ["quick-continue", "quick-checkpoint", "quick-unblock", "quick-why"]);
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

test("presets preserve authorization boundaries without approval aliases", () => {
	for (const preset of PRESETS) {
		assert.match(preset.text, /not approval/);
		assert.match(preset.text, /billing/);
	}
	assert.match(PRESETS[0].text, /already.authorized/);
	assert.match(PRESETS[0].text, /restate it and stop/);
	for (const preset of PRESETS.slice(1)) assert.match(preset.text, /read-only/);
});
