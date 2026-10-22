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
				usedPercent: overrides.usedPercent ?? 30,
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
	assert.equal(cells.gpt, "GPT ▮▮▯▯▯");
	assert.equal(cells.claude, "Claude 5h ▮▯▯▯▯ · wk ▮▮▮▯▯ 5d");
	assert.doesNotMatch([cells.gpt, cells.claude].join(" │ "), /\d+%|\d\d:\d\d|10-\d\d/);
});

test("adds reset countdowns at warning usage, rounded up to whole days or hours", async () => {
	const fixture = await claudeFixture();
	const gpt = (usedPercent: number, resetsInMs = 96 * HOUR) =>
		accountQuotaCells(input({ codex: source(codexFixture({ usedPercent, resetsAt: Math.floor((NOW + resetsInMs) / 1000) })) }), plain).gpt;
	assert.equal(gpt(39), "GPT ▮▮▯▯▯");
	assert.equal(gpt(39.4), "GPT ▮▮▯▯▯");
	assert.equal(gpt(39.5), "GPT ▮▮▯▯▯ 4d");
	assert.equal(gpt(40), "GPT ▮▮▯▯▯ 4d");
	assert.equal(gpt(60), "GPT ▮▮▮▯▯ 4d");
	assert.equal(gpt(60, 96 * HOUR + 1000), "GPT ▮▮▮▯▯ 5d");
	assert.equal(gpt(60, 20 * 60_000), "GPT ▮▮▮▯▯ 1d");
	assert.equal(gpt(80), "GPT ▮▮▮▮▯ 4d · 126 cr");

	const claude = (session: number, sessionResetsInMs: number, week: number) => accountQuotaCells(input({ claude: source({
		...fixture,
		session: { usedPercent: session, resetsAtMs: NOW + sessionResetsInMs },
		week: { usedPercent: week, resetsAtMs: NOW + 30 * HOUR },
	}) }), plain).claude;
	assert.equal(claude(60, 90 * 60_000, 30), "Claude 5h ▮▮▮▯▯ 2h · wk ▮▮▯▯▯");
	assert.equal(claude(35, 2 * HOUR, 70), "Claude 5h ▮▮▯▯▯ · wk ▮▮▮▮▯ 2d");
	assert.equal(claude(104, 60_000, 20), "Claude 5h ▮▮▮▮▮ >100% 1h · wk ▮▯▯▯▯");
});

test("starts countdowns at the 40% warning boundary for all three windows at both gauge widths", () => {
	for (const gaugeWidth of [3, 5] as const) {
		for (const usedPercent of [0, 30, 39.4, 39.5, 40, 55, 60, 75, 100]) {
			const cells = accountQuotaCells(input({
				gaugeWidth,
				codex: source(codexFixture({ usedPercent })),
				claude: source({
					fetchedAtMs: NOW,
					session: { usedPercent, resetsAtMs: NOW + 2 * HOUR },
					week: { usedPercent, resetsAtMs: NOW + 72 * HOUR },
				}),
			}), plain);
			const expected = Math.round(usedPercent) >= 40;
			assert.equal(/ 4d/.test(cells.gpt ?? ""), expected, `GPT at ${usedPercent}%, ${gaugeWidth} blocks`);
			assert.equal(/ 2h/.test(cells.claude ?? ""), expected, `Claude 5h at ${usedPercent}%, ${gaugeWidth} blocks`);
			assert.equal(/ 3d/.test(cells.claude ?? ""), expected, `Claude wk at ${usedPercent}%, ${gaugeWidth} blocks`);
		}
	}
});

