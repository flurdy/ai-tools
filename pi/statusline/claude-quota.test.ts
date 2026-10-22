import assert from "node:assert/strict";
import test from "node:test";
import { CLAUDE_QUOTA_STATUS_KEY, claudeQuotaTone, claudeQuotaView } from "./claude-quota.ts";

const NOW_MS = 1_800_000_000_000;
const RESETS_AT = NOW_MS / 1000 + 3600;

function status(fields: Record<string, unknown>): string {
	return JSON.stringify({
		status: "allowed_warning",
		resetsAt: RESETS_AT,
		rateLimitType: "five_hour",
		overageStatus: "rejected",
		isUsingOverage: false,
		utilization: 0.62,
		surpassedThreshold: 0.5,
		observedAt: NOW_MS / 1000 - 30,
		...fields,
	});
}

const view = (text: string | undefined, provider = "pi-claude-cli", nowMs = NOW_MS) => claudeQuotaView(provider, text, nowMs);

test("reads the adapter's neutral status key", () => {
	assert.equal(CLAUDE_QUOTA_STATUS_KEY, "claude-rate-limit");
});

test("shows a warning window with utilization and its reset", () => {
	assert.deepEqual(view(status({})), {
		window: "5h",
		state: "warning",
		usedPercent: 62,
		over: false,
		extraUsage: false,
		resetsAtMs: RESETS_AT * 1000,
	});
});

test("scopes the cell to pi-claude-cli models only", () => {
	for (const provider of ["anthropic", "github-copilot", "openrouter", "openai-codex", undefined]) {
		assert.equal(claudeQuotaView(provider, status({}), NOW_MS), undefined, String(provider));
	}
});

test("hides absent, cleared and malformed status", () => {
	for (const text of [undefined, "", "not json", "null", "[]", "42", '"allowed"']) {
		assert.equal(view(text), undefined, String(text));
	}
});

test("hides unknown status values and unknown window types", () => {
	assert.equal(view(status({ status: "throttled" })), undefined);
	assert.equal(view(status({ status: undefined })), undefined);
	assert.equal(view(status({ rateLimitType: "seven_day_mystery" })), undefined);
	assert.equal(view(status({ rateLimitType: 7 })), undefined);
});

test("labels each known window without inventing another", () => {
	for (const [type, window] of [
		["five_hour", "5h"],
		["seven_day", "Wk"],
		["seven_day_opus", "Wk Opus"],
		["seven_day_sonnet", "Wk Sonnet"],
		["overage", "Extra"],
	]) {
		assert.equal(view(status({ rateLimitType: type }))?.window, window);
	}
});

test("keeps quiet for an allowed window without utilization", () => {
	assert.equal(view(status({ status: "allowed", utilization: null })), undefined);
});

test("treats unknown utilization as unknown, never zero", () => {
	for (const utilization of [null, undefined, "0.4", Number.NaN, -0.1]) {
		const result = view(status({ utilization }));
		assert.equal(result?.usedPercent, null, String(utilization));
		assert.equal(result?.state, "warning");
	}
});

test("preserves a reported zero utilization", () => {
	const result = view(status({ status: "allowed", utilization: 0 }));
	assert.equal(result?.usedPercent, 0);
	assert.equal(result?.state, "allowed");
});

test("marks utilization above 100 percent", () => {
	const result = view(status({ rateLimitType: "overage", utilization: 1.01 }));
	assert.equal(result?.usedPercent, 101);
	assert.equal(result?.over, true);
	assert.equal(view(status({ utilization: 1 }))?.over, false);
});

test("distinguishes rejection and extra usage", () => {
	assert.equal(view(status({ status: "rejected", utilization: null }))?.state, "rejected");
	assert.equal(view(status({ isUsingOverage: true }))?.extraUsage, true);
	assert.equal(view(status({ isUsingOverage: "yes" }))?.extraUsage, false);
	const quietButPaying = view(status({ status: "allowed", utilization: null, isUsingOverage: true }));
	assert.equal(quietButPaying?.extraUsage, true);
	assert.equal(quietButPaying?.usedPercent, null);
});

test("hides a reading whose window has reset or whose reset is unknown", () => {
	assert.equal(view(status({}), "pi-claude-cli", RESETS_AT * 1000), undefined);
	assert.equal(view(status({}), "pi-claude-cli", RESETS_AT * 1000 - 1)?.window, "5h");
	for (const resetsAt of [undefined, null, "soon", 0, Number.POSITIVE_INFINITY]) {
		assert.equal(view(status({ resetsAt })), undefined, String(resetsAt));
	}
});

test("takes the more severe of reported state and utilization for its tone", () => {
	const tone = (fields: Record<string, unknown>) => claudeQuotaTone(view(status(fields))!);
	assert.equal(tone({ status: "allowed", utilization: 0.2 }), "success");
	assert.equal(tone({ status: "allowed", utilization: 0.4 }), "warning");
	assert.equal(tone({ status: "allowed", utilization: 0.7 }), "warning");
	assert.equal(tone({ status: "allowed_warning", utilization: 0.2 }), "warning");
	assert.equal(tone({ status: "allowed_warning", utilization: null }), "warning");
	assert.equal(tone({ status: "allowed_warning", utilization: 0.8 }), "error");
	assert.equal(tone({ status: "allowed", utilization: 1.01 }), "error");
	assert.equal(tone({ status: "rejected", utilization: 0.1 }), "error");
	assert.equal(tone({ status: "allowed", utilization: null, isUsingOverage: true }), "success");
});

test("ignores observedAt when judging freshness", () => {
	assert.equal(view(status({ observedAt: 1 }))?.window, "5h");
	assert.equal(view(status({ observedAt: undefined }))?.window, "5h");
});
