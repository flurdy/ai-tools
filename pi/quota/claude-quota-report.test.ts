import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	buildClaudeQuotaReport,
	CLAUDE_USAGE_ARGS,
	ClaudeQuotaLookupError,
	describeClaudeQuotaError,
	readUsageEnvelope,
	runClaudeQuota,
	SOURCE_CAVEATS,
} from "./claude-quota-report.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, "claude-quota.ts");
const CURRENT_FIXTURE = join(HERE, "fixtures/claude-usage-2.1.302.json");
const CHANGED_FIXTURE = join(HERE, "fixtures/claude-usage-changed.json");
const NOW = Date.UTC(2026, 9, 18, 21, 0, 0);
const HOME = "/home/tester";
const YEAR_CAVEAT = /without a year.*first matching time after retrieval/i;

async function panel(path: string): Promise<string> {
	return JSON.parse(await readFile(path, "utf8")).result;
}

function report(text: string, nowMs = NOW, timeZone = "Europe/London") {
	return buildClaudeQuotaReport({ panel: text, fetchedAtMs: nowMs }, { nowMs, timeZone });
}

test("reports every current-format window verbatim with resolved reset times", async () => {
	const result = report(await panel(CURRENT_FIXTURE));
	assert.equal(result.schemaVersion, 1);
	assert.equal(result.status, "ok");
	assert.equal(result.source, "claude-code-usage");
	assert.equal(result.fetchedAt, "2026-10-18T21:00:00.000Z");
	assert.equal(result.fetchedAtLocal, "2026-10-18 22:00 BST (Europe/London)");
	const week = {
		resetsAtText: "Oct 23, 7:59am",
		resetsTimeZone: "Europe/London",
		resetsAt: "2026-10-23T06:59:00.000Z",
		resetsAtLocal: "2026-10-23 07:59 BST (Europe/London)",
		untilReset: { seconds: 381_540, text: "4d 9h 59m" },
		resetPassed: false,
	};
	assert.deepEqual(result.windows, [
		{
			label: "Current session",
			usedPercent: 12,
			resetsAtText: "Oct 19, 3:19am",
			resetsTimeZone: "Europe/London",
			resetsAt: "2026-10-19T02:19:00.000Z",
			resetsAtLocal: "2026-10-19 03:19 BST (Europe/London)",
			untilReset: { seconds: 19_140, text: "5h 19m" },
			resetPassed: false,
		},
		{ label: "Current week (all models)", usedPercent: 55, ...week },
		{ label: "Current week (Fable)", usedPercent: 0, ...week },
	]);
	assert.equal(result.caveats.length, SOURCE_CAVEATS.length + 1);
	assert.deepEqual(result.caveats.slice(0, SOURCE_CAVEATS.length), SOURCE_CAVEATS);
	assert.match(result.caveats.at(-1) ?? "", YEAR_CAVEAT);
});

test("a changed format yields nulls and caveats, never zero, and ignores the contributing section", async () => {
	const result = report(await panel(CHANGED_FIXTURE));
	assert.equal(result.status, "ok");
	assert.deepEqual(result.windows.map(({ label, usedPercent, resetsAtText, resetsTimeZone, resetsAt }) => ({
		label, usedPercent, resetsAtText, resetsTimeZone, resetsAt,
	})), [
		{ label: "Current week (all models)", usedPercent: null, resetsAtText: "next Thursday", resetsTimeZone: "Europe/London", resetsAt: null },
		{ label: "Current week (Fable)", usedPercent: 40, resetsAtText: null, resetsTimeZone: null, resetsAt: null },
		{ label: "Current week (Opus)", usedPercent: 50, resetsAtText: "Oct 23, 7:59am", resetsTimeZone: "Mars/Olympus", resetsAt: null },
	]);
	for (const window of result.windows) {
		assert.equal(window.untilReset, null);
		assert.equal(window.resetPassed, false);
	}
	const caveats = result.caveats.join("\n");
	assert.match(caveats, /usage for "Current week \(all models\)" was not recognised; treat it as unknown, not zero/);
	assert.match(caveats, /reset time for "Current week \(all models\)" was not recognised/);
	assert.match(caveats, /reset time for "Current week \(Fable\)" was not reported/);
	assert.match(caveats, /reset time zone for "Current week \(Opus\)" was not reported or not recognised/);
	assert.match(caveats, /1 limit-like line in the \/usage panel was not recognised/);
	assert.doesNotMatch(caveats, YEAR_CAVEAT);
	assert.doesNotMatch(JSON.stringify(result.windows), /should be ignored/);
});

