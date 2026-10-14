import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fetchGitDivergence, findGitWorkspaceRoot, formatGitDivergence, GitDivergenceCache } from "./git-divergence.ts";

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

test("formats workspace sources separately, preserving order and failures", () => {
	assert.equal(formatGitDivergence({
		repositories: [{ ahead: 1, behind: 0 }, { ahead: 0, behind: 0 }, { ahead: 4, behind: 2 }, { ahead: 0, behind: 3 }],
		unavailableSources: 2,
	}), "⇡1 ⇡4 ⇣2 ⇣3 ⚠2");
	assert.equal(formatGitDivergence({ repositories: [], unavailableSources: 2 }), "? ⚠2");
	assert.equal(formatGitDivergence({ repositories: [{ ahead: 0, behind: 0 }], unavailableSources: 0 }), "");
	assert.equal(formatGitDivergence({ repositories: [], unavailableSources: null }), "? ⚠");
});

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

test("workspace reads validate payloads, stay exact-cwd scoped, and bound collector lifetime", async () => {
	await withScript("#!/usr/bin/env node\nconsole.log('2 4');\n", async (command) => {
		const root = join(command, "..", "workspace");
		await mkdir(root);
		for (const dir of [".git", ".beads", "repos", "infrastructure"]) await mkdir(join(root, dir));
		for (const file of ["README.md", "AGENTS.md", "Makefile", "workspace.json"]) await writeFile(join(root, file), "");
		const alias = join(root, "..", "alias");
		await symlink(root, alias);
		assert.equal(findGitWorkspaceRoot(alias), root);
		const member = join(root, "repos", "service");
		await mkdir(member);
		assert.equal(findGitWorkspaceRoot(member), undefined);
		const collector = join(root, "..", "collector.mjs");
		const payload = {
			version: 1, repositories: [{ repository: "workspace", path: ".", ahead: 4, behind: 2 }],
			successfulSources: 1, unavailableSources: 1, diagnostics: ["unavailable"],
		};
		await writeFile(collector, `#!/usr/bin/env node\nif(process.argv[2] !== 'git-counts' || process.argv[3] !== '--workspace' || process.argv[4] !== ${JSON.stringify(root)}) process.exit(2);\nsetTimeout(()=>console.log(${JSON.stringify(JSON.stringify(payload))}), 550);\n`, { mode: 0o755 });
		assert.deepEqual(await fetchGitDivergence(root, "", { workspaceCommand: collector }), {
			repositories: [{ ahead: 4, behind: 2 }], unavailableSources: 1,
		});
		assert.deepEqual(await fetchGitDivergence(member, "main", { command, workspaceCommand: "/not-installed", timeoutMs: 1000 }), { ahead: 4, behind: 2 });
		for (const malformed of [null, {}, { ...payload, successfulSources: 2 }, { ...payload, unavailableSources: -1 },
			{ ...payload, repositories: [{ repository: "workspace", path: ".", ahead: true, behind: 0 }] }]) {
			await writeFile(collector, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(malformed))});\n`);
			await assert.rejects(fetchGitDivergence(root, "main", { workspaceCommand: collector }), /Invalid project-workspace/);
		}
		await writeFile(collector, "#!/usr/bin/env node\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n");
		await assert.rejects(fetchGitDivergence(root, "main", { workspaceCommand: collector, timeoutMs: 100 }), /timed out/);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(fetchGitDivergence(root, "main", { workspaceCommand: collector, signal: controller.signal }), /aborted/);
	});
});

test("workspace cache works without a root branch and shows failed refreshes", async () => {
	let calls = 0;
	const cache = new GitDivergenceCache({ workspace: true, ttlMs: 1000, load: async () => {
		calls++;
		if (calls > 1) throw Error("collector unavailable");
		return { repositories: [{ ahead: 2, behind: 0 }], unavailableSources: 1 };
	} });
	await cache.refresh(null, 1000);
	assert.equal(formatGitDivergence(cache.divergenceFor(null)), "⇡2 ⚠1");
	await cache.refresh("new-branch", 1500);
	assert.equal(calls, 1);
	await cache.refresh(null, 2000);
	assert.equal(formatGitDivergence(cache.divergenceFor(null)), "? ⚠");
	await cache.refresh(null, 2500);
	assert.equal(calls, 2);
	cache.dispose();
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
