import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BeadsCountsCache, findBeadsRoot, formatBeadsCounts, parseBeadsCounts, type BeadsCounts } from "./beads-status.ts";

const firstCounts: BeadsCounts = { openByPriority: [0, 0, 0, 0, 4], inProgress: 1, blocked: 0 };
const secondCounts: BeadsCounts = { openByPriority: [0, 1, 2, 0, 0], inProgress: 2, blocked: 1 };

test("groups open Beads by priority and counts active and blocked work", () => {
	const issues = [
		{ status: "open", priority: 0 },
		{ status: "open", priority: 2 },
		{ status: "open", priority: 2 },
		{ status: "open", priority: 4 },
		{ status: "in_progress", priority: 1 },
		{ status: "in_progress", priority: 4 },
		{ status: "deferred", priority: 3 },
	];
	assert.deepEqual(parseBeadsCounts(JSON.stringify(issues), JSON.stringify([{ id: "blocked-1" }])), {
		openByPriority: [1, 0, 2, 0, 1],
		inProgress: 2,
		blocked: 1,
	});
});

test("rejects malformed or invalid Beads lists", () => {
	assert.equal(parseBeadsCounts("not json", "[]"), undefined);
	assert.equal(parseBeadsCounts("[]", "{}"), undefined);
	assert.equal(parseBeadsCounts(JSON.stringify([{ status: "open", priority: 5 }]), "[]"), undefined);
	assert.equal(parseBeadsCounts(JSON.stringify([{ priority: 2 }]), "[]"), undefined);
});

test("formats compact priority, active, and blocked indicators", () => {
	assert.equal(formatBeadsCounts(undefined), "");
	assert.equal(formatBeadsCounts({ openByPriority: [0, 0, 0, 0, 5], inProgress: 1, blocked: 0 }), "◉ P4:5 ◐1");
	assert.equal(formatBeadsCounts({ openByPriority: [1, 0, 2, 0, 5], inProgress: 1, blocked: 2 }), "◉ P0:1 P2:2 P4:5 ◐1 ⛔2");
	assert.equal(formatBeadsCounts({ openByPriority: [0, 0, 0, 0, 0], inProgress: 0, blocked: 0 }), "◉ 0 ◐0");
});

test("finds the nearest Beads workspace", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-statusline-beads-"));
	try {
		const workspace = join(directory, "workspace");
		const nested = join(workspace, "one", "two");
		await mkdir(join(workspace, ".beads"), { recursive: true });
		await mkdir(nested, { recursive: true });
		assert.equal(findBeadsRoot(nested), workspace);
		assert.equal(findBeadsRoot(directory), undefined);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("deduplicates refreshes and honors the cache interval", async () => {
	const pending: Array<(counts: BeadsCounts) => void> = [];
	let loads = 0;
	let changes = 0;
	const cache = new BeadsCountsCache({
		load: () => {
			loads += 1;
			return new Promise((resolve) => pending.push(resolve));
		},
		ttlMs: 1000,
		onChange: () => {
			changes += 1;
		},
	});

	const first = cache.refresh(1000);
	await cache.refresh(1001);
	assert.equal(loads, 1);
	pending.shift()?.(firstCounts);
	await first;
	assert.deepEqual(cache.counts, firstCounts);
	assert.equal(changes, 1);

	await cache.refresh(1999);
	assert.equal(loads, 1);
	const second = cache.refresh(2000);
	assert.equal(loads, 2);
	pending.shift()?.(secondCounts);
	await second;
	assert.deepEqual(cache.counts, secondCounts);
});

test("hides stale counts after a failed refresh", async () => {
	let fail = false;
	const cache = new BeadsCountsCache({
		load: async () => {
			if (fail) throw new Error("bd unavailable");
			return firstCounts;
		},
		ttlMs: 1000,
	});

	await cache.refresh(1000);
	assert.deepEqual(cache.counts, firstCounts);
	fail = true;
	await cache.refresh(2000);
	assert.equal(cache.counts, undefined);
});

test("aborts an active refresh and ignores late results when disposed", async () => {
	let changed = false;
	let aborted = false;
	let resolveLoad: ((counts: BeadsCounts) => void) | undefined;
	const cache = new BeadsCountsCache({
		load: (signal) => {
			signal.addEventListener(
				"abort",
				() => {
					aborted = true;
				},
				{ once: true },
			);
			return new Promise((resolve) => {
				resolveLoad = resolve;
			});
		},
		ttlMs: 1000,
		onChange: () => {
			changed = true;
		},
	});

	const refresh = cache.refresh();
	cache.dispose();
	resolveLoad?.(secondCounts);
	await refresh;
	assert.equal(aborted, true);
	assert.equal(cache.counts, undefined);
	assert.equal(changed, false);
});
