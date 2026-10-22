/**
 * Account-wide subscription cells shared by both footer layouts. Pure: callers
 * pass cached snapshots and a painter, so rendering never triggers a lookup.
 */

import type { ClaudeAccountUsage, ClaudeAccountWindow } from "./claude-usage.ts";
import type { ClaudeQuotaView } from "./claude-quota.ts";
import { formatCodexCredits, type CodexQuotaSnapshot } from "./codex-quota.ts";
import { bar, CODEX_QUOTA_CRIT_PERCENT, CODEX_QUOTA_WARN_PERCENT, codexQuotaTone } from "./quota-display.ts";

export type Tone = "success" | "warning" | "error" | "dim";
export type Paint = (tone: Tone, text: string) => string;

export interface SourceState<T> {
	value: T | undefined;
	/** The latest lookup failed; any value is the last good snapshot. */
	failed: boolean;
	staleAfterMs: number;
}

export interface QuotaFit {
	/** Five at full width; three when the footer needs a smaller fit. */
	gaugeWidth: 3 | 5;
	/** Reset countdowns on windows with warning or critical quota severity. */
	countdowns: boolean;
}

/** Tried in order until the footer fits: countdowns go before the gauges shrink. */
export const QUOTA_FITS: readonly QuotaFit[] = [
	{ gaugeWidth: 5, countdowns: true },
	{ gaugeWidth: 5, countdowns: false },
	{ gaugeWidth: 3, countdowns: false },
];

export interface AccountQuotaInput extends Partial<QuotaFit> {
	nowMs: number;
	/** Undefined when the source is disabled. */
	codex: SourceState<CodexQuotaSnapshot> | undefined;
	claude: SourceState<ClaudeAccountUsage> | undefined;
}

type UsageWindow = Pick<ClaudeAccountWindow, "usedPercent" | "resetsAtMs">;
type UsageTone = Exclude<Tone, "dim">;
type CountdownUnit = "d" | "h";

interface GaugeOptions extends QuotaFit {
	nowMs: number;
	stale: boolean;
	paint: Paint;
}

const UNIT_MS: Record<CountdownUnit, number> = { d: 24 * 60 * 60_000, h: 60 * 60_000 };

function gaugeOptions(input: AccountQuotaInput, stale: boolean, paint: Paint): GaugeOptions {
	return { nowMs: input.nowMs, stale, paint, gaugeWidth: input.gaugeWidth ?? 5, countdowns: input.countdowns ?? true };
}

const TONE_ORDER: readonly UsageTone[] = ["success", "warning", "error"];

function worst(tones: Array<UsageTone | undefined>): Tone {
	const known = tones.filter((tone): tone is UsageTone => tone !== undefined);
	return known.length === 0 ? "dim" : TONE_ORDER[Math.max(...known.map((tone) => TONE_ORDER.indexOf(tone)))];
}

/** Whole units left until a reported, unexpired reset, rounded up; stale snapshots get none. */
function countdown(used: number, resetsAtMs: number | null, unit: CountdownUnit, o: GaugeOptions): string {
	if (!o.countdowns || o.stale || resetsAtMs === null || codexQuotaTone(used) === "success") return "";
	return ` ${Math.ceil((resetsAtMs - o.nowMs) / UNIT_MS[unit])}${unit}`;
}

/**
 * Fill is the used share, like ctx. Resets invalidate old values; warning and
 * critical windows add a countdown. One severity paints the fill, label and credits.
 */
function windowGauge(window: UsageWindow | undefined, unit: CountdownUnit, o: GaugeOptions): { text: string; tone?: UsageTone } {
	const used = window?.usedPercent ?? null;
	if (!window || used === null || (window.resetsAtMs !== null && o.nowMs >= window.resetsAtMs)) return { text: o.paint("dim", "?") };
	const tone = codexQuotaTone(used);
	const shade = (fill: Tone) => (text: string) => o.paint(o.stale ? "dim" : fill, text);
	const colors = { ok: shade(tone), warn: shade(tone), crit: shade(tone), empty: shade("dim") };
	const gauge = bar(used, o.gaugeWidth, CODEX_QUOTA_WARN_PERCENT, CODEX_QUOTA_CRIT_PERCENT, colors);
	const over = used > 100 ? o.paint(o.stale ? "dim" : tone, " >100%") : "";
	return { text: `${gauge}${over}${countdown(used, window.resetsAtMs, unit, o)}`, tone };
}

function provider(label: string, tone: Tone, stale: boolean, paint: Paint): string {
	return stale ? paint("dim", `~${label}`) : paint(tone, label);
}

/**
 * Credits stay in /quota during ordinary use and appear here only while this
 * account's weekly gauge is critical. A missing or expired window is unknown,
 * not exhausted; a stale or failed-refresh snapshot keeps its own verdict, dimmed.
 */
function gptCell(input: AccountQuotaInput, paint: Paint): string | undefined {
	const source = input.codex;
	const snapshot = source?.value;
	if (!source || !snapshot) return source?.failed ? paint("dim", "GPT ?") : undefined;
	const stale = input.nowMs - snapshot.fetchedAtMs > source.staleAfterMs;
	const weekly = windowGauge(snapshot.weekly, "d", gaugeOptions(input, stale, paint));
	const label = provider("GPT", worst([weekly.tone]), stale, paint);
	const credits = weekly.tone === "error" && snapshot.credits && paint(stale ? "dim" : "success", formatCodexCredits(snapshot.credits));
	return [`${label} ${weekly.text}`, credits].filter(Boolean).join(" · ");
}

function claudeCell(input: AccountQuotaInput, paint: Paint): string | undefined {
	const source = input.claude;
	const usage = source?.value;
	if (!source || !usage) return source?.failed ? paint("dim", "Claude ?") : undefined;
	if (!usage.session && !usage.week) return paint("dim", "Claude ?");
	const stale = input.nowMs - usage.fetchedAtMs > source.staleAfterMs;
	const options = gaugeOptions(input, stale, paint);
	const session = windowGauge(usage.session, "h", options);
	const week = windowGauge(usage.week, "d", options);
	const label = provider("Claude", worst([session.tone, week.tone]), stale, paint);
	const name = (text: string) => stale ? paint("dim", text) : text;
	return `${label} ${name("5h")} ${session.text} · ${name("wk")} ${week.text}`;
}

export function accountQuotaCells(input: AccountQuotaInput, paint: Paint): { gpt: string | undefined; claude: string | undefined } {
	return { gpt: gptCell(input, paint), claude: claudeCell(input, paint) };
}

/**
 * pi-claude-cli turn telemetry reports one binding window. Show it beside the
 * account snapshot only when it adds a warning, limit, overage or window the
 * snapshot lacks, or when no fresh snapshot is available.
 */
export function adapterAlertVisible(view: ClaudeQuotaView, accountSnapshotFresh: boolean): boolean {
	return !accountSnapshotFresh || view.state !== "allowed" || view.over || view.extraUsage || (view.window !== "5h" && view.window !== "Wk");
}
