import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	buildCodexQuotaReport,
	describeCodexQuotaError,
	formatDuration,
	formatLocal,
	parseCodexQuotaArgs,
	runCodexQuota,
	SOURCE_CAVEATS,
} from "./codex-quota-report.ts";

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const RESET = NOW + (3 * 86_400 + 17 * 3_600 + 5 * 60 + 30) * 1000;
const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "codex-quota.ts");
const HOME = "/home/tester";

const fullSnapshot = {
	weekly: { usedPercent: 73.4, remainingPercent: 26.6, resetsAtMs: RESET, fetchedAtMs: NOW },
	credits: { kind: "balance" as const, balance: "126.4375" },
	fetchedAtMs: NOW,
};

test("reports exact percentages, reset time with timezone, time until reset, and raw credits", () => {
	const report = buildCodexQuotaReport(fullSnapshot, { nowMs: NOW, timeZone: "Europe/London" });
	assert.equal(report.schemaVersion, 1);
	assert.equal(report.status, "ok");
	assert.equal(report.source, "codex-cli-account");
	assert.equal(report.timeZone, "Europe/London");
	assert.equal(report.fetchedAt, "2026-10-10T12:00:00.000Z");
	assert.equal(report.fetchedAtLocal, "2026-10-10 13:00 BST (Europe/London)");
	assert.deepEqual(report.weekly, {
		usedPercent: 73.4,
		remainingPercent: 26.6,
		resetsAt: "2026-10-14T05:05:30.000Z",
		resetsAtLocal: "2026-10-14 06:05 BST (Europe/London)",
		untilReset: { seconds: 320_730, text: "3d 17h 5m" },
		resetPassed: false,
	});
	assert.deepEqual(report.credits, { kind: "balance", balance: "126.4375" });
	assert.deepEqual(report.caveats, SOURCE_CAVEATS);
});

test("keeps missing weekly quota, reset time and credits unknown rather than zero", () => {
	const empty = buildCodexQuotaReport({ fetchedAtMs: NOW }, { nowMs: NOW, timeZone: "UTC" });
	assert.equal(empty.weekly, null);
	assert.equal(empty.credits, null);
	assert.match(empty.caveats.join("\n"), /weekly quota was not reported.*unknown, not zero/i);
	assert.match(empty.caveats.join("\n"), /credit balance was not reported.*unknown, not zero/i);

	const noReset = buildCodexQuotaReport({
		weekly: { usedPercent: 0, remainingPercent: 100, resetsAtMs: null, fetchedAtMs: NOW },
		credits: { kind: "balance", balance: "0" },
		fetchedAtMs: NOW,
	}, { nowMs: NOW, timeZone: "UTC" });
	assert.deepEqual(noReset.weekly, {
		usedPercent: 0, remainingPercent: 100, resetsAt: null, resetsAtLocal: null, untilReset: null, resetPassed: false,
	});
	assert.deepEqual(noReset.credits, { kind: "balance", balance: "0" });
	assert.match(noReset.caveats.join("\n"), /reset time was not reported/i);

	const unlimited = buildCodexQuotaReport({ credits: { kind: "unlimited" }, fetchedAtMs: NOW }, { nowMs: NOW, timeZone: "UTC" });
	assert.deepEqual(unlimited.credits, { kind: "unlimited" });
});

test("flags a passed weekly reset as stale instead of presenting it as current", () => {
	const report = buildCodexQuotaReport({
		weekly: { usedPercent: 99, remainingPercent: 1, resetsAtMs: NOW - 1000, fetchedAtMs: NOW },
		fetchedAtMs: NOW,
	}, { nowMs: NOW, timeZone: "UTC" });
	assert.equal(report.weekly?.resetPassed, true);
	assert.equal(report.weekly?.untilReset, null);
	assert.equal(report.weekly?.usedPercent, 99);
	assert.match(report.caveats.join("\n"), /already passed.*stale/i);
});

test("formats durations and local timestamps", () => {
	assert.equal(formatDuration(30_000), "<1m");
	assert.equal(formatDuration(45 * 60_000), "45m");
	assert.equal(formatDuration(2 * 3_600_000), "2h");
	assert.equal(formatDuration((3 * 86_400 + 5 * 60) * 1000), "3d 5m");
	assert.equal(formatDuration(RESET - NOW), "3d 17h 5m");
	assert.equal(formatLocal(NOW, "UTC"), "2026-10-10 12:00 UTC (UTC)");
	assert.equal(formatLocal(Date.UTC(2026, 0, 1, 0, 30), "Europe/London"), "2026-01-01 00:30 GMT (Europe/London)");
});

