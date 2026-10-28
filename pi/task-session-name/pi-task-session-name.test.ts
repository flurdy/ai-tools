import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerTaskSessionName, { claimedTask } from "./pi-task-session-name.ts";

type Entry = { type: string; name?: string; customType?: string; data?: unknown };

function harness(options: { env?: NodeJS.ProcessEnv; entries?: Entry[]; hasUI?: boolean } = {}) {
	let entries: Entry[] = options.entries ?? [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const name = (): string | undefined => {
		for (let index = entries.length - 1; index >= 0; index--) {
			if (entries[index]?.type === "session_info") return entries[index]?.name?.trim() || undefined;
		}
	};
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
		getSessionName: name,
		setSessionName: (value: string) => entries.push({ type: "session_info", name: value }),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
	};
	registerTaskSessionName(pi as unknown as ExtensionAPI, options.env ?? { ORCA_PANE_KEY: "tab:leaf" });
	const ctx = { hasUI: options.hasUI ?? true, sessionManager: { getEntries: () => [...entries] } };
	const emit = (event: string, payload: object) => handlers.get(event)?.({ type: event, ...payload }, ctx);
	emit("session_start", { reason: "startup" });
	return {
		get entries() { return entries; },
		switchEntries: (next: Entry[]) => { entries = next; emit("session_start", { reason: "resume" }); },
		handlers,
		name,
		bash: (command: string, isError = false) => emit("tool_result", { toolName: "bash", input: { command }, isError, content: [] }),
		input: (text: string) => emit("input", { text, source: "interactive" }),
		userName: (value: string) => entries.push({ type: "session_info", name: value }),
	};
}

const SELECT = "~/.agents/skills/next/scripts/next-select";

test("extracts the claimed task from successful claim commands only", () => {
	const claims: Array<[string, string | undefined]> = [
		[`${SELECT} start ai-tools:ai-tools-8hy --expect-id ai-tools-8hy`, "ai-tools-8hy"],
		[`${SELECT} start workspace:agents-u6d.2`, "agents-u6d.2"],
		[`${SELECT} start agents-go1`, "agents-go1"],
		[`${SELECT} start 3 --expect-id pi-claude-cli-chq`, "pi-claude-cli-chq"],
		[`${SELECT} start --expect-id=router-oqv 9`, "router-oqv"],
		[`NEXT_BEADS_READ_TIMEOUT_SECONDS=90 ${SELECT} start bad_usernames_api:bad_usernames_api-7he`, "bad_usernames_api-7he"],
		["bd -C /home/me/repo --sandbox update agents-go1 --claim", "agents-go1"],
		["bd update skills-44dg --status=in_progress", "skills-44dg"],
		["bd update skills-44dg --status in_progress --notes 'started; see next | log'", "skills-44dg"],
		["bd update skills-44dg -s in_progress", "skills-44dg"],
		["bd -C '/path with spaces' update agents-dmm \\\n  --claim", "agents-dmm"],
		[`${SELECT} start 3`, undefined],
		[`${SELECT} resolve ai-tools:ai-tools-8hy`, undefined],
		[`${SELECT} handoff ai-tools:ai-tools-8hy`, undefined],
		["bd update agents-go1 --status open --remove-label run-on:leonidas", undefined],
		["bd update agents-go1 agents-dmm --claim", undefined],
		["bd update --claim agents-go1", undefined],
		["bd show agents-go1 --json", undefined],
		["bd comments add agents-go1 update --claim", undefined],
		[`echo "${SELECT} start ai-tools:ai-tools-8hy"`, undefined],
		[`echo ${SELECT} start ai-tools:ai-tools-8hy`, undefined],
		["echo bd update agents-go1 --claim", undefined],
		["git commit -m bd update agents-go1 --claim", undefined],
		["bd update 'x$(touch pwned)' --claim", undefined],
		[`bd update ${"a".repeat(70)}-1 --claim`, undefined],
		["bd update agents-go1;rm --claim", undefined],
	];
	for (const [command, expected] of claims) assert.equal(claimedTask(command), expected, command);
});

test("ignores compound shell syntax whose final exit status cannot prove a claim succeeded", () => {
	for (const command of [
		`${SELECT} start agents-go1; echo done`,
		`false && ${SELECT} start agents-go1; true`,
		`bd update agents-go1 --claim | tee log`,
		`# ignored; bd update agents-go1 --claim`,
		`cat <<EOF\nbd update agents-go1 --claim\nEOF`,
		`${SELECT} start agents-go1 &`,
		`bd update agents-go1 --claim > log`,
		`bd update agents-go1 --claim\necho done`,
		`bd update agents-go1 --claim$(false)`,
		`bd update agents-go1 --claim \`false\``,
		`${SELECT} start agents-go1 && ${SELECT} start agents-dmm`,
		`${SELECT} start 'agents-go1`,
		`${SELECT} start agents-go1 --unknown`,
		`bd update agents-go1 --notes '--claim' --status open`,
	]) assert.equal(claimedTask(command), undefined, command);
});

