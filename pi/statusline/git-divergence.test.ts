import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchGitDivergence, formatGitDivergence, GitDivergenceCache } from "./git-divergence.ts";

async function withScript(body: string, run: (script: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-git-divergence-"));
	const script = join(directory, "git.mjs");
	try {
		await writeFile(script, body, { mode: 0o755 });
		await run(script);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("formats only non-zero divergence directions", () => {
	assert.equal(formatGitDivergence({ ahead: 3, behind: 2 }), "⇡3 ⇣2");
	assert.equal(formatGitDivergence({ ahead: 3, behind: 0 }), "⇡3");
	assert.equal(formatGitDivergence({ ahead: 0, behind: 2 }), "⇣2");
	assert.equal(formatGitDivergence({ ahead: 0, behind: 0 }), "");
	assert.equal(formatGitDivergence(undefined), "");
});

test("reads bounded divergence for the cache-keyed branch", async () => {
	await withScript("#!/usr/bin/env node\nif (process.argv.at(-1) !== 'main@{upstream}...main') process.exit(2);\nconsole.log('2 4');\n", async (command) => {
		assert.deepEqual(await fetchGitDivergence("/tmp", "main", { command, timeoutMs: 1000 }), { ahead: 4, behind: 2 });
	});
	await withScript("#!/usr/bin/env node\nconsole.log('invalid');\n", async (command) => {
		await assert.rejects(fetchGitDivergence("/tmp", "main", { command, timeoutMs: 1000 }), /Invalid git divergence counts/);
	});
	await withScript("#!/usr/bin/env node\nsetTimeout(() => {}, 10000);\n", async (command) => {
		await assert.rejects(fetchGitDivergence("/tmp", "main", { command, timeoutMs: 10 }));
	});
});

test("caches by branch, deduplicates refreshes, and hides failures", async () => {
	const requests: string[] = [];
	let resolveLoad: ((divergence: { ahead: number; behind: number }) => void) | undefined;
	let fail = false;
	const cache = new GitDivergenceCache({
		ttlMs: 1000,
		load: (branch) => {
			requests.push(branch);
			if (fail) return Promise.reject(new Error("no upstream"));
			return new Promise((resolve) => {
				resolveLoad = resolve;
			});
		},
	});

	const first = cache.refresh("main", 1000);
	await cache.refresh("main", 1001);
	assert.deepEqual(requests, ["main"]);
	resolveLoad?.({ ahead: 2, behind: 1 });
	await first;
	assert.deepEqual(cache.divergenceFor("main"), { ahead: 2, behind: 1 });
	assert.equal(cache.divergenceFor("other"), undefined);

	await cache.refresh("main", 1999);
	assert.deepEqual(requests, ["main"]);
	fail = true;
	await cache.refresh("main", 2000);
	assert.equal(cache.divergenceFor("main"), undefined);
	assert.deepEqual(requests, ["main", "main"]);

	fail = false;
	const other = cache.refresh("feature", 2001);
	resolveLoad?.({ ahead: 0, behind: 0 });
	await other;
	assert.deepEqual(cache.divergenceFor("feature"), { ahead: 0, behind: 0 });
	cache.dispose();
	assert.equal(cache.divergenceFor("feature"), undefined);
});
