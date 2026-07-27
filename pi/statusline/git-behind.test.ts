import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchGitBehind, formatGitBehind, GitBehindCache } from "./git-behind.ts";

async function withScript(body: string, run: (script: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-git-behind-"));
	const script = join(directory, "git.mjs");
	try {
		await writeFile(script, body, { mode: 0o755 });
		await run(script);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("formats only positive behind counts", () => {
	assert.equal(formatGitBehind(3), "⇣3");
	assert.equal(formatGitBehind(0), "");
	assert.equal(formatGitBehind(undefined), "");
});

test("reads a bounded count for the cache-keyed branch", async () => {
	await withScript("#!/usr/bin/env node\nif (process.argv.at(-1) !== 'main..main@{upstream}') process.exit(2);\nconsole.log('4');\n", async (command) => {
		assert.equal(await fetchGitBehind("/tmp", "main", { command, timeoutMs: 1000 }), 4);
	});
	await withScript("#!/usr/bin/env node\nconsole.log('invalid');\n", async (command) => {
		await assert.rejects(fetchGitBehind("/tmp", "main", { command, timeoutMs: 1000 }), /Invalid git behind count/);
	});
	await withScript("#!/usr/bin/env node\nsetTimeout(() => {}, 10000);\n", async (command) => {
		await assert.rejects(fetchGitBehind("/tmp", "main", { command, timeoutMs: 10 }));
	});
});

test("caches by branch, deduplicates refreshes, and hides failures", async () => {
	const requests: string[] = [];
	let resolveLoad: ((count: number) => void) | undefined;
	let fail = false;
	const cache = new GitBehindCache({
		ttlMs: 1000,
		load: (branch) => {
			requests.push(branch);
			if (fail) return Promise.reject(new Error("no upstream"));
			return new Promise<number>((resolve) => {
				resolveLoad = resolve;
			});
		},
	});

	const first = cache.refresh("main", 1000);
	await cache.refresh("main", 1001);
	assert.deepEqual(requests, ["main"]);
	resolveLoad?.(2);
	await first;
	assert.equal(cache.countFor("main"), 2);
	assert.equal(cache.countFor("other"), undefined);

	await cache.refresh("main", 1999);
	assert.deepEqual(requests, ["main"]);
	fail = true;
	await cache.refresh("main", 2000);
	assert.equal(cache.countFor("main"), undefined);
	assert.deepEqual(requests, ["main", "main"]);

	fail = false;
	const other = cache.refresh("feature", 2001);
	resolveLoad?.(0);
	await other;
	assert.equal(cache.countFor("feature"), 0);
	cache.dispose();
	assert.equal(cache.countFor("feature"), undefined);
});
