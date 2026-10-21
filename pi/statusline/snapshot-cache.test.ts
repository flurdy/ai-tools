import assert from "node:assert/strict";
import test from "node:test";
import { SnapshotCache } from "./snapshot-cache.ts";

type Pending = { resolve(value: string): void; reject(error: Error): void; signal: AbortSignal };

function harness(isPermanentFailure?: (error: unknown) => boolean) {
	let now = 0;
	let changes = 0;
	const loads: Pending[] = [];
	const cache = new SnapshotCache<string>({
		load: (signal) => new Promise((resolve, reject) => loads.push({ resolve, reject, signal })),
		refreshMs: 1000,
		maxBackoffMs: 3000,
		isPermanentFailure,
		onChange: () => changes++,
		now: () => now,
	});
	return {
		cache,
		loads,
		changes: () => changes,
		advance(ms: number) {
			now += ms;
		},
		async succeed(value: string) {
			const refresh = cache.refreshIfDue();
			loads.at(-1)?.resolve(value);
			await refresh;
		},
		async fail(message = "offline") {
			const refresh = cache.refreshIfDue();
			loads.at(-1)?.reject(new Error(message));
			await refresh;
		},
	};
}

test("loads immediately, shares one in-flight lookup and waits for the refresh interval", async () => {
	const h = harness();
	const first = h.cache.refreshIfDue();
	const second = h.cache.refreshIfDue();
	assert.equal(first, second);
	assert.equal(h.loads.length, 1);
	h.loads[0].resolve("a");
	await first;
	assert.equal(h.cache.value, "a");
	assert.equal(h.cache.failed, false);
	assert.equal(h.changes(), 1);

	h.advance(999);
	await h.cache.refreshIfDue();
	assert.equal(h.loads.length, 1);
	h.advance(1);
	await h.succeed("b");
	assert.equal(h.loads.length, 2);
	assert.equal(h.cache.value, "b");
});

test("keeps the last good value on failure and backs off exponentially up to the cap", async () => {
	const h = harness();
	await h.succeed("good");
	const attemptsAfter = async (ms: number) => {
		h.advance(ms - 1);
		await h.cache.refreshIfDue();
		const before = h.loads.length;
		h.advance(1);
		await h.fail();
		return [before, h.loads.length];
	};
	assert.deepEqual(await attemptsAfter(1000), [1, 2]);
	assert.equal(h.cache.value, "good");
	assert.equal(h.cache.failed, true);
	assert.deepEqual(await attemptsAfter(1000), [2, 3]);
	assert.deepEqual(await attemptsAfter(2000), [3, 4]);
	assert.deepEqual(await attemptsAfter(3000), [4, 5]);
	assert.deepEqual(await attemptsAfter(3000), [5, 6]);

	h.advance(3000);
	await h.succeed("recovered");
	assert.equal(h.cache.failed, false);
	h.advance(1000);
	void h.cache.refreshIfDue();
	assert.equal(h.loads.length, 8);
	h.cache.dispose();
});

test("stops looking up after a permanent failure", async () => {
	const h = harness((error) => error instanceof Error && error.message === "refused");
	await h.fail("refused");
	assert.equal(h.cache.stopped, true);
	assert.equal(h.cache.failed, true);
	h.advance(60_000);
	await h.cache.refreshIfDue();
	assert.equal(h.loads.length, 1);
});

test("dispose aborts the in-flight lookup and ignores its late result", async () => {
	const h = harness();
	const refresh = h.cache.refreshIfDue();
	h.cache.dispose();
	assert.equal(h.loads[0].signal.aborted, true);
	h.loads[0].resolve("late");
	await refresh;
	assert.equal(h.cache.value, undefined);
	assert.equal(h.changes(), 0);
	h.advance(10_000);
	await h.cache.refreshIfDue();
	assert.equal(h.loads.length, 1);
});