test("classifies failures and sanitizes messages without leaking raw output", () => {
	const missing = describeCodexQuotaError(new Error("Unable to start Codex app-server: spawn codex ENOENT"), HOME);
	assert.equal(missing.kind, "codex-cli-missing");
	assert.match(missing.message, /not found on PATH/);

	const timeout = describeCodexQuotaError(new Error("Codex quota query timed out after 300ms"), HOME);
	assert.equal(timeout.kind, "timeout");

	const leaky = describeCodexQuotaError(new Error(
		"Codex app-server exited before replying (1): \u001b[31mfatal\u001b[0m token sk-abc123456789 "
		+ "in /home/tester/.codex/auth.json Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig\n"
		+ "github_pat_11ABCDEFG",
	), HOME);
	assert.equal(leaky.kind, "lookup-failed");
	for (const secret of ["\u001b", "sk-abc123456789", "/home/tester", "eyJhbGci", "github_pat_11ABCDEFG", "\n"]) {
		assert.ok(!leaky.message.includes(secret), `leaked ${JSON.stringify(secret)}: ${leaky.message}`);
	}
	assert.match(leaky.message, /~\/\.codex\/auth\.json/);
	assert.match(leaky.message, /Bearer \[redacted\]/);
	assert.equal(leaky.hint, undefined);

	const login = describeCodexQuotaError(new Error("Codex quota query failed: not logged in"), HOME);
	assert.equal(login.kind, "lookup-failed");
	assert.match(login.hint ?? "", /codex login status/);

	const long = describeCodexQuotaError(new Error(`Codex quota query failed: ${"x".repeat(1000)}`), HOME);
	assert.ok(long.message.length <= 240, String(long.message.length));
	assert.ok(long.message.endsWith("…"));

	assert.equal(describeCodexQuotaError("plain string", HOME).message, "plain string");
});

test("parses only the documented arguments", () => {
	assert.deepEqual(parseCodexQuotaArgs([]), { timeoutMs: 10_000 });
	assert.deepEqual(parseCodexQuotaArgs(["--timeout-ms", "2500"]), { timeoutMs: 2500 });
	assert.deepEqual(parseCodexQuotaArgs(["--help"]), { help: true });
	for (const argv of [["--bogus"], ["extra"], ["--timeout-ms"], ["--timeout-ms", "abc"], ["--timeout-ms", "50"], ["--timeout-ms", "999999"]]) {
		assert.ok("error" in parseCodexQuotaArgs(argv), argv.join(" "));
	}
});

function collect() {
	const out: string[] = [];
	const err: string[] = [];
	return { out, err, io: { stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) } };
}

test("runCodexQuota prints a JSON report from an injected fetch and forwards the timeout", async () => {
	const { out, err, io } = collect();
	const received: unknown[] = [];
	const code = await runCodexQuota(["--timeout-ms", "2500"], {
		...io,
		fetch: async (options) => {
			received.push(options);
			return fullSnapshot;
		},
		nowMs: () => NOW,
		timeZone: "UTC",
		home: HOME,
	});
	assert.equal(code, 0);
	assert.deepEqual(received, [{ timeoutMs: 2500 }]);
	assert.deepEqual(err, []);
	const report = JSON.parse(out.join(""));
	assert.equal(report.status, "ok");
	assert.equal(report.weekly.usedPercent, 73.4);
	assert.equal(report.credits.balance, "126.4375");
});

test("runCodexQuota reports failures as a JSON envelope with exit 1 and usage errors with exit 2", async () => {
	const failed = collect();
	const code = await runCodexQuota([], {
		...failed.io,
		fetch: async () => { throw new Error("Unable to start Codex app-server: spawn codex ENOENT"); },
		timeZone: "UTC",
		home: HOME,
	});
	assert.equal(code, 1);
	const envelope = JSON.parse(failed.out.join(""));
	assert.equal(envelope.status, "error");
	assert.equal(envelope.error.kind, "codex-cli-missing");
	assert.deepEqual(envelope.caveats, SOURCE_CAVEATS);
	assert.deepEqual(failed.err, []);

	const usage = collect();
	assert.equal(await runCodexQuota(["--bogus"], { ...usage.io, fetch: async () => fullSnapshot }), 2);
	assert.deepEqual(usage.out, []);
	assert.match(usage.err.join(""), /usage/i);

	const help = collect();
	assert.equal(await runCodexQuota(["--help"], { ...help.io, fetch: async () => { throw new Error("must not fetch"); } }), 0);
	assert.match(help.out.join(""), /--timeout-ms/);
});