test("a panel without limit lines reports no windows and says usage is unknown", () => {
	const result = report("Usage is not available for this account.");
	assert.deepEqual(result.windows, []);
	assert.match(result.caveats.join("\n"), /No limit windows were recognised.*unknown, not zero/);
});

test("resolves time-only, year-rollover and winter-time resets in the reported zone", () => {
	const timeOnly = report("Current session: 5% used · resets 3am (Europe/London)");
	assert.equal(timeOnly.windows[0].resetsAt, "2026-10-19T02:00:00.000Z");
	const sameDay = report("Current session: 5% used · resets 11:30pm (Europe/London)");
	assert.equal(sameDay.windows[0].resetsAt, "2026-10-18T22:30:00.000Z");
	const noon = report("Current session: 5% used · resets Oct 19, 12pm (UTC)");
	assert.equal(noon.windows[0].resetsAt, "2026-10-19T12:00:00.000Z");
	const winter = report("Current week (all models): 7.5% used · resets Nov 2, 8am (Europe/London)");
	assert.equal(winter.windows[0].usedPercent, 7.5);
	assert.equal(winter.windows[0].resetsAt, "2026-11-02T08:00:00.000Z");
	const rollover = report("Current week (all models): 9% used · resets Jan 2, 8:05am (America/New_York)", Date.UTC(2026, 11, 30, 12), "UTC");
	assert.equal(rollover.windows[0].resetsAt, "2027-01-02T13:05:00.000Z");
	assert.equal(rollover.windows[0].resetsAtLocal, "2027-01-02 13:05 UTC (UTC)");
	for (const invalid of ["Feb 30, 8am", "Oct 19, 13pm", "Oct 19, 3:75am", "Foo 19, 3am", "in 2 hours"]) {
		const result = report(`Current session: 5% used · resets ${invalid} (Europe/London)`);
		assert.equal(result.windows[0].resetsAt, null, invalid);
		assert.equal(result.windows[0].resetsAtText, invalid);
		assert.match(result.caveats.join("\n"), /reset time for "Current session" was not recognised/, invalid);
	}
});

test("flags a reset already passed at a later report time as stale", () => {
	const fetchedAtMs = NOW;
	const later = Date.UTC(2026, 9, 19, 4, 0, 0);
	const result = buildClaudeQuotaReport(
		{ panel: "Current session: 99% used · resets Oct 19, 3:19am (Europe/London)", fetchedAtMs },
		{ nowMs: later, timeZone: "UTC" },
	);
	assert.equal(result.windows[0].resetsAt, "2026-10-19T02:19:00.000Z");
	assert.equal(result.windows[0].resetPassed, true);
	assert.equal(result.windows[0].untilReset, null);
	assert.match(result.caveats.join("\n"), /"Current session" has already passed.*stale/);
});

const usageEnvelope = { type: "result", subtype: "success", is_error: false, num_turns: 0, total_cost_usd: 0, local_command: "usage", result: "panel" };

function envelope(fields: Record<string, unknown>, code: number | null = 0, stderr = ""): string {
	return readUsageEnvelope({ code, stdout: JSON.stringify({ ...usageEnvelope, ...fields }), stderr });
}

function rejects(run: () => unknown, kind: string, message: RegExp): void {
	assert.throws(run, (error: unknown) => {
		assert.ok(error instanceof ClaudeQuotaLookupError);
		assert.equal(error.kind, kind);
		assert.match(error.message, message);
		return true;
	});
}

