import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildOpenRouterQuotaReport, fetchOpenRouterQuotaSnapshot, runOpenRouterQuota } from "./openrouter-quota-report.ts";

const NOW = Date.UTC(2026, 9, 20, 12);
const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "openrouter-quota.ts");
const KEY = "arbitrary-key.*$\"}";
const env = { SECRET_API_KEY_PROJECT: "fixture" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const snapshot = (totalCredits = 0.3, totalUsage = 0.1) => ({ totalCredits, totalUsage, remainingCredits: totalCredits - totalUsage, fetchedAtMs: NOW });
const lookup = async () => KEY;

function collect() {
	const out: string[] = [], err: string[] = [];
	return { out, err, stdout: (text: string) => out.push(text), stderr: (text: string) => err.push(text) };
}

test("report preserves numeric totals separately from decimal-derived balance and retrieval time", () => {
	const report = buildOpenRouterQuotaReport(snapshot(), { timeZone: "UTC" });
	assert.equal(report.source, "openrouter-account-credits");
	assert.equal(report.fetchedAt, "2026-10-20T12:00:00.000Z");
	assert.equal(report.fetchedAtLocal, "2026-10-20 12:00 UTC (UTC)");
	assert.deepEqual(report.credits, {
		unit: "credits", reported: { totalCredits: "0.3", totalUsage: "0.1" }, derived: { remainingCredits: "0.2" },
	});
	assert.equal("weekly" in report, false);
	assert.equal("resetsAt" in report, false);
});

test("decimal subtraction keeps zero, negative, very small/large values and reported precision", () => {
	for (const [credits, usage, remaining] of [
		[0, 0, "0"], [-0, 0, "0"], [1, 1, "0"], [0.1, 0.3, "-0.2"],
		[10.63, 10, "0.63"], [1e-7, 3e-8, "0.00000007"],
		[1.5e21, 1e21, "500000000000000000000"], [0.30000000000000004, 0.1, "0.20000000000000004"],
	] as const) {
		const report = buildOpenRouterQuotaReport(snapshot(credits, usage), { timeZone: "UTC" });
		assert.equal(report.credits.derived.remainingCredits, remaining, `${credits} - ${usage}`);
		assert.equal(report.credits.reported.totalCredits, String(credits));
	}
});

test("one credits GET uses the explicit project management key, refuses redirects and ignores raw keys", async () => {
	const calls: unknown[] = [];
	const result = await fetchOpenRouterQuotaSnapshot({ timeoutMs: 500, env: {
		...env, OPENROUTER_API_KEY: "never-use", PI_STATUSLINE_OPENROUTER_MANAGEMENT_KEY: "never-use-either",
	}, lookup: async (project, options) => { calls.push(project); assert.ok(options.timeoutMs <= 500); return KEY; },
	fetchImpl: async (url, options) => {
		calls.push(String(url));
		assert.equal(options?.headers && (options.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
		assert.equal(options?.redirect, "error");
		assert.equal(options?.method ?? "GET", "GET");
		return response({ data: { total_credits: 2.75, total_usage: 0.25 } });
	} });
	assert.deepEqual(calls, ["fixture", "https://openrouter.ai/api/v1/credits"]);
	assert.equal(result.totalCredits, 2.75);
});

test("missing/invalid project never invokes lookup or HTTP, regardless of statusline raw-key overrides", async () => {
	for (const project of [undefined, "", "  ", "--help", "bad\nproject", "a/b"]) {
		await assert.rejects(fetchOpenRouterQuotaSnapshot({ timeoutMs: 100, env: {
			SECRET_API_KEY_PROJECT: project, PI_STATUSLINE_OPENROUTER_PROJECT: "other", OPENROUTER_API_KEY: KEY,
		}, lookup: async () => { throw new Error("lookup must not run"); },
		fetchImpl: async () => { throw new Error("HTTP must not run"); },
		}), { kind: "not-configured" });
	}
});

test("missing or malformed management credential never makes an HTTP request", async () => {
	for (const key of ["", " ", "line1\nline2", "bad\rkey"]) {
		await assert.rejects(fetchOpenRouterQuotaSnapshot({ timeoutMs: 100, env, lookup: async () => key,
			fetchImpl: async () => { throw new Error("HTTP must not run"); },
		}), { kind: "credential-unavailable" });
	}
});

test("HTTP errors and malformed totals are classified without exposing credentials or body", async () => {
	for (const [status, kind] of [[401, "authorization"], [403, "authorization"], [429, "lookup-failed"], [500, "lookup-failed"]] as const) {
		await assert.rejects(fetchOpenRouterQuotaSnapshot({ timeoutMs: 100, env, lookup,
			fetchImpl: async () => response({ error: KEY }, status),
		}), { kind });
	}
	for (const body of [{}, { data: {} }, { data: { total_credits: "10", total_usage: 1 } },
		{ data: { total_credits: -1, total_usage: 0 } }, { data: { total_credits: 0, total_usage: null } }]) {
		await assert.rejects(fetchOpenRouterQuotaSnapshot({ timeoutMs: 100, env, lookup,
			fetchImpl: async () => response(body),
		}), { kind: "unexpected-response" });
	}
	await assert.rejects(fetchOpenRouterQuotaSnapshot({ timeoutMs: 100, env, lookup,
		fetchImpl: async () => new Response(`not JSON ${KEY}`),
	}), { kind: "unexpected-response" });
});

test("timeout aborts the one request without retry", async () => {
	let calls = 0;
	await assert.rejects(fetchOpenRouterQuotaSnapshot({ timeoutMs: 30, env, lookup,
		fetchImpl: async (_url, options) => { calls++; return new Promise((_resolve, reject) => {
			options?.signal?.addEventListener("abort", () => reject(new Error(KEY)), { once: true });
		}); },
	}), { kind: "timeout" });
	assert.equal(calls, 1);
});

test("a lookup that consumes the budget cannot start HTTP even if it returns a credential", async () => {
	let requests = 0;
	await assert.rejects(fetchOpenRouterQuotaSnapshot({ timeoutMs: 20, env,
		lookup: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return KEY; },
		fetchImpl: async () => { requests++; return response({}); },
	}), { kind: "timeout" });
	assert.equal(requests, 0);
});

test("runtime JSON failures use fixed redacted messages rather than arbitrary thrown details", async () => {
	for (const cause of [new Error(KEY), new Error("Bearer " + KEY), KEY]) {
		const io = collect();
		assert.equal(await runOpenRouterQuota([], { ...io, fetch: async () => { throw cause; } }), 1);
		assert.equal(JSON.parse(io.out.join("")).status, "error");
		assert.equal(JSON.parse(io.out.join("")).error.kind, "lookup-failed");
		assert.ok(!io.out.join("").includes(KEY));
		assert.deepEqual(io.err, []);
	}
	const io = collect();
	assert.equal(await runOpenRouterQuota([], { ...io, fetch: () => fetchOpenRouterQuotaSnapshot({ timeoutMs: 100, env, lookup,
		fetchImpl: async () => { throw new Error(`Authorization Bearer ${KEY}`); },
	}) }), 1);
	assert.ok(!io.out.join("").includes(KEY));
});

test("report, timeout forwarding, help and argument/exit contracts match the existing quota helpers", async () => {
	const io = collect(); let timeout;
	assert.equal(await runOpenRouterQuota(["--timeout-ms", "500"], { ...io, timeZone: "UTC", fetch: async (options) => { timeout = options.timeoutMs; return snapshot(); } }), 0);
	assert.equal(timeout, 500);
	assert.equal(JSON.parse(io.out.join("")).credits.derived.remainingCredits, "0.2");
	for (const args of [["--help"], ["--bogus"], ["--timeout-ms", "99"]]) {
		const io = collect();
		const result = await runOpenRouterQuota(args, { ...io, fetch: async () => { throw new Error("must not fetch"); } });
		assert.equal(result, args[0] === "--help" ? 0 : 2);
		assert.match([...io.out, ...io.err].join(""), /usage: openrouter-quota/);
	}
});

test("a key-helper descendant holding stdout cannot defeat the lookup deadline", async () => {
	const directory = await mkdtemp(join(tmpdir(), "openrouter-quota-descendant-"));
	const pidFile = join(directory, "descendant.pid");
	try {
		const secret = join(directory, "secret-api-key");
		await writeFile(secret, `#!${process.execPath}\nimport {spawn} from 'node:child_process';\nimport {writeFileSync} from 'node:fs';\nconst child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]});\nwriteFileSync(${JSON.stringify(pidFile)},String(child.pid));\nchild.unref(); process.exit(0);\n`, { mode: 0o700 });
		const started = Date.now();
		const result = spawnSync(process.execPath, [ENTRY, "--timeout-ms", "200"], {
			env: { PATH: directory, HOME: directory, SECRET_API_KEY_PROJECT: "fixture" }, encoding: "utf8", timeout: 2000,
		});
		assert.equal(result.error, undefined, String(result.error));
		assert.equal(result.status, 1, result.stderr + result.stdout);
		assert.equal(JSON.parse(result.stdout).error.kind, "timeout");
		assert.ok(Date.now() - started < 1500);
	} finally {
		try { process.kill(Number(await readFile(pidFile, "utf8")), "SIGKILL"); } catch { /* Fixture may already be terminated. */ }
		await rm(directory, { recursive: true, force: true });
	}
});

test("executable uses keyring helper on PATH and remains network-free under a fetch fixture", async () => {
	const directory = await mkdtemp(join(tmpdir(), "openrouter-quota-cli-"));
	try {
		const bin = join(directory, "bin"); await mkdir(bin);
		await symlink(ENTRY, join(bin, "openrouter-quota"));
		const secret = join(bin, "secret-api-key");
		await writeFile(secret, `#!${process.execPath}\nimport assert from 'node:assert/strict';\nassert.deepEqual(process.argv.slice(2), ['lookup', 'openrouter_management', 'fixture']);\nprocess.stdout.write('synthetic-fixture-key\\n');\n`, { mode: 0o700 });
		const preload = join(directory, "fetch-fixture.mjs");
		await writeFile(preload, `globalThis.fetch = async (url, options) => {\n if(url !== 'https://openrouter.ai/api/v1/credits' || options.redirect !== 'error' || options.headers.Authorization !== 'Bearer synthetic-fixture-key') throw new Error('bad request');\n return new Response(JSON.stringify({data:{total_credits:0.3,total_usage:0.1}}));\n};\n`);
		const environment = { PATH: `${bin}:${dirname(process.execPath)}`, HOME: directory, TZ: "UTC", SECRET_API_KEY_PROJECT: "fixture", NODE_OPTIONS: `--import=${preload}` };
		const run = spawnSync(join(bin, "openrouter-quota"), [], { env: environment, encoding: "utf8", timeout: 5000 });
		assert.equal(run.status, 0, run.stderr + run.stdout);
		assert.equal(JSON.parse(run.stdout).credits.derived.remainingCredits, "0.2");
		const unconfigured = spawnSync(process.execPath, [ENTRY], {
			env: { ...environment, SECRET_API_KEY_PROJECT: "" }, encoding: "utf8", timeout: 5000,
		});
		assert.equal(unconfigured.status, 1);
		assert.equal(JSON.parse(unconfigured.stdout).error.kind, "not-configured");
		await rm(secret);
		const missing = spawnSync(process.execPath, [ENTRY], { env: environment, encoding: "utf8", timeout: 5000 });
		assert.equal(missing.status, 1);
		assert.equal(JSON.parse(missing.stdout).error.kind, "key-helper-missing");
		await writeFile(secret, `#!${process.execPath}\nprocess.stderr.write('PRIVATE-ARBITRARY-SECRET'); process.exit(1);\n`, { mode: 0o700 });
		const failed = spawnSync(process.execPath, [ENTRY], { env: environment, encoding: "utf8", timeout: 5000 });
		assert.equal(failed.status, 1);
		assert.equal(JSON.parse(failed.stdout).error.kind, "credential-unavailable");
		assert.ok(!(failed.stdout + failed.stderr).includes("PRIVATE-ARBITRARY-SECRET"));
		await writeFile(secret, `#!${process.execPath}\nsetInterval(()=>{},1000);\n`, { mode: 0o700 });
		const hung = spawnSync(process.execPath, [ENTRY, "--timeout-ms", "100"], { env: environment, encoding: "utf8", timeout: 5000 });
		assert.equal(hung.status, 1);
		assert.equal(JSON.parse(hung.stdout).error.kind, "timeout");
	} finally { await rm(directory, { recursive: true, force: true }); }
});
