import { homedir } from "node:os";
import {
	ClaudeQuotaLookupError,
	type ClaudeUsageErrorKind,
	type ClaudeUsageSnapshot,
	fetchClaudeUsageSnapshot,
	parseClaudeUsagePanel,
} from "../statusline/claude-usage.ts";
import { formatLocal, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, parseQuotaArgs, type ResetTiming, resetTiming, sanitizeMessage } from "./quota-common.ts";

export { CLAUDE_USAGE_ARGS, ClaudeQuotaLookupError, type ClaudeUsageSnapshot, fetchClaudeUsageSnapshot, readUsageEnvelope } from "../statusline/claude-usage.ts";

const SOURCE = "claude-code-usage";

export const SOURCE_CAVEATS: readonly string[] = [
	"Values come from Claude Code's local /usage panel for the account it is signed in to; alignment with Pi's active Claude account is not verified.",
	"The panel is undocumented human-readable text: unrecognised or missing values are null with a caveat, never zero.",
	"The panel's approximate, local-only \"What's contributing\" breakdown is not reported.",
	"A snapshot describes the account at retrieval time and does not guarantee future requests.",
];

export const USAGE = `usage: claude-quota [--timeout-ms <${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}>] [--help]

Prints the Claude Code account's subscription usage windows and reset times as JSON.
Read-only: runs Claude Code's local /usage command once; no model turn, no session saved.
Exit codes: 0 report printed, 1 lookup failed (JSON error envelope), 2 usage error.
`;

export interface UsageWindow extends ResetTiming {
	label: string;
	usedPercent: number | null;
	resetsAtText: string | null;
	resetsTimeZone: string | null;
}

export interface ClaudeQuotaReport {
	schemaVersion: 1;
	status: "ok";
	source: typeof SOURCE;
	timeZone: string;
	fetchedAt: string;
	fetchedAtLocal: string;
	windows: UsageWindow[];
	caveats: string[];
}

export interface ClaudeQuotaError {
	kind: ClaudeUsageErrorKind;
	message: string;
	hint?: string;
}

export interface ClaudeQuotaFailure {
	schemaVersion: 1;
	status: "error";
	source: typeof SOURCE;
	error: ClaudeQuotaError;
	caveats: string[];
}

export function buildClaudeQuotaReport(snapshot: ClaudeUsageSnapshot, options: { nowMs: number; timeZone: string }): ClaudeQuotaReport {
	const home = homedir();
	const caveats = [...SOURCE_CAVEATS];
	const windows: UsageWindow[] = [];
	const parsed = parseClaudeUsagePanel(snapshot, (line) => sanitizeMessage(line, home));
	let resolvedResets = false;
	for (const { caveats: windowCaveats, resetsAtMs, ...window } of parsed.windows) {
		caveats.push(...windowCaveats);
		const timing = resetTiming(resetsAtMs, options);
		if (resetsAtMs !== null) resolvedResets = true;
		if (timing.resetPassed) {
			caveats.push(`The reported reset time for "${window.label}" has already passed, so this window is stale; refresh later rather than treating its percentage as current.`);
		}
		windows.push({ ...window, ...timing });
	}
	const unrecognised = parsed.unrecognisedLines;
	if (unrecognised > 0) {
		caveats.push(`${unrecognised} limit-like ${unrecognised === 1 ? "line" : "lines"} in the /usage panel ${unrecognised === 1 ? "was" : "were"} not recognised; some limits may be missing.`);
	}
	if (windows.length === 0) caveats.push("No limit windows were recognised in the /usage panel; treat Claude usage as unknown, not zero.");
	if (resolvedResets) {
		caveats.push("Claude Code shows reset times without a year; resetsAt is the first matching time after retrieval in the reported time zone.");
	}
	return {
		schemaVersion: 1,
		status: "ok",
		source: SOURCE,
		timeZone: options.timeZone,
		fetchedAt: new Date(snapshot.fetchedAtMs).toISOString(),
		fetchedAtLocal: formatLocal(snapshot.fetchedAtMs, options.timeZone),
		windows,
		caveats,
	};
}

export function describeClaudeQuotaError(error: unknown, home = homedir()): ClaudeQuotaError {
	const raw = error instanceof Error ? error.message : String(error);
	const kind = error instanceof ClaudeQuotaLookupError ? error.kind : "lookup-failed";
	const described: ClaudeQuotaError = { kind, message: sanitizeMessage(raw, home) };
	if (kind === "lookup-failed" && /not (?:logged|signed) in|\/login\b|\bunauthori[sz]ed\b|\bunauthenticated\b|\b40[13]\b/i.test(raw)) {
		described.hint = "This may mean Claude Code is not signed in; check with `claude auth status`.";
	}
	return described;
}

export interface RunDependencies {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	fetch?: (options: { timeoutMs: number }) => Promise<ClaudeUsageSnapshot>;
	nowMs?: () => number;
	timeZone?: string;
	home?: string;
}

export async function runClaudeQuota(argv: string[], deps: RunDependencies): Promise<number> {
	const args = parseQuotaArgs(argv);
	if ("error" in args) {
		deps.stderr(`claude-quota: ${args.error}\n${USAGE}`);
		return 2;
	}
	if ("help" in args) {
		deps.stdout(USAGE);
		return 0;
	}
	const fetch = deps.fetch ?? fetchClaudeUsageSnapshot;
	let snapshot: ClaudeUsageSnapshot;
	try {
		snapshot = await fetch({ timeoutMs: args.timeoutMs });
	} catch (error) {
		const failure: ClaudeQuotaFailure = {
			schemaVersion: 1,
			status: "error",
			source: SOURCE,
			error: describeClaudeQuotaError(error, deps.home ?? homedir()),
			caveats: [...SOURCE_CAVEATS],
		};
		deps.stdout(`${JSON.stringify(failure, null, 2)}\n`);
		return 1;
	}
	const report = buildClaudeQuotaReport(snapshot, {
		nowMs: deps.nowMs?.() ?? Date.now(),
		timeZone: deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
	});
	deps.stdout(`${JSON.stringify(report, null, 2)}\n`);
	return 0;
}
