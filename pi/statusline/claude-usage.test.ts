import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeAccountUsage, ClaudeQuotaLookupError, fetchClaudeUsageSnapshot } from "./claude-usage.ts";

const FIXTURE = new URL("../quota/fixtures/claude-usage-2.1.302.json", import.meta.url);
const NOW = Date.UTC(2026, 9, 18, 21, 0, 0);

async function fixturePanel(): Promise<string> {
	return JSON.parse(await readFile(FIXTURE, "utf8")).result;
}

test("maps the session and all-model week windows, ignoring per-model weeks", async () => {
	assert.deepEqual(claudeAccountUsage({ panel: await fixturePanel(), fetchedAtMs: NOW }), {
		session: { usedPercent: 12, resetsAtMs: Date.UTC(2026, 9, 19, 2, 19) },
		week: { usedPercent: 55, resetsAtMs: Date.UTC(2026, 9, 23, 6, 59) },
		fetchedAtMs: NOW,
	});
});

test("keeps missing and unrecognised windows unknown, never zero, and preserves over-limit values", () => {
	assert.deepEqual(claudeAccountUsage({
		panel: "Current week (all models): lots used · resets next Thursday (Europe/London)",
		fetchedAtMs: NOW,
	}), { session: undefined, week: { usedPercent: null, resetsAtMs: null }, fetchedAtMs: NOW });
	assert.deepEqual(claudeAccountUsage({ panel: "Current session: 104% used · resets 3am (UTC)", fetchedAtMs: NOW }).session, {
		usedPercent: 104,
		resetsAtMs: Date.UTC(2026, 9, 19, 3),
	});
	assert.deepEqual(claudeAccountUsage({ panel: "No usage", fetchedAtMs: NOW }), { session: undefined, week: undefined, fetchedAtMs: NOW });
});

async function withFakeClaude(run: (record: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "statusline-claude-usage-"));
	const record = join(directory, "record.json");
	const previousPath = process.env.PATH;
	await writeFile(join(directory, "claude"), `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ pid: process.pid }));
setInterval(() => {}, 1000);
`, { mode: 0o700 });
	process.env.PATH = `${directory}:${previousPath ?? ""}`;
	try {
		await run(record);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		await rm(directory, { recursive: true, force: true });
	}
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		try {
			return await access(path);
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw new Error(`Timed out waiting for ${path}`);
}

function rejectsAsAborted(error: unknown): boolean {
	assert.ok(error instanceof ClaudeQuotaLookupError);
	assert.equal(error.kind, "lookup-failed");
	assert.match(error.message, /aborted/);
	return true;
}

test("a pre-aborted lookup rejects without starting Claude Code", async () => {
	await withFakeClaude(async (record) => {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(fetchClaudeUsageSnapshot({ timeoutMs: 5000, signal: controller.signal }), rejectsAsAborted);
		await assert.rejects(access(record));
	});
});

test("aborting a running lookup kills the Claude process group promptly", async () => {
	await withFakeClaude(async (record) => {
		const controller = new AbortController();
		const started = Date.now();
		const lookup = fetchClaudeUsageSnapshot({ timeoutMs: 10_000, signal: controller.signal });
		await waitForFile(record);
		controller.abort();
		await assert.rejects(lookup, rejectsAsAborted);
		assert.ok(Date.now() - started < 5000);
		const { pid } = JSON.parse(await readFile(record, "utf8"));
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	});
});
