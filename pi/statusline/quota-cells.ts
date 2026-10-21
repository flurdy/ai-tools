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

export interface AccountQuotaInput {
	nowMs: number;
	/** Undefined when the source is disabled. */
	codex: SourceState<CodexQuotaSnapshot> | undefined;
	claude: SourceState<ClaudeAccountUsage> | undefined;
}

type UsageWindow = Pick<ClaudeAccountWindow, "usedPercent" | "resetsAtMs">;
type UsageTone = Exclude<Tone, "dim">;

const TONE_ORDER: readonly UsageTone[] = ["success", "warning", "error"];

function worst(tones: Array<UsageTone | undefined>): Tone {
	const known = tones.filter((tone): tone is UsageTone => tone !== undefined);
	return known.length === 0 ? "dim" : TONE_ORDER[Math.max(...known.map((tone) => TONE_ORDER.indexOf(tone)))];
}

/** Fill is the used share, like ctx. Resets still invalidate old values, but are not rendered. */
function windowGauge(window: UsageWindow | undefined, nowMs: number, stale: boolean, paint: Paint): { text: string; tone?: UsageTone } {
	const used = window?.usedPercent ?? null;
	if (!window || used === null || (window.resetsAtMs !== null && nowMs >= window.resetsAtMs)) return { text: paint("dim", "?") };
	const tone = codexQuotaTone(used);
	const shade = (fill: Tone) => (text: string) => paint(stale ? "dim" : fill, text);
	const colors = { ok: shade("success"), warn: shade("warning"), crit: shade("error"), empty: shade("dim") };
	const gauge = bar(used, 5, CODEX_QUOTA_WARN_PERCENT, CODEX_QUOTA_CRIT_PERCENT, colors);
	const over = used > 100 ? paint(stale ? "dim" : tone, " >100%") : "";
	return { text: `${gauge}${over}`, tone };
}

function provider(label: string, tone: Tone, stale: boolean, paint: Paint): string {
	return stale ? paint("dim", `~${label}`) : paint(tone, label);
}

function gptCell(input: AccountQuotaInput, paint: Paint): string | undefined {
	const source = input.codex;
	const snapshot = source?.value;
	if (!source || !snapshot) return source?.failed ? paint("dim", "GPT ?") : undefined;
	const stale = input.nowMs - snapshot.fetchedAtMs > source.staleAfterMs;
	const credits = snapshot.credits && paint(stale ? "dim" : "success", formatCodexCredits(snapshot.credits));
	if (!snapshot.weekly && !credits) return undefined;
	const weekly = snapshot.weekly && windowGauge(snapshot.weekly, input.nowMs, stale, paint);
	const label = provider("GPT", weekly ? worst([weekly.tone]) : "success", stale, paint);
	return [weekly ? `${label} ${weekly.text}` : label, credits].filter(Boolean).join(" · ");
}

function claudeCell(input: AccountQuotaInput, paint: Paint): string | undefined {
	const source = input.claude;
	const usage = source?.value;
	if (!source || !usage) return source?.failed ? paint("dim", "Claude ?") : undefined;
	if (!usage.session && !usage.week) return paint("dim", "Claude ?");
	const stale = input.nowMs - usage.fetchedAtMs > source.staleAfterMs;
	const session = windowGauge(usage.session, input.nowMs, stale, paint);
	const week = windowGauge(usage.week, input.nowMs, stale, paint);
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
