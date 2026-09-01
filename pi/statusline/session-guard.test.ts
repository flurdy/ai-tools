import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import test from "node:test";
import {
	formatSessionGuard,
	LeaseOccupancyCache,
	SESSION_GUARD_EMOJI,
	sessionGuardLabel,
} from "./session-guard.ts";

const expected = {
	acquiring: "⏳",
	implement: "✅",
	plan: "🔍",
	conflict: "⛔",
	lost: "💥",
	unguarded: "🚨",
} as const;

test("maps plain and themed session guard labels to distinct fixed-width emoji", () => {
	assert.deepEqual(SESSION_GUARD_EMOJI, expected);
	for (const [label, emoji] of Object.entries(expected)) {
		assert.equal(formatSessionGuard(label), emoji);
		assert.equal(sessionGuardLabel(`\x1b[31m${label}\x1b[0m`), label);
		assert.equal(formatSessionGuard(`\x1b[31m${label}\x1b[0m`), emoji);
		assert.equal(visibleWidth(emoji), 2);
	}
	assert.equal(visibleWidth("🔒"), 2);
});

test("preserves unknown and explicitly text-only guard statuses", () => {
	const unknown = "\x1b[35mfuture-state\x1b[0m";
	assert.equal(formatSessionGuard(unknown), unknown);
	assert.equal(formatSessionGuard("\x1b[32mimplement\x1b[0m", false), "\x1b[32mimplement\x1b[0m");
	assert.equal(sessionGuardLabel(unknown), undefined);
});

test("caches plan-mode occupancy, deduplicates refreshes, and resets outside plan", async () => {
	const requests: string[] = [];
	let resolveLoad: ((value: "held" | "free" | "unavailable") => void) | undefined;
	const cache = new LeaseOccupancyCache({
		ttlMs: 1000,
		settleMs: 0,
		load: (cwd) => {
			requests.push(cwd);
			return new Promise((resolve) => { resolveLoad = resolve; });
		},
	});

	await cache.refresh(null, 999);
	assert.deepEqual(requests, []);
	const first = cache.refresh("/repo", 1000);
	await cache.refresh("/repo", 1001);
	assert.deepEqual(requests, ["/repo"]);
	resolveLoad?.("held");
	await first;
	assert.equal(cache.occupiedFor("/repo"), true);

	await cache.refresh("/repo", 1999);
	assert.deepEqual(requests, ["/repo"]);
	await cache.refresh(null, 2000);
	assert.equal(cache.occupiedFor("/repo"), false);
	cache.dispose();
});

test("an obsolete probe cannot clear a newer in-flight refresh", async () => {
	const requests: Array<{ resolve(value: "held" | "free" | "unavailable"): void }> = [];
	const cache = new LeaseOccupancyCache({
		ttlMs: 1000,
		settleMs: 0,
		load: () => new Promise((resolve) => requests.push({ resolve })),
	});
	const obsolete = cache.refresh("/repo", 1000);
	await cache.refresh(null, 1001);
	const current = cache.refresh("/repo", 1002);
	requests[0]?.resolve("held");
	await obsolete;
	void cache.refresh("/repo", 3000);
	assert.equal(requests.length, 2);
	requests[1]?.resolve("free");
	await current;
	cache.dispose();
});

test("hides free, unavailable, and failed occupancy results", async () => {
	for (const result of ["free", "unavailable"] as const) {
		const cache = new LeaseOccupancyCache({ ttlMs: 1000, settleMs: 0, load: async () => result });
		await cache.refresh("/repo", 1000);
		assert.equal(cache.occupiedFor("/repo"), false);
		cache.dispose();
	}
	const failed = new LeaseOccupancyCache({
		ttlMs: 1000,
		settleMs: 0,
		load: async () => { throw new Error("probe failed"); },
	});
	await failed.refresh("/repo", 1000);
	assert.equal(failed.occupiedFor("/repo"), false);
	failed.dispose();
});
