import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { claudeAccountUsage, type ClaudeAccountUsage } from "./claude-usage.ts";
import type { ClaudeQuotaView } from "./claude-quota.ts";
import { selectCodexQuotaSnapshot, type CodexQuotaSnapshot } from "./codex-quota.ts";
import { accountQuotaCells, adapterAlertVisible, type AccountQuotaInput, type Tone } from "./quota-cells.ts";

const NOW = Date.UTC(2026, 9, 18, 21, 0, 0);
const HOUR = 60 * 60_000;
const STALE = 15 * 60_000;
const plain = (_tone: Tone, text: string) => text;

async function claudeFixture(): Promise<ClaudeAccountUsage> {
	const envelope = JSON.parse(await readFile(new URL("../quota/fixtures/claude-usage-2.1.302.json", import.meta.url), "utf8"));
	return claudeAccountUsage({ panel: envelope.result, fetchedAtMs: NOW });
}

function codexFixture(overrides: { usedPercent?: number; resetsAt?: number; credits?: unknown; weekly?: boolean } = {}): CodexQuotaSnapshot {
	const snapshot = selectCodexQuotaSnapshot({
		rateLimits: {
			primary: overrides.weekly === false ? null : {
				usedPercent: overrides.usedPercent ?? 40,
				windowDurationMins: 10_080,
				resetsAt: overrides.resetsAt ?? Math.floor((NOW + 96 * HOUR) / 1000),
			},
			credits: "credits" in overrides ? overrides.credits : { hasCredits: true, unlimited: false, balance: "126.4375" },
		},
	}, NOW);
	assert.ok(snapshot);
	return snapshot;
}

function input(fields: Partial<AccountQuotaInput> = {}): AccountQuotaInput {
	return { nowMs: NOW, codex: undefined, claude: undefined, ...fields };
}

const source = <T>(value: T | undefined, failed = false) => ({ value, failed, staleAfterMs: STALE });

test("renders compact five-block account cells shared by both footer layouts", async () => {
	const cells = accountQuotaCells(input({ codex: source(codexFixture()), claude: source(await claudeFixture()) }), plain);
	assert.equal(cells.gpt, "GPT ▮▮▯▯▯ · 126 cr");
	assert.equal(cells.claude, "Claude 5h ▯▯▯▯▯ · wk ▮▮▯▯▯");
	assert.doesNotMatch([cells.gpt, cells.claude].join(" │ "), /\d+%|\d\d:\d\d|10-\d\d/);
});

test("shows unknown, expired and missing windows as ? rather than zero or old values", async () => {
	const fixture = await claudeFixture();
	const cells = accountQuotaCells(input({
		nowMs: NOW + 6 * HOUR,
		codex: { ...source(codexFixture({ resetsAt: Math.floor((NOW + HOUR) / 1000) })), staleAfterMs: 24 * HOUR },
		claude: { ...source({ ...fixture, week: { usedPercent: null, resetsAtMs: null } }), staleAfterMs: 24 * HOUR },
	}), plain);
	assert.equal(cells.gpt, "GPT ? · 126 cr");
	assert.equal(cells.claude, "Claude 5h ? · wk ?");

	const missing = accountQuotaCells(input({ claude: source({ ...fixture, session: undefined }) }), plain);
	assert.equal(missing.claude, "Claude 5h ? · wk ▮▮▯▯▯");
	const empty = accountQuotaCells(input({ claude: source({ session: undefined, week: undefined, fetchedAtMs: NOW }) }), plain);
	assert.equal(empty.claude, "Claude ?");
});

test("distinguishes disabled, loading, failed and last-good sources", async () => {
	const fixture = await claudeFixture();
	assert.deepEqual(accountQuotaCells(input(), plain), { gpt: undefined, claude: undefined });
	assert.deepEqual(accountQuotaCells(input({ codex: source(undefined), claude: source(undefined) }), plain), { gpt: undefined, claude: undefined });
	const failed = accountQuotaCells(input({ codex: source(undefined, true), claude: source(undefined, true) }), plain);
	assert.deepEqual(failed, { gpt: "GPT ?", claude: "Claude ?" });
	const retained = accountQuotaCells(input({ codex: source(codexFixture(), true), claude: source(fixture, true) }), plain);
	assert.equal(retained.gpt, "GPT ▮▮▯▯▯ · 126 cr");
	assert.equal(retained.claude, "Claude 5h ▯▯▯▯▯ · wk ▮▮▯▯▯");
});

test("marks snapshots older than the stale interval in text and dims every segment", async () => {
	const tones: Tone[] = [];
	const record = (tone: Tone, text: string) => {
		tones.push(tone);
		return text;
	};
	const cells = accountQuotaCells(input({
		nowMs: NOW + STALE + 1,
		codex: source(codexFixture()),
		claude: source(await claudeFixture()),
	}), record);
	assert.equal(cells.gpt, "~GPT ▮▮▯▯▯ · 126 cr");
	assert.equal(cells.claude, "~Claude 5h ▯▯▯▯▯ · wk ▮▮▯▯▯");
	assert.ok(tones.length > 0);
	assert.deepEqual(new Set(tones), new Set(["dim"]));
});

test("keeps zero, over-limit, credits-only and unlimited values distinct", async () => {
	const fixture = await claudeFixture();
	const tones: Array<[Tone, string]> = [];
	const record = (tone: Tone, text: string) => {
		tones.push([tone, text]);
		return text;
	};
	const cells = accountQuotaCells(input({
		codex: source(codexFixture({ usedPercent: 0 })),
		claude: source({ ...fixture, session: { usedPercent: 104, resetsAtMs: NOW + HOUR } }),
	}), record);
	assert.equal(cells.gpt, "GPT ▯▯▯▯▯ · 126 cr");
	assert.equal(cells.claude, "Claude 5h ▮▮▮▮▮ >100% · wk ▮▮▯▯▯");
	assert.ok(tones.some(([tone, text]) => tone === "error" && text === " >100%"));
	assert.ok(tones.some(([tone, text]) => tone === "error" && text === "Claude"));

	const creditsOnly = accountQuotaCells(input({ codex: source(codexFixture({ weekly: false })) }), plain);
	assert.equal(creditsOnly.gpt, "GPT · 126 cr");
	const unlimited = accountQuotaCells(input({ codex: source(codexFixture({ credits: { hasCredits: false, unlimited: true } })) }), plain);
	assert.equal(unlimited.gpt, "GPT ▮▮▯▯▯ · ∞ cr");
	const nothing = accountQuotaCells(input({ codex: source(codexFixture({ weekly: false, credits: null })) }), plain);
	assert.equal(nothing.gpt, undefined);
});

test("shows adapter telemetry only when it adds a signal the fresh account snapshot lacks", () => {
	const view = (fields: Partial<ClaudeQuotaView> = {}): ClaudeQuotaView => ({
		window: "5h", state: "allowed", usedPercent: 30, over: false, extraUsage: false, resetsAtMs: NOW + HOUR, ...fields,
	});
	assert.equal(adapterAlertVisible(view(), true), false);
	assert.equal(adapterAlertVisible(view({ window: "Wk" }), true), false);
	assert.equal(adapterAlertVisible(view(), false), true);
	for (const fields of [{ state: "warning" }, { state: "rejected" }, { over: true }, { extraUsage: true }, { window: "Wk Opus" }, { window: "Extra" }] as const) {
		assert.equal(adapterAlertVisible(view(fields), true), true, JSON.stringify(fields));
	}
});
