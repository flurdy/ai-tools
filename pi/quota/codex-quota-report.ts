import { homedir } from "node:os";
import { type CodexCredits, type CodexQuotaSnapshot, fetchCodexQuotaSnapshot } from "../statusline/codex-quota.ts";
import { formatLocal, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, parseQuotaArgs, type ResetTiming, resetTiming, sanitizeMessage } from "./quota-common.ts";

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

export interface WeeklyReport extends ResetTiming {
	usedPercent: number;
	remainingPercent: number;
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

export function buildCodexQuotaReport(snapshot: CodexQuotaSnapshot, options: { nowMs: number; timeZone: string }): CodexQuotaReport {
	const caveats = [...SOURCE_CAVEATS];
	let weekly: WeeklyReport | null = null;
	if (snapshot.weekly) {
		weekly = {
			usedPercent: snapshot.weekly.usedPercent,
			remainingPercent: snapshot.weekly.remainingPercent,
			...resetTiming(snapshot.weekly.resetsAtMs, options),
		};
		if (snapshot.weekly.resetsAtMs === null) caveats.push("The weekly reset time was not reported; time until reset is unknown.");
		if (weekly.resetPassed) {
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

export interface RunDependencies {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	fetch?: (options: { timeoutMs: number }) => Promise<CodexQuotaSnapshot>;
	nowMs?: () => number;
	timeZone?: string;
	home?: string;
}

export async function runCodexQuota(argv: string[], deps: RunDependencies): Promise<number> {
	const args = parseQuotaArgs(argv);
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