test("hides countdowns for stale, unreported resets or a smaller fit, keeping the gauge", async () => {
	const fixture = await claudeFixture();
	const critical = codexFixture({ usedPercent: 80 });
	assert.ok(critical.weekly);
	const noReset = { ...critical, weekly: { ...critical.weekly, resetsAtMs: null } };
	assert.equal(accountQuotaCells(input({ codex: source(noReset) }), plain).gpt, "GPT ▮▮▮▮▯ · 126 cr");
	const unknownReset = accountQuotaCells(input({ claude: source({ ...fixture, week: { usedPercent: 70, resetsAtMs: null } }) }), plain);
	assert.equal(unknownReset.claude, "Claude 5h ▮▯▯▯▯ · wk ▮▮▮▮▯");

	const stale = accountQuotaCells(input({ nowMs: NOW + STALE + 1, codex: source(critical), claude: source(fixture) }), plain);
	assert.deepEqual(stale, { gpt: "~GPT ▮▮▮▮▯ · 126 cr", claude: "~Claude 5h ▮▯▯▯▯ · wk ▮▮▮▯▯" });
	const failedRefresh = accountQuotaCells(input({ codex: source(critical, true), claude: source(fixture, true) }), plain);
	assert.deepEqual(failedRefresh, { gpt: "GPT ▮▮▮▮▯ 4d · 126 cr", claude: "Claude 5h ▮▯▯▯▯ · wk ▮▮▮▯▯ 5d" });
	const smaller = accountQuotaCells(input({ countdowns: false, codex: source(critical), claude: source(fixture) }), plain);
	assert.deepEqual(smaller, { gpt: "GPT ▮▮▮▮▯ · 126 cr", claude: "Claude 5h ▮▯▯▯▯ · wk ▮▮▮▯▯" });
});

test("shows GPT credits only while the weekly gauge is critical, at either gauge width", () => {
	const gpt = (usedPercent: number, gaugeWidth: 3 | 5 = 5) =>
		accountQuotaCells(input({ gaugeWidth, codex: source(codexFixture({ usedPercent })) }), plain).gpt;
	for (const used of [0, 59, 60, 74, 74.4]) {
		assert.doesNotMatch(gpt(used) ?? "", /cr/, String(used));
		assert.doesNotMatch(gpt(used, 3) ?? "", /cr/, String(used));
	}
	assert.equal(gpt(74.5), "GPT ▮▮▮▮▯ 4d · 126 cr");
	assert.equal(gpt(75), "GPT ▮▮▮▮▯ 4d · 126 cr");
	assert.equal(gpt(75, 3), "GPT ▮▮▮ 4d · 126 cr");
	assert.equal(gpt(100), "GPT ▮▮▮▮▮ 4d · 126 cr");
	assert.equal(gpt(100, 3), "GPT ▮▮▮ 4d · 126 cr");
	assert.equal(gpt(40), "GPT ▮▮▯▯▯ 4d");
});

test("decides credit visibility with the same rounded severity the gauge paints", () => {
	const tonesAt = (usedPercent: number) => {
		const tones: Array<[Tone, string]> = [];
		const cell = accountQuotaCells(input({ codex: source(codexFixture({ usedPercent })) }), (tone, text) => {
			tones.push([tone, text]);
			return text;
		}).gpt;
		return { cell, tones };
	};
	const critical = tonesAt(74.5);
	assert.match(critical.cell ?? "", / · 126 cr$/);
	assert.ok(critical.tones.some(([tone, text]) => tone === "error" && text === "▮▮▮▮"));
	assert.ok(critical.tones.some(([tone, text]) => tone === "error" && text === "GPT"));
	const warning = tonesAt(74.4);
	assert.doesNotMatch(warning.cell ?? "", /cr/);
	assert.ok(warning.tones.some(([tone, text]) => tone === "warning" && text === "▮▮▮▮"));
	assert.ok(warning.tones.every(([tone]) => tone !== "error"));
});

