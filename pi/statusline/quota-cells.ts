/**
 * Account-wide subscription cells for the footer. Pure: callers pass cached
 * snapshots and a painter, so rendering never triggers a lookup.
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

export interface AccountQuotaInput {
	nowMs: number;
	formatReset: (resetsAtMs: number) => string;
	/** Undefined when the source is disabled. */
	codex: SourceState<CodexQuotaSnapshot> | undefined;
	claude: SourceState<ClaudeAccountUsage> | undefined;
}

export interface QuotaCell {
	compact: string;
	table: string;
}

type UsageWindow = Pick<ClaudeAccountWindow, "usedPercent" | "resetsAtMs">;
type UsageTone = Exclude<Tone, "dim">;

const TONE_ORDER: readonly UsageTone[] = ["success", "warning", "error"];

function worst(tones: Array<UsageTone | undefined>): Tone {
	const known = tones.filter((tone): tone is UsageTone => tone !== undefined);
	return known.length === 0 ? "dim" : TONE_ORDER[Math.max(...known.map((tone) => TONE_ORDER.indexOf(tone)))];
}

function unknown(label: string, paint: Paint): QuotaCell {
	const text = paint("dim", `${label} ?`);
	return { compact: text, table: text };
}

/**
 * Compact cells are gauges (fill = used share, like ctx) plus a textual over-limit marker;
 * table cells add the used percentage and reset. A window whose reset has passed is
 * unknown until the next lookup, not its old value.
 */
function windowCell(label: string, window: UsageWindow | undefined, input: AccountQuotaInput, stale: boolean, paint: Paint): QuotaCell & { tone?: UsageTone } {
	const used = window?.usedPercent ?? null;
	if (!window || used === null || (window.resetsAtMs !== null && input.nowMs >= window.resetsAtMs)) return unknown(label, paint);
	const tone = codexQuotaTone(used);
	const shade = (fill: Tone) => (text: string) => paint(stale ? "dim" : fill, text);
	const colors = { ok: shade("success"), warn: shade("warning"), crit: shade("error"), empty: shade("dim") };
	const gauge = (width: number) => bar(used, width, CODEX_QUOTA_WARN_PERCENT, CODEX_QUOTA_CRIT_PERCENT, colors);
	const name = stale ? paint("dim", label) : label;
	const percent = paint(stale ? "dim" : tone, `${Math.round(used)}%`);
	const over = used > 100 ? paint(stale ? "dim" : tone, " >100%") : "";
	const reset = window.resetsAtMs === null ? "" : paint("dim", ` · ${input.formatReset(window.resetsAtMs)}`);
	return {
		compact: `${name} ${gauge(3)}${over}`,
		table: `${name} ${gauge(6)} ${percent}${reset}`,
		tone,
	};
}

function provider(label: string, tone: Tone, stale: boolean, paint: Paint): string {
	return stale ? paint("dim", `~${label}`) : paint(tone, label);
}

function gptCell(input: AccountQuotaInput, paint: Paint): QuotaCell | undefined {
	const source = input.codex;
	const snapshot = source?.value;
	if (!source || !snapshot) return source?.failed ? unknown("GPT", paint) : undefined;
	const stale = input.nowMs - snapshot.fetchedAtMs > source.staleAfterMs;
	const credits = snapshot.credits && paint(stale ? "dim" : "success", formatCodexCredits(snapshot.credits));
	if (!snapshot.weekly && !credits) return undefined;
	const weekly = snapshot.weekly && windowCell("wk", snapshot.weekly, input, stale, paint);
	const label = provider("GPT", weekly ? worst([weekly.tone]) : "success", stale, paint);
	const cell = (window: string | undefined) => [window ? `${label} ${window}` : label, credits].filter(Boolean).join(" · ");
	return { compact: cell(weekly?.compact), table: cell(weekly?.table) };
}

function claudeCell(input: AccountQuotaInput, paint: Paint): QuotaCell | undefined {
	const source = input.claude;
	const usage = source?.value;
	if (!source || !usage) return source?.failed ? unknown("Claude", paint) : undefined;
	if (!usage.session && !usage.week) return unknown("Claude", paint);
	const stale = input.nowMs - usage.fetchedAtMs > source.staleAfterMs;
	const session = windowCell("5h", usage.session, input, stale, paint);
	const week = windowCell("wk", usage.week, input, stale, paint);
	const label = provider("Claude", worst([session.tone, week.tone]), stale, paint);
	return { compact: `${label} ${session.compact} · ${week.compact}`, table: `${label} ${session.table} · ${week.table}` };
}

export function accountQuotaCells(input: AccountQuotaInput, paint: Paint): { gpt: QuotaCell | undefined; claude: QuotaCell | undefined } {
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
