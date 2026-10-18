export const DEFAULT_TIMEOUT_MS = 10_000;
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 120_000;
const MAX_MESSAGE_CHARS = 240;

export function formatDuration(ms: number): string {
	const totalMinutes = Math.floor(ms / 60_000);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	const parts: string[] = [];
	if (days > 0) parts.push(`${days}d`);
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0) parts.push(`${minutes}m`);
	return parts.length > 0 ? parts.join(" ") : "<1m";
}

export function formatLocal(ms: number, timeZone: string): string {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		timeZoneName: "short",
	}).formatToParts(new Date(ms));
	const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? "";
	return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")} ${part("timeZoneName")} (${timeZone})`;
}

export interface ResetTiming {
	resetsAt: string | null;
	resetsAtLocal: string | null;
	untilReset: { seconds: number; text: string } | null;
	resetPassed: boolean;
}

export function resetTiming(resetsAtMs: number | null, options: { nowMs: number; timeZone: string }): ResetTiming {
	if (resetsAtMs === null) return { resetsAt: null, resetsAtLocal: null, untilReset: null, resetPassed: false };
	const resetPassed = resetsAtMs <= options.nowMs;
	return {
		resetsAt: new Date(resetsAtMs).toISOString(),
		resetsAtLocal: formatLocal(resetsAtMs, options.timeZone),
		untilReset: resetPassed
			? null
			: { seconds: Math.round((resetsAtMs - options.nowMs) / 1000), text: formatDuration(resetsAtMs - options.nowMs) },
		resetPassed,
	};
}

export function sanitizeMessage(message: string, home: string): string {
	let text = message
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f]+/g, " ");
	if (home.length > 1) text = text.split(home).join("~");
	text = text
		.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/\b(?:sk|ghp|gho|ghu|ghs|github_pat|xox[a-z])[-_][A-Za-z0-9_-]{6,}/g, "[redacted]")
		.replace(/\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_.-]+)?/g, "[redacted]")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text;
}

export type QuotaArgs = { timeoutMs: number } | { help: true } | { error: string };

export function parseQuotaArgs(argv: string[]): QuotaArgs {
	let timeoutMs = DEFAULT_TIMEOUT_MS;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") return { help: true };
		if (arg !== "--timeout-ms") return { error: `unexpected argument: ${arg}` };
		const value = argv[++index];
		if (value === undefined || !/^\d+$/.test(value)) return { error: "--timeout-ms requires a whole number of milliseconds" };
		timeoutMs = Number(value);
		if (timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
			return { error: `--timeout-ms must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}` };
		}
	}
	return { timeoutMs };
}