test("names an unnamed Orca session after a successful claim and records ownership", () => {
	const h = harness();
	h.bash(`${SELECT} start ai-tools:ai-tools-8hy --expect-id ai-tools-8hy`);
	assert.equal(h.name(), "ai-tools-8hy");
	assert.deepEqual(h.entries.at(-1), {
		type: "custom",
		customType: "flurdy-task-session-name",
		data: { name: "ai-tools-8hy", task: "ai-tools-8hy", role: undefined },
	});
	h.bash("bd update agents-go1 --claim");
	assert.equal(h.name(), "agents-go1");
});

test("failed commands, other tools and unchanged names write nothing", () => {
	const h = harness();
	h.bash(`${SELECT} start workspace:agents-48m --expect-id agents-48m`, true);
	h.handlers.get("tool_result")?.(
		{ type: "tool_result", toolName: "read", input: { command: "bd update agents-go1 --claim" }, isError: false, content: [] },
		{ hasUI: true },
	);
	h.handlers.get("tool_result")?.(
		{ type: "tool_result", toolName: "bash", input: { command: 42 }, isError: false, content: [] },
		{ hasUI: true },
	);
	assert.deepEqual(h.entries, []);
	h.bash("bd update agents-go1 --claim");
	h.bash("bd update agents-go1 --claim");
	assert.equal(h.entries.length, 2);
});

test("never replaces a name the user set, before or after automatic naming", () => {
	const named = harness({ entries: [{ type: "session_info", name: "my review" }] });
	named.bash("bd update agents-go1 --claim");
	assert.equal(named.name(), "my review");
	assert.equal(named.entries.length, 1);

	const h = harness();
	h.bash("bd update agents-go1 --claim");
	h.userName("orca-dynamic-titles");
	h.bash("bd update agents-dmm --claim");
	h.input("/watch-prs");
	assert.equal(h.name(), "orca-dynamic-titles");
});

test("re-entering the automatic name manually takes ownership immediately, without reload", () => {
	const h = harness();
	h.bash("bd update agents-go1 --claim");
	h.userName("agents-go1");
	h.bash("bd update agents-dmm --claim");
	assert.equal(h.name(), "agents-go1");
	assert.equal(h.entries.length, 3);
});

test("a cleared name returns control to automatic naming on the next signal", () => {
	const h = harness({ entries: [{ type: "session_info", name: "manual" }] });
	h.userName("");
	assert.equal(h.name(), undefined);
	h.bash("bd update agents-go1 --claim");
	assert.equal(h.name(), "agents-go1");
});

test("ownership and context survive reload and resume", () => {
	const first = harness();
	first.input("/watch-release");
	first.bash("bd update agents-go1 --claim");
	assert.equal(first.name(), "agents-go1 · watch-release");

	const reloaded = harness({ entries: first.entries });
	reloaded.bash("bd update agents-dmm --claim");
	assert.equal(reloaded.name(), "agents-dmm · watch-release");

	reloaded.userName("renamed by me");
	const resumed = harness({ entries: reloaded.entries });
	resumed.bash("bd update agents-fu4 --claim");
	assert.equal(resumed.name(), "renamed by me");
});

test("switching sessions cannot carry a prior task or watcher role into another session", () => {
	const h = harness();
	h.input("/watch-release");
	h.bash("bd update agents-go1 --claim");
	h.switchEntries([]);
	h.bash("bd update agents-dmm --claim");
	assert.equal(h.name(), "agents-dmm");
	h.switchEntries([{ type: "session_info", name: "user session" }]);
	h.input("/watch-prs");
	assert.equal(h.name(), "user session");
});

test("restored entries are validated rather than trusted", () => {
	const valid = harness({
		entries: [
			{ type: "session_info", name: "agents-go1" },
			{ type: "custom", customType: "flurdy-task-session-name", data: { name: "agents-go1", task: "agents-go1", role: "rm -rf" } },
		],
	});
	valid.input("/watch-prs");
	assert.equal(valid.name(), "agents-go1 · watch-prs");

	const forged = harness({
		entries: [
			{ type: "session_info", name: "\u001b]2;evil" },
			{ type: "custom", customType: "flurdy-task-session-name", data: { name: "\u001b]2;evil", task: "\u001b]2;evil" } },
		],
	});
	forged.bash("bd update agents-go1 --claim");
	assert.equal(forged.name(), "\u001b]2;evil", "unproven ownership is treated as a user name");
	assert.equal(forged.entries.length, 2);
});

test("watcher roles use a fixed vocabulary from the invoking command", () => {
	const h = harness();
	for (const text of ["please /watch-prs", "/watch-prsx", "/watch-everything", "watch-release"]) h.input(text);
	assert.deepEqual(h.entries, []);
	h.input("/skill:watch-release until 18:00");
	assert.equal(h.name(), "watch-release");
	h.input("$watch-prs");
	assert.equal(h.name(), "watch-prs");
});

test("stays inactive outside Orca panes and in sessions without a UI", () => {
	const outside = harness({ env: {} });
	assert.equal(outside.handlers.size, 0);
	const headless = harness({ hasUI: false });
	headless.bash("bd update agents-go1 --claim");
	headless.input("/watch-prs");
	assert.deepEqual(headless.entries, []);
});