test("accepts only a successful local /usage envelope with no model turn or cost", () => {
	assert.equal(envelope({}), "panel");
	rejects(() => envelope({ num_turns: 1 }), "unexpected-response", /model turn or cost.*num_turns=1/);
	rejects(() => envelope({ total_cost_usd: 0.01 }), "unexpected-response", /total_cost_usd=0.01/);
	rejects(() => envelope({ num_turns: undefined }), "unexpected-response", /num_turns=undefined/);
	rejects(() => envelope({ local_command: "compact" }), "unexpected-response", /local_command="compact"/);
	rejects(() => envelope({ local_command: undefined }), "unexpected-response", /local_command=undefined/);
	rejects(() => envelope({ result: 42 }), "unexpected-response", /not text/);
	rejects(() => envelope({ is_error: true, subtype: "error", result: "Not logged in · Please run /login" }, 1), "lookup-failed", /Not logged in/);
	rejects(() => envelope({}, 1), "lookup-failed", /exited with code 1/);
	rejects(() => readUsageEnvelope({ code: 1, stdout: "", stderr: "fatal: broken" }), "lookup-failed", /exited with code 1: fatal: broken/);
	rejects(() => readUsageEnvelope({ code: 0, stdout: "not json", stderr: "" }), "unexpected-response", /did not print a JSON result/);
	rejects(() => readUsageEnvelope({ code: 0, stdout: "[]", stderr: "" }), "unexpected-response", /did not print a JSON result/);
});

test("classifies failures with a sign-in hint and sanitized messages", () => {
	const login = describeClaudeQuotaError(new ClaudeQuotaLookupError("lookup-failed", "Claude Code reported an error: Not logged in · Please run /login"), HOME);
	assert.equal(login.kind, "lookup-failed");
	assert.match(login.hint ?? "", /claude auth status/);

	const leaky = describeClaudeQuotaError(new ClaudeQuotaLookupError(
		"lookup-failed",
		"Claude Code exited with code 1: \u001b[31mfatal\u001b[0m /home/tester/.claude/x token sk-ant-abcdef123456\nmore",
	), HOME);
	for (const secret of ["\u001b", "/home/tester", "sk-ant-abcdef123456", "\n"]) {
		assert.ok(!leaky.message.includes(secret), `leaked ${JSON.stringify(secret)}: ${leaky.message}`);
	}
	assert.equal(leaky.hint, undefined);

	const unknown = describeClaudeQuotaError(new Error("surprise"), HOME);
	assert.deepEqual(unknown, { kind: "lookup-failed", message: "surprise" });
});

function collect() {
	const out: string[] = [];
	const err: string[] = [];
	return { out, err, io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) } };
}

test("runClaudeQuota prints a JSON report from an injected fetch and forwards the timeout", async () => {
	const { out, err, io } = collect();
	const received: unknown[] = [];
	const code = await runClaudeQuota(["--timeout-ms", "2500"], {
		...io,
		fetch: async (options) => {
			received.push(options);
			return { panel: await panel(CURRENT_FIXTURE), fetchedAtMs: NOW };
		},
		nowMs: () => NOW,
		timeZone: "UTC",
		home: HOME,
	});
	assert.equal(code, 0);
	assert.deepEqual(received, [{ timeoutMs: 2500 }]);
	assert.deepEqual(err, []);
	const parsed = JSON.parse(out.join(""));
	assert.equal(parsed.timeZone, "UTC");
	assert.deepEqual(parsed.windows.map((window: { usedPercent: number }) => window.usedPercent), [12, 55, 0]);
});

test("runClaudeQuota reports failures as a JSON envelope with exit 1 and usage errors with exit 2", async () => {
	const failed = collect();
	const code = await runClaudeQuota([], {
		...failed.io,
		fetch: async () => { throw new ClaudeQuotaLookupError("unexpected-response", "Claude Code reported a model turn or cost"); },
		home: HOME,
	});
	assert.equal(code, 1);
	const failure = JSON.parse(failed.out.join(""));
	assert.equal(failure.status, "error");
	assert.equal(failure.source, "claude-code-usage");
	assert.equal(failure.error.kind, "unexpected-response");
	assert.deepEqual(failure.caveats, SOURCE_CAVEATS);
	assert.deepEqual(failed.err, []);

	const usage = collect();
	assert.equal(await runClaudeQuota(["--bogus"], { ...usage.io, fetch: async () => { throw new Error("must not fetch"); } }), 2);
	assert.deepEqual(usage.out, []);
	assert.match(usage.err.join(""), /claude-quota: unexpected argument.*usage: claude-quota/s);

	const help = collect();
	assert.equal(await runClaudeQuota(["--help"], { ...help.io, fetch: async () => { throw new Error("must not fetch"); } }), 0);
	assert.match(help.out.join(""), /usage: claude-quota.*--timeout-ms/s);
});

