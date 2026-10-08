import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import registerSpotlight, { chooseSkill, cleanDescription } from "./pi-skill-spotlight.ts";

const skill = (name = "review", description = "Review a change before shipping it.") => ({
	name: `skill:${name}`, source: "skill", description,
});

function harness(options: { enabled?: string; tty?: boolean; exists?: boolean; fail?: boolean } = {}) {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
	const widgets: { key: string; content: string[] | undefined; options: unknown }[] = [];
	let commands: unknown[] = [skill()];
	let queries = 0;
	const pi = {
		on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
		getCommands: () => { queries++; if (options.fail) throw new Error("unavailable"); return commands; },
	};
	registerSpotlight(pi as unknown as ExtensionAPI, {
		env: { PI_SKILL_SPOTLIGHT: Object.hasOwn(options, "enabled") ? options.enabled : "1" }, isTTY: options.tty ?? true,
		fileExists: () => options.exists ?? false, random: () => 0,
	});
	const context = {
		mode: "tui", hasUI: true,
		sessionManager: { getSessionFile: () => "/fresh.jsonl", getEntries: () => [], getHeader: () => ({}) },
		ui: { setWidget: (key: string, content: string[] | undefined, placement: unknown) => widgets.push({ key, content, options: placement }) },
	};
	return {
		widgets, context, queries: () => queries, commands: (value: unknown[]) => { commands = value; },
		emit: (name: string, reason = "startup") => handlers.get(name)?.({ type: name, reason }, context as unknown as ExtensionContext),
	};
}

test("picks only loaded valid skill commands without a second catalog", () => {
	const commands = [
		{ ...skill("prompt"), source: "prompt" }, { ...skill("extension"), source: "extension" },
		{ ...skill("wrong-prefix"), name: "review" }, skill("Bad-Name"), skill("a--b"),
		skill("-leading"), skill("trailing-"), skill("a".repeat(65)), skill("empty", " \n\t"),
		skill("controls", "\x1b[31m\x07\u202e"), null, {}, skill("review"), skill("review", "duplicate"), skill("test"),
	];
	assert.deepEqual(chooseSkill(commands, () => 0), { command: "/skill:review", description: "Review a change before shipping it." });
	assert.equal(chooseSkill(commands, () => 0.99)?.command, "/skill:test");
	assert.equal(chooseSkill([], () => 0), undefined);
	assert.equal(chooseSkill([skill()], () => Number.NaN), undefined);
});

test("descriptions are plain bounded terminal text with intact Unicode", () => {
	assert.equal(cleanDescription("\x1b]0;bad title\x07\x1b[31mRead\x1b[0m\n\t this\u202e safely\u2066.\u200b"), "Read this safely.");
	const text = cleanDescription("😀".repeat(150));
	assert.equal(Array.from(text).length, 140);
	assert.ok(text.endsWith("…"));
	assert.ok(!text.includes("\ufffd"));
});

test("opt-in creates one small above-editor widget and never queries skills when disabled", () => {
	for (const enabled of [undefined, "", "0", "false", "yes", " 1", "invalid"]) {
		const h = harness({ enabled }); h.emit("session_start");
		assert.deepEqual(h.widgets, []); assert.equal(h.queries(), 0);
	}
	const h = harness(); h.emit("session_start"); h.emit("session_start");
	assert.equal(h.widgets.length, 1);
	assert.deepEqual(h.widgets[0], {
		key: "flurdy-skill-spotlight",
		content: ["Skill spotlight · /review", "Review a change before shipping it."],
		options: { placement: "aboveEditor" },
	});
	assert.equal(h.queries(), 1);
});

test("headless, redirected, old hosts and resumed sessions stay silent", () => {
	for (const mode of ["rpc", "json", "print", undefined]) {
		const h = harness(); h.context.mode = mode as string; h.emit("session_start");
		assert.deepEqual(h.widgets, []); assert.equal(h.queries(), 0);
	}
	const redirected = harness({ tty: false }); redirected.emit("session_start");
	assert.deepEqual(redirected.widgets, []);
	for (const reason of ["reload", "resume", "fork", "unknown", ""]) {
		const h = harness(); h.emit("session_start", reason); assert.deepEqual(h.widgets, []);
	}
	const resumed = harness({ exists: true }); resumed.emit("session_start");
	assert.deepEqual(resumed.widgets, []);
	for (const entry of [
		{ type: "message", message: { role: "user" } },
		{ type: "message", message: { role: "assistant" } }, { type: "compaction" },
	]) {
		const h = harness(); h.context.sessionManager.getEntries = () => [entry] as never[];
		h.emit("session_start"); assert.deepEqual(h.widgets, []);
	}
	const fork = harness(); fork.context.sessionManager.getHeader = () => ({ parentSession: "old.jsonl" });
	fork.emit("session_start"); assert.deepEqual(fork.widgets, []);
});

test("fresh startup metadata and a new session are eligible, without adding session entries", () => {
	const h = harness();
	h.context.sessionManager.getEntries = () => [{ type: "message", message: { role: "system" } }, { type: "model_change" }] as never[];
	h.emit("session_start", "new"); assert.equal(h.widgets.length, 1);
});

test("first run and shutdown remove only our widget without redisplaying it", () => {
	const h = harness(); h.emit("session_start"); h.emit("before_agent_start");
	assert.equal(h.widgets.length, 2); assert.equal(h.widgets[1].content, undefined);
	h.emit("session_start"); h.emit("before_agent_start"); h.emit("session_shutdown");
	assert.equal(h.widgets.length, 2);
	const leaving = harness(); leaving.emit("session_start"); leaving.emit("session_shutdown");
	assert.equal(leaving.widgets[1].content, undefined);
});

test("empty discovery and optional UI/discovery failure never break startup", () => {
	const empty = harness(); empty.commands([]); empty.emit("session_start"); assert.deepEqual(empty.widgets, []);
	const failed = harness({ fail: true }); assert.doesNotThrow(() => failed.emit("session_start"));
	const ui = harness(); ui.context.ui.setWidget = () => { throw new Error("UI unavailable"); };
	assert.doesNotThrow(() => ui.emit("session_start"));
});
