import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import test from "node:test";
import { formatSessionGuard, SESSION_GUARD_EMOJI, sessionGuardLabel } from "./session-guard.ts";

const expected = {
	acquiring: "⏳",
	implement: "✅",
	plan: "🔍",
	conflict: "⛔",
	lost: "💥",
	unguarded: "🚨",
} as const;

test("maps plain and themed guard states to distinct emoji without a lease claim", () => {
	assert.deepEqual(SESSION_GUARD_EMOJI, expected);
	assert.equal(new Set(Object.values(expected)).size, Object.keys(expected).length);
	for (const [label, emoji] of Object.entries(expected)) {
		const themed = `\x1b[31m${label}\x1b[0m`;
		assert.equal(formatSessionGuard(label), emoji);
		assert.equal(sessionGuardLabel(themed), label);
		assert.equal(formatSessionGuard(themed), emoji);
		assert.equal(formatSessionGuard(themed, false), themed);
		assert.equal(visibleWidth(emoji), 2);
	}
});

test("folds one, multiple and maximum published worktree counts into implement", () => {
	for (const count of [1, 2, 9, 10, 31, 32]) {
		const suffix = count > 1 ? String(count) : "";
		const scopes = `leases:${count} api, web`;
		assert.equal(formatSessionGuard("implement", true, scopes), `🔒${suffix}`);
		assert.equal(formatSessionGuard("\x1b[32mimplement\x1b[0m", true, scopes), `🔒${suffix}`);
		assert.ok(visibleWidth(formatSessionGuard("implement", true, scopes)) <= 4);
		assert.equal(formatSessionGuard("implement", false, scopes), `implement${count > 1 ? ` ${count}` : ""}`);
	}
});

test("preserves themed text with a count only for multiple implement leases", () => {
	const themed = "\x1b[32mimplement\x1b[0m";
	assert.equal(formatSessionGuard(themed, false, "leases:1 child"), themed);
	assert.equal(formatSessionGuard(themed, false, "leases:2 api, web"), `${themed} 2`);
	assert.equal(visibleWidth(formatSessionGuard(themed, false, "leases:32")), 12);
});

test("never claims a worktree lock for zero, missing or malformed counts", () => {
	for (const scopes of ["", "leases:0", "leases:0 child", "invalid scope", "grants:2", "leases:-1", "leases:2.5", "leases:02", "leases:33", "leases:320", "leases:2repo", "leases:99999999999999999999999"]) {
		assert.equal(formatSessionGuard("implement", true, scopes), "✅", scopes);
		assert.equal(formatSessionGuard("implement", false, scopes), "implement", scopes);
	}
});

test("ignores stale lease counts in every non-implement state", () => {
	for (const [label, emoji] of Object.entries(expected)) {
		if (label === "implement") continue;
		assert.equal(formatSessionGuard(label, true, "leases:32 api"), emoji);
		assert.equal(formatSessionGuard(label, false, "leases:32 api"), label);
	}
});

test("discards lease names and terminal controls rather than rendering them", () => {
	for (const scopes of [
		"\x1b[32mleases:2 api, web\x1b[0m",
		"leases:2 repo\n\r\t\x00\x7f\x9b31m",
		"leases:2 \x1b]0;title\x07\x1b[2J",
		`leases:2 ${"long-name".repeat(1000)}`,
	]) {
		assert.equal(formatSessionGuard("implement", true, scopes), "🔒2");
		assert.equal(formatSessionGuard("implement", false, scopes), "implement 2");
	}
});

test("preserves unknown guard statuses without appending lease data", () => {
	const unknown = "\x1b[35mfuture-state\x1b[0m";
	assert.equal(formatSessionGuard(unknown, true, "leases:2"), unknown);
	assert.equal(formatSessionGuard(unknown, false, "leases:2"), unknown);
	assert.equal(formatSessionGuard("", true, "leases:2"), "");
	assert.equal(sessionGuardLabel(unknown), undefined);
});
