/**
 * Reads the `claude-rate-limit` status published by the pi-claude-cli adapter.
 *
 * Each payload describes only the binding window, so this never implies a
 * full 5h/weekly dashboard. `observedAt` changes only when the payload does,
 * so freshness is bounded by `resetsAt` alone.
 */

import { codexQuotaTone } from "./quota-display.ts";

export const CLAUDE_QUOTA_STATUS_KEY = "claude-rate-limit";
const CLAUDE_CLI_PROVIDER = "pi-claude-cli";

const WINDOWS: Record<string, string> = {
	five_hour: "5h",
	seven_day: "Wk",
	seven_day_opus: "Wk Opus",
	seven_day_sonnet: "Wk Sonnet",
	overage: "Extra",
};

const STATES = { allowed: "allowed", allowed_warning: "warning", rejected: "rejected" } as const;

export type ClaudeQuotaState = (typeof STATES)[keyof typeof STATES];

export interface ClaudeQuotaView {
	window: string;
	state: ClaudeQuotaState;
	/** Reported utilization; null when unknown, which is not zero. */
	usedPercent: number | null;
	over: boolean;
	extraUsage: boolean;
	resetsAtMs: number;
}

const TONE_ORDER = ["success", "warning", "error"] as const;
export type ClaudeQuotaTone = (typeof TONE_ORDER)[number];

/** The more severe of the reported state and the utilization thresholds. */
export function claudeQuotaTone(view: ClaudeQuotaView): ClaudeQuotaTone {
	if (view.state === "rejected" || view.over) return "error";
	const stateTone: ClaudeQuotaTone = view.state === "warning" ? "warning" : "success";
	const usageTone = view.usedPercent === null ? "success" : codexQuotaTone(view.usedPercent);
	return TONE_ORDER[Math.max(TONE_ORDER.indexOf(stateTone), TONE_ORDER.indexOf(usageTone))];
}

function parse(text: string | undefined): Record<string, unknown> | undefined {
	if (!text) return undefined;
	try {
		const value: unknown = JSON.parse(text);
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

export function claudeQuotaView(provider: string | undefined, text: string | undefined, nowMs: number): ClaudeQuotaView | undefined {
	if (provider !== CLAUDE_CLI_PROVIDER) return undefined;
	const payload = parse(text);
	if (!payload) return undefined;
	const state = typeof payload.status === "string" && Object.hasOwn(STATES, payload.status)
		? STATES[payload.status as keyof typeof STATES]
		: undefined;
	const window = typeof payload.rateLimitType === "string" && Object.hasOwn(WINDOWS, payload.rateLimitType)
		? WINDOWS[payload.rateLimitType]
		: undefined;
	const resetsAt = payload.resetsAt;
	if (!state || !window || typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return undefined;
	const resetsAtMs = resetsAt * 1000;
	if (nowMs >= resetsAtMs) return undefined;
	const utilization = typeof payload.utilization === "number" && Number.isFinite(payload.utilization) && payload.utilization >= 0
		? payload.utilization
		: null;
	const extraUsage = payload.isUsingOverage === true;
	if (state === "allowed" && utilization === null && !extraUsage) return undefined;
	return {
		window,
		state,
		usedPercent: utilization === null ? null : Math.round(utilization * 100),
		over: utilization !== null && utilization > 1,
		extraUsage,
		resetsAtMs,
	};
}