const FAKE_CODEX = String.raw`
import { writeFileSync } from "node:fs";
const [pidFile, mode] = process.argv.slice(2).filter((arg) => !arg.startsWith("app-server") && arg !== "--stdio");
if (pidFile) writeFileSync(pidFile, String(process.pid));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: { userAgent: "fake" } }) + "\n");
    if (message.id === 2 && mode !== "hang") {
      process.stdout.write(JSON.stringify({ id: 2, result: { rateLimits: {
        primary: { usedPercent: 23, windowDurationMins: 10080, resetsAt: 1800000000 },
        credits: { hasCredits: true, unlimited: false, balance: "12.50" }
      } } }) + "\n");
    }
    newline = buffer.indexOf("\n");
  }
});
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(0));
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

async function withFakeCodex(mode: "reply" | "hang", run: (bin: string, directory: string, pidFile: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "codex-quota-cli-"));
	const bin = join(directory, "bin");
	const pidFile = join(directory, "codex.pid");
	await mkdir(bin);
	const script = join(directory, "fake-codex.mjs");
	await writeFile(script, FAKE_CODEX);
	await writeFile(join(bin, "codex"), `#!${process.execPath}\nprocess.argv.push(${JSON.stringify(pidFile)}, ${JSON.stringify(mode)});\nawait import(${JSON.stringify(script)});\n`, { mode: 0o700 });
	try {
		await run(bin, directory, pidFile);
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

test("the executable reads a fake Codex app-server found on PATH", async () => {
	await withFakeCodex("reply", async (bin, directory) => {
		const result = await runCli(process.execPath, [ENTRY], { PATH: bin, HOME: directory, TZ: "UTC" });
		assert.equal(result.code, 0, result.stderr);
		const report = JSON.parse(result.stdout);
		assert.equal(report.status, "ok");
		assert.equal(report.timeZone, "UTC");
		assert.equal(report.weekly.usedPercent, 23);
		assert.equal(report.weekly.remainingPercent, 77);
		assert.equal(report.weekly.resetsAt, "2027-01-15T08:00:00.000Z");
		assert.equal(report.credits.balance, "12.50");
	});
});

test("the executable works through an extensionless PATH symlink", async () => {
	await withFakeCodex("reply", async (bin, directory) => {
		const link = join(bin, "codex-quota");
		await symlink(ENTRY, link);
		const result = await runCli(link, [], { PATH: `${bin}:${dirname(process.execPath)}`, HOME: directory, TZ: "UTC" });
		assert.equal(result.code, 0, result.stderr);
		assert.equal(JSON.parse(result.stdout).weekly.usedPercent, 23);
	});
});

test("a missing Codex CLI is reported without touching the network", async () => {
	const directory = await mkdtemp(join(tmpdir(), "codex-quota-missing-"));
	try {
		const result = await runCli(process.execPath, [ENTRY], { PATH: directory, HOME: directory, TZ: "UTC" });
		assert.equal(result.code, 1);
		const envelope = JSON.parse(result.stdout);
		assert.equal(envelope.status, "error");
		assert.equal(envelope.error.kind, "codex-cli-missing");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a timeout terminates the Codex child and reports a sanitized failure", async () => {
	await withFakeCodex("hang", async (bin, directory, pidFile) => {
		const result = await runCli(process.execPath, [ENTRY, "--timeout-ms", "300"], { PATH: bin, HOME: directory, TZ: "UTC" });
		await waitForFile(pidFile);
		assert.equal(result.code, 1);
		const envelope = JSON.parse(result.stdout);
		assert.equal(envelope.error.kind, "timeout");
		assert.ok(result.elapsedMs < 5000, String(result.elapsedMs));
		const pid = Number(await readFile(pidFile, "utf8"));
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	});
});