const FAKE_CLAUDE = String.raw`
import { readFileSync, writeFileSync } from "node:fs";
const { record, mode, fixture } = globalThis.fakeClaude;
writeFileSync(record, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }));
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "fail") { process.stderr.write("fatal: token sk-ant-abcdef123456"); process.exit(1); }
else process.stdout.write(readFileSync(fixture, "utf8"));
`;

interface Run { code: number | null; stdout: string; stderr: string; elapsedMs: number }

function runCli(command: string, args: string[], env: Record<string, string>): Promise<Run> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
		child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr, elapsedMs: Date.now() - started }));
		setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
	});
}

type FakeMode = "reply" | "hang" | "fail";

async function withFakeClaude(mode: FakeMode, run: (bin: string, directory: string, record: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "claude-quota-cli-"));
	const bin = join(directory, "bin");
	const record = join(directory, "record.json");
	await mkdir(bin);
	const script = join(directory, "fake-claude.mjs");
	await writeFile(script, FAKE_CLAUDE);
	const config = JSON.stringify({ record, mode, fixture: CURRENT_FIXTURE });
	await writeFile(join(bin, "claude"), `#!${process.execPath}\nglobalThis.fakeClaude = ${config};\nawait import(${JSON.stringify(script)});\n`, { mode: 0o700 });
	try {
		await run(bin, directory, record);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		try {
			await access(path);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw new Error(`Timed out waiting for ${path}`);
}

test("the executable runs exactly the local /usage command outside the caller's directory", async () => {
	await withFakeClaude("reply", async (bin, directory, record) => {
		const result = await runCli(process.execPath, [ENTRY], { PATH: bin, HOME: directory, TZ: "UTC", TMPDIR: directory });
		assert.equal(result.code, 0, result.stderr);
		const parsed = JSON.parse(result.stdout);
		assert.equal(parsed.status, "ok");
		assert.deepEqual(parsed.windows.map((window: { label: string }) => window.label), ["Current session", "Current week (all models)", "Current week (Fable)"]);
		assert.equal(parsed.windows[0].resetsAtText, "Oct 19, 3:19am");
		const invocation = JSON.parse(await readFile(record, "utf8"));
		assert.deepEqual(invocation.args, [...CLAUDE_USAGE_ARGS]);
		assert.deepEqual(CLAUDE_USAGE_ARGS, ["-p", "/usage", "--no-session-persistence", "--output-format", "json"]);
		assert.equal(await realpath(invocation.cwd), await realpath(directory));
	});
});

test("the executable works through an extensionless PATH symlink", async () => {
	await withFakeClaude("reply", async (bin, directory) => {
		const link = join(bin, "claude-quota");
		await symlink(ENTRY, link);
		const result = await runCli(link, [], { PATH: `${bin}:${dirname(process.execPath)}`, HOME: directory, TZ: "UTC" });
		assert.equal(result.code, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout).windows[0].usedPercent, 12);
	});
});

test("a missing Claude Code CLI is reported as a JSON error envelope", async () => {
	const directory = await mkdtemp(join(tmpdir(), "claude-quota-missing-"));
	try {
		const result = await runCli(process.execPath, [ENTRY], { PATH: directory, HOME: directory, TZ: "UTC" });
		assert.equal(result.code, 1);
		const failure = JSON.parse(result.stdout);
		assert.equal(failure.error.kind, "claude-cli-missing");
		assert.match(failure.error.message, /not found on PATH/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a failing Claude Code CLI is reported with sanitized stderr", async () => {
	await withFakeClaude("fail", async (bin, directory) => {
		const result = await runCli(process.execPath, [ENTRY], { PATH: bin, HOME: directory, TZ: "UTC" });
		assert.equal(result.code, 1);
		const failure = JSON.parse(result.stdout);
		assert.equal(failure.error.kind, "lookup-failed");
		assert.match(failure.error.message, /exited with code 1: fatal: token \[redacted\]/);
	});
});

test("a timeout terminates the Claude child and reports a timeout envelope", async () => {
	await withFakeClaude("hang", async (bin, directory, record) => {
		const result = await runCli(process.execPath, [ENTRY, "--timeout-ms", "500"], { PATH: bin, HOME: directory, TZ: "UTC" });
		await waitForFile(record);
		assert.equal(result.code, 1);
		assert.equal(JSON.parse(result.stdout).error.kind, "timeout");
		assert.ok(result.elapsedMs < 5000, String(result.elapsedMs));
		const { pid } = JSON.parse(await readFile(record, "utf8"));
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	});
});
