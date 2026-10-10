import { homedir } from "node:os";
import { type CodexCredits, type CodexQuotaSnapshot, fetchCodexQuotaSnapshot } from "../statusline/codex-quota.ts";

export const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 120_000;
const MAX_MESSAGE_CHARS = 240;
const SOURCE = "codex-cli-account";

export const SOURCE_CAVEATS: readonly string[] = [
	"Values come from the Codex CLI's authenticated ChatGPT account (codex app-server account/rateLimits/read); alignment with Pi's active account is not verified.",
	"Credits are ChatGPT/Codex capacity, not OpenAI API dollar credit, extra weekly allowance, or a request count.",
	"A snapshot describes the account at retrieval time and does not guarantee future requests.",
];

export const USAGE = `usage: codex-quota [--timeout-ms <${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}>] [--help]

Prints the Codex CLI account's weekly quota, reset time, and credits as JSON.
Read-only: queries the local authenticated Codex CLI and runs no model turn.
Exit codes: 0 report printed, 1 lookup failed (JSON error envelope), 2 usage error.
`;

export interface WeeklyReport {
	usedPercent: number;
	remainingPercent: number;
	resetsAt: string | null;
	resetsAtLocal: string | null;
	untilReset: { seconds: number; text: string } | null;
	resetPassed: boolean;
}

export interface CodexQuotaReport {
	schemaVersion: 1;
	status: "ok";
	source: typeof SOURCE;
	timeZone: string;
	fetchedAt: string;
	fetchedAtLocal: string;
	weekly: WeeklyReport | null;
	credits: CodexCredits | null;
	caveats: string[];
}

export interface CodexQuotaError {
	kind: "codex-cli-missing" | "timeout" | "lookup-failed";
	message: string;
	hint?: string;
}

export interface CodexQuotaFailure {
	schemaVersion: 1;
	status: "error";
	source: typeof SOURCE;
	error: CodexQuotaError;
	caveats: string[];
}

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

export function buildCodexQuotaReport(snapshot: CodexQuotaSnapshot, options: { nowMs: number; timeZone: string }): CodexQuotaReport {
	const caveats = [...SOURCE_CAVEATS];
	let weekly: WeeklyReport | null = null;
	if (snapshot.weekly) {
		const resetsAtMs = snapshot.weekly.resetsAtMs;
		const resetPassed = resetsAtMs !== null && resetsAtMs <= options.nowMs;
		weekly = {
			usedPercent: snapshot.weekly.usedPercent,
			remainingPercent: snapshot.weekly.remainingPercent,
			resetsAt: resetsAtMs === null ? null : new Date(resetsAtMs).toISOString(),
			resetsAtLocal: resetsAtMs === null ? null : formatLocal(resetsAtMs, options.timeZone),
			untilReset: resetsAtMs === null || resetPassed
				? null
				: { seconds: Math.round((resetsAtMs - options.nowMs) / 1000), text: formatDuration(resetsAtMs - options.nowMs) },
			resetPassed,
		};
		if (resetsAtMs === null) caveats.push("The weekly reset time was not reported; time until reset is unknown.");
		if (resetPassed) {
			caveats.push("The reported weekly reset time has already passed, so this window is stale; refresh later rather than treating these percentages as current.");
		}
	} else {
		caveats.push("The weekly quota was not reported; treat it as unknown, not zero.");
	}
	if (!snapshot.credits) caveats.push("The credit balance was not reported; treat it as unknown, not zero.");
	return {
		schemaVersion: 1,
		status: "ok",
		source: SOURCE,
		timeZone: options.timeZone,
		fetchedAt: new Date(snapshot.fetchedAtMs).toISOString(),
		fetchedAtLocal: formatLocal(snapshot.fetchedAtMs, options.timeZone),
		weekly,
		credits: snapshot.credits ?? null,
		caveats,
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

export function describeCodexQuotaError(error: unknown, home = homedir()): CodexQuotaError {
	const raw = error instanceof Error ? error.message : String(error);
	if (raw.startsWith("Unable to start Codex app-server") && raw.includes("ENOENT")) {
		return { kind: "codex-cli-missing", message: "The Codex CLI (`codex`) was not found on PATH; install it and sign in before retrying." };
	}
	const message = sanitizeMessage(raw, home);
	if (raw.includes("timed out")) return { kind: "timeout", message };
	const described: CodexQuotaError = { kind: "lookup-failed", message };
	if (/not (?:logged|signed) in|\blogin\b|\bunauthori[sz]ed\b|\bunauthenticated\b|\b40[13]\b/i.test(raw)) {
		described.hint = "This may mean the Codex CLI is not signed in; check with `codex login status`.";
	}
	return described;
}

export type CodexQuotaArgs = { timeoutMs: number } | { help: true } | { error: string };

export function parseCodexQuotaArgs(argv: string[]): CodexQuotaArgs {
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

export interface RunDependencies {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	fetch?: (options: { timeoutMs: number }) => Promise<CodexQuotaSnapshot>;
	nowMs?: () => number;
	timeZone?: string;
	home?: string;
}

export async function runCodexQuota(argv: string[], deps: RunDependencies): Promise<number> {
	const args = parseCodexQuotaArgs(argv);
	if ("error" in args) {
		deps.stderr(`codex-quota: ${args.error}\n${USAGE}`);
		return 2;
	}
	if ("help" in args) {
		deps.stdout(USAGE);
		return 0;
	}
	const fetch = deps.fetch ?? ((options: { timeoutMs: number }) => fetchCodexQuotaSnapshot(options));
	let snapshot: CodexQuotaSnapshot;
	try {
		snapshot = await fetch({ timeoutMs: args.timeoutMs });
	} catch (error) {
		const failure: CodexQuotaFailure = {
			schemaVersion: 1,
			status: "error",
			source: SOURCE,
			error: describeCodexQuotaError(error, deps.home ?? homedir()),
			caveats: [...SOURCE_CAVEATS],
		};
		deps.stdout(`${JSON.stringify(failure, null, 2)}\n`);
		return 1;
	}
	const report = buildCodexQuotaReport(snapshot, {
		nowMs: deps.nowMs?.() ?? Date.now(),
		timeZone: deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
	});
	deps.stdout(`${JSON.stringify(report, null, 2)}\n`);
	return 0;
}
