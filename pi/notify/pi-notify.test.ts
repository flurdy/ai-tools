import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerPiNotify, { resolveProtocol } from "./pi-notify.ts";

test("detects supported terminals without guessing from generic xterm", () => {
	for (const env of [{ KITTY_WINDOW_ID: "1" }, { TERM: "xterm-kitty" }]) {
		assert.equal(resolveProtocol(env), "osc99");
	}
	for (const env of [{ TERM_PROGRAM: "ghostty" }, { TERM: "xterm-ghostty" }, { TERM_PROGRAM: "WezTerm" }]) {
		assert.equal(resolveProtocol(env), "osc777");
	}
	for (const env of [{}, { TERM: "xterm-256color" }, { TERM_PROGRAM: "unknown" }, { WT_SESSION: "windows" }]) {
		assert.equal(resolveProtocol(env), undefined);
	}
});

test("explicit protocols and off mode are bounded and fail closed", () => {
	assert.equal(resolveProtocol({ PI_NOTIFY_PROTOCOL: "osc99" }), "osc99");
	assert.equal(resolveProtocol({ PI_NOTIFY_PROTOCOL: "osc777" }), "osc777");
	assert.equal(resolveProtocol({ PI_NOTIFY_PROTOCOL: "auto", TERM: "xterm-kitty" }), "osc99");
	for (const value of ["off", "invalid", "OSC99"]) {
		assert.equal(resolveProtocol({ PI_NOTIFY_PROTOCOL: value, KITTY_WINDOW_ID: "1" }), undefined);
	}
});

test("host ownership and unsupported transports override terminal hints and forced protocols", () => {
	for (const env of [
		{ ORCA_PANE_KEY: "pane" }, { TERM_PROGRAM: "Orca" },
		{ TMUX: "socket" }, { STY: "screen" }, { TERM: "screen-256color" },
		{ TERM: "tmux-256color" }, { TERM: "dumb" },
	]) {
		assert.equal(resolveProtocol({ KITTY_WINDOW_ID: "1", PI_NOTIFY_PROTOCOL: "osc99", ...env }), undefined);
	}
});

function harness(env: NodeJS.ProcessEnv = { TERM: "xterm-kitty" }, isTTY = true, fail = false) {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const output: string[] = [];
	const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler) };
	registerPiNotify(pi as unknown as ExtensionAPI, {
		env,
		isTTY,
		write: (sequence) => {
			if (fail) throw new Error("terminal unavailable");
			output.push(sequence);
		},
	});
	return {
		output,
		emit: (event: string, mode = "tui", idle = true) => handlers.get(event)?.({}, { mode, isIdle: () => idle } as ExtensionContext),
	};
}

test("notifies only on final settlement, not intermediate ends, tools, compaction, or shutdown", () => {
	const h = harness();
	for (const event of ["session_start", "agent_start", "tool_execution_end", "agent_end", "session_compact", "agent_start", "agent_end"]) {
		h.emit(event);
		assert.deepEqual(h.output, []);
	}
	h.emit("agent_settled");
	assert.deepEqual(h.output, ["\x1b]99;;Pi: Ready for input\x1b\\"]);
	h.emit("agent_start");
	h.emit("agent_end");
	h.emit("agent_settled");
	assert.equal(h.output.length, 2);
	h.emit("session_shutdown");
	assert.equal(h.output.length, 2);
});

test("OSC 777 sends one fixed title/body sequence", () => {
	const h = harness({ TERM_PROGRAM: "WezTerm" });
	h.emit("agent_settled");
	assert.deepEqual(h.output, ["\x1b]777;notify;Pi;Ready for input\x07"]);
});

test("RPC, JSON, print, non-TTY and newly busy contexts produce no output", () => {
	const h = harness();
	for (const mode of ["rpc", "json", "print"]) h.emit("agent_settled", mode);
	h.emit("agent_settled", "tui", false);
	assert.deepEqual(h.output, []);
	const redirected = harness({ TERM: "xterm-kitty" }, false);
	redirected.emit("agent_settled");
	assert.deepEqual(redirected.output, []);
});

test("unsupported and host-managed sessions stay silent at settlement", () => {
	for (const env of [{}, { ORCA_PANE_KEY: "pane", TERM: "xterm-kitty" }, { PI_NOTIFY_PROTOCOL: "off" }]) {
		const h = harness(env);
		h.emit("agent_settled");
		assert.deepEqual(h.output, []);
	}
});

test("failed terminal writes never break the settled handler", () => {
	const h = harness({ TERM: "xterm-kitty" }, true, true);
	assert.doesNotThrow(() => h.emit("agent_settled"));
});