test("never infers GPT exhaustion from missing, expired, stale or other-provider data", async () => {
	const fixture = await claudeFixture();
	const critical = (fields: { credits?: unknown; resetsAt?: number } = {}) => codexFixture({ usedPercent: 90, ...fields });
	assert.equal(accountQuotaCells(input({ codex: source(codexFixture({ weekly: false })) }), plain).gpt, "GPT ?");
	const expired = accountQuotaCells(input({
		nowMs: NOW + 2 * HOUR,
		codex: { ...source(critical({ resetsAt: Math.floor((NOW + HOUR) / 1000) })), staleAfterMs: 24 * HOUR },
	}), plain);
	assert.equal(expired.gpt, "GPT ?");

	const tones: Tone[] = [];
	const stale = accountQuotaCells(input({ nowMs: NOW + STALE + 1, codex: source(critical()) }), (tone, text) => {
		tones.push(tone);
		return text;
	});
	assert.equal(stale.gpt, "~GPT ▮▮▮▮▮ · 126 cr");
	assert.deepEqual(new Set(tones), new Set(["dim"]));
	assert.equal(accountQuotaCells(input({ codex: source(critical(), true) }), plain).gpt, "GPT ▮▮▮▮▮ 4d · 126 cr");

	const otherProvider = accountQuotaCells(input({
		codex: source(codexFixture({ usedPercent: 30 })),
		claude: source({ ...fixture, session: { usedPercent: 104, resetsAtMs: NOW + HOUR } }),
	}), plain);
	assert.equal(otherProvider.gpt, "GPT ▮▮▯▯▯");
	assert.match(otherProvider.claude ?? "", />100%/);

	const zero = accountQuotaCells(input({ codex: source(critical({ credits: { hasCredits: true, unlimited: false, balance: "0" } })) }), plain);
	assert.equal(zero.gpt, "GPT ▮▮▮▮▮ 4d · 0 cr");
});

test("can shorten account gauges to three blocks without changing labels or credits", async () => {
	const cells = accountQuotaCells(input({ gaugeWidth: 3, codex: source(codexFixture()), claude: source(await claudeFixture()) }), plain);
	assert.equal(cells.gpt, "GPT ▮▯▯");
	assert.equal(cells.claude, "Claude 5h ▮▯▯ · wk ▮▮▯ 5d");
});

test("shows unknown, expired and missing windows as ? rather than zero or old values", async () => {
	const fixture = await claudeFixture();
	const cells = accountQuotaCells(input({
		nowMs: NOW + 6 * HOUR,
		codex: { ...source(codexFixture({ resetsAt: Math.floor((NOW + HOUR) / 1000) })), staleAfterMs: 24 * HOUR },
		claude: { ...source({ ...fixture, week: { usedPercent: null, resetsAtMs: null } }), staleAfterMs: 24 * HOUR },
	}), plain);
	assert.equal(cells.gpt, "GPT ?");
	assert.equal(cells.claude, "Claude 5h ? · wk ?");

	const missing = accountQuotaCells(input({ claude: source({ ...fixture, session: undefined }) }), plain);
	assert.equal(missing.claude, "Claude 5h ? · wk ▮▮▮▯▯ 5d");
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
	assert.equal(retained.gpt, "GPT ▮▮▯▯▯");
	assert.equal(retained.claude, "Claude 5h ▮▯▯▯▯ · wk ▮▮▮▯▯ 5d");
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
	assert.equal(cells.gpt, "~GPT ▮▮▯▯▯");
	assert.equal(cells.claude, "~Claude 5h ▮▯▯▯▯ · wk ▮▮▮▯▯");
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
	assert.equal(cells.gpt, "GPT ▯▯▯▯▯");
	assert.equal(cells.claude, "Claude 5h ▮▮▮▮▮ >100% 1h · wk ▮▮▮▯▯ 5d");
	assert.ok(tones.some(([tone, text]) => tone === "error" && text === " >100%"));
	assert.ok(tones.some(([tone, text]) => tone === "error" && text === "Claude"));

	const unlimited = accountQuotaCells(input({ codex: source(codexFixture({ usedPercent: 100, credits: { hasCredits: false, unlimited: true } })) }), plain);
	assert.equal(unlimited.gpt, "GPT ▮▮▮▮▮ 4d · ∞ cr");
	const nothing = accountQuotaCells(input({ codex: source(codexFixture({ weekly: false, credits: null })) }), plain);
	assert.equal(nothing.gpt, "GPT ?");
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
