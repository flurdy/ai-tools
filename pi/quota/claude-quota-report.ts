import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { formatLocal, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, parseQuotaArgs, type ResetTiming, resetTiming, sanitizeMessage } from "./quota-common.ts";

const SOURCE = "claude-code-usage";
const MAX_OUTPUT_BYTES = 1024 * 1024;
const RESET_GRACE_MS = 60 * 60_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export const CLAUDE_USAGE_ARGS: readonly string[] = ["-p", "/usage", "--no-session-persistence", "--output-format", "json"];

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
	kind: "claude-cli-missing" | "timeout" | "lookup-failed" | "unexpected-response";
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

export class ClaudeQuotaLookupError extends Error {
	readonly kind: ClaudeQuotaError["kind"];

	constructor(kind: ClaudeQuotaError["kind"], message: string) {
		super(message);
		this.kind = kind;
	}
}

export interface ClaudeUsageSnapshot {
	panel: string;
	fetchedAtMs: number;
}

interface WallTime { year: number; month: number; day: number; hour: number; minute: number }

function zonedWallTime(ms: number, timeZone: string): WallTime & { second: number } {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "numeric",
		minute: "numeric",
		second: "numeric",
	}).formatToParts(new Date(ms));
	const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((candidate) => candidate.type === type)?.value);
	return { year: part("year"), month: part("month") - 1, day: part("day"), hour: part("hour"), minute: part("minute"), second: part("second") };
}

function zoneOffsetMs(ms: number, timeZone: string): number {
	const wall = zonedWallTime(ms, timeZone);
	return Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(ms / 1000) * 1000;
}

function wallTimeToUtc(wall: WallTime, timeZone: string): number {
	const asUtc = Date.UTC(wall.year, wall.month, wall.day, wall.hour, wall.minute);
	const first = asUtc - zoneOffsetMs(asUtc, timeZone);
	return asUtc - zoneOffsetMs(first, timeZone);
}

function isTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone });
		return true;
	} catch {
		return false;
	}
}

/** Resolves panel text such as "Oct 19, 3:19am" or "3am" to the first matching time after retrieval. */
function resolveReset(text: string, timeZone: string, fetchedAtMs: number): number | null {
	const match = /^(?:([A-Za-z]{3}) (\d{1,2}), )?(\d{1,2})(?::(\d{2}))? ?(am|pm)$/i.exec(text);
	if (!match) return null;
	const [, monthName, dayText, hourText, minuteText, meridiem] = match;
	const hour12 = Number(hourText);
	const minute = minuteText === undefined ? 0 : Number(minuteText);
	if (hour12 < 1 || hour12 > 12 || minute > 59) return null;
	const hour = (hour12 % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
	const today = zonedWallTime(fetchedAtMs, timeZone);
	const dates: Array<{ year: number; month: number; day: number }> = [];
	if (monthName === undefined) {
		for (const offset of [-1, 0, 1]) {
			const date = new Date(Date.UTC(today.year, today.month, today.day + offset));
			dates.push({ year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate() });
		}
	} else {
		const month = MONTHS.indexOf(monthName.toLowerCase());
		const day = Number(dayText);
		if (month < 0) return null;
		for (const year of [today.year - 1, today.year, today.year + 1]) {
			if (new Date(Date.UTC(year, month, day)).getUTCDate() === day) dates.push({ year, month, day });
		}
	}
	const candidates = dates
		.map((date) => wallTimeToUtc({ ...date, hour, minute }, timeZone))
		.filter((ms) => ms > fetchedAtMs - RESET_GRACE_MS)
		.sort((a, b) => a - b);
	return candidates[0] ?? null;
}

function parseWindow(label: string, body: string, fetchedAtMs: number, caveats: string[]): { window: Omit<UsageWindow, keyof ResetTiming>; resetsAtMs: number | null } {
	const [usedPart, resetPart, ...extra] = body.split(" · ");
	const used = /^(\d+(?:\.\d+)?)% used$/.exec(usedPart);
	if (!used) caveats.push(`The usage for "${label}" was not recognised; treat it as unknown, not zero.`);
	const window = { label, usedPercent: used ? Number(used[1]) : null, resetsAtText: null as string | null, resetsTimeZone: null as string | null };
	if (extra.length > 0) caveats.push(`Extra details for "${label}" were not recognised and are not reported.`);
	if (resetPart === undefined) {
		caveats.push(`The reset time for "${label}" was not reported; time until reset is unknown.`);
		return { window, resetsAtMs: null };
	}
	const reset = /^resets (.+?)(?: \(([^()]+)\))?$/.exec(resetPart);
	if (!reset) {
		caveats.push(`The reset time for "${label}" was not recognised; resetsAt is unknown.`);
		return { window, resetsAtMs: null };
	}
	window.resetsAtText = reset[1];
	window.resetsTimeZone = reset[2] ?? null;
	if (window.resetsTimeZone === null || !isTimeZone(window.resetsTimeZone)) {
		caveats.push(`The reset time zone for "${label}" was not reported or not recognised; resetsAt is unknown.`);
		return { window, resetsAtMs: null };
	}
	const resetsAtMs = resolveReset(window.resetsAtText, window.resetsTimeZone, fetchedAtMs);
	if (resetsAtMs === null) caveats.push(`The reset time for "${label}" was not recognised; resetsAt is unknown.`);
	return { window, resetsAtMs };
}

export function buildClaudeQuotaReport(snapshot: ClaudeUsageSnapshot, options: { nowMs: number; timeZone: string }): ClaudeQuotaReport {
	const home = homedir();
	const caveats = [...SOURCE_CAVEATS];
	const windows: UsageWindow[] = [];
	let unrecognised = 0;
	let resolvedResets = false;
	for (const rawLine of snapshot.panel.split("\n")) {
		const line = sanitizeMessage(rawLine, home);
		if (/^what['’]s contributing/i.test(line)) break;
		const limit = /^(Current [^:]{1,80}):\s*(.+)$/.exec(line);
		if (!limit) {
			if (/%|\bused\b|\bresets?\b|\blimit\b/i.test(line)) unrecognised++;
			continue;
		}
		const { window, resetsAtMs } = parseWindow(limit[1], limit[2], snapshot.fetchedAtMs, caveats);
		const timing = resetTiming(resetsAtMs, options);
		if (resetsAtMs !== null) resolvedResets = true;
		if (timing.resetPassed) {
			caveats.push(`The reported reset time for "${window.label}" has already passed, so this window is stale; refresh later rather than treating its percentage as current.`);
		}
		windows.push({ ...window, ...timing });
	}
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

function shown(value: unknown): string {
	return value === undefined ? "undefined" : JSON.stringify(value);
}

/** Accepts only Claude Code's successful local /usage result: no model turn, no cost. */
export function readUsageEnvelope(run: { code: number | null; stdout: string; stderr: string }): string {
	const exited = () => new ClaudeQuotaLookupError(
		"lookup-failed",
		`Claude Code exited with code ${run.code}${run.stderr.trim() ? `: ${run.stderr.trim()}` : ""}`,
	);
	let envelope: unknown;
	try {
		envelope = JSON.parse(run.stdout);
	} catch {
		envelope = undefined;
	}
	if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope) || (envelope as { type?: unknown }).type !== "result") {
		if (run.code !== 0) throw exited();
		throw new ClaudeQuotaLookupError("unexpected-response", "Claude Code did not print a JSON result envelope.");
	}
	const result = envelope as Record<string, unknown>;
	if (result.num_turns !== 0 || result.total_cost_usd !== 0) {
		throw new ClaudeQuotaLookupError(
			"unexpected-response",
			`Claude Code reported a model turn or cost (num_turns=${shown(result.num_turns)}, total_cost_usd=${shown(result.total_cost_usd)}); refusing to treat it as the local /usage panel.`,
		);
	}
	if (result.is_error !== false || result.subtype !== "success") {
		const detail = typeof result.result === "string" ? result.result : `subtype=${shown(result.subtype)}`;
		throw new ClaudeQuotaLookupError("lookup-failed", `Claude Code reported an error: ${detail}`);
	}
	if (result.local_command !== "usage") {
		throw new ClaudeQuotaLookupError(
			"unexpected-response",
			`Claude Code answered with local_command=${shown(result.local_command)}, not usage; refusing to parse it.`,
		);
	}
	if (typeof result.result !== "string") throw new ClaudeQuotaLookupError("unexpected-response", "Claude Code's usage result was not text.");
	if (run.code !== 0) throw exited();
	return result.result;
}

function runClaude(timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let failure: ClaudeQuotaLookupError | undefined;
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		const child = spawn("claude", CLAUDE_USAGE_ARGS, { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"], detached: true });
		const stop = (error: ClaudeQuotaLookupError) => {
			failure ??= error;
			if (child.pid === undefined) return;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// The process group already exited.
			}
		};
		const timer = setTimeout(() => stop(new ClaudeQuotaLookupError("timeout", `Claude usage query timed out after ${timeoutMs}ms`)), timeoutMs);
		const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
			outputBytes += chunk.length;
			if (outputBytes > MAX_OUTPUT_BYTES) {
				stop(new ClaudeQuotaLookupError("unexpected-response", "Claude Code printed more than 1 MiB; refusing to parse it."));
			} else {
				chunks.push(chunk);
			}
		};
		child.stdout.on("data", collect(stdout));
		child.stderr.on("data", collect(stderr));
		child.on("error", (error: NodeJS.ErrnoException) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error.code === "ENOENT"
				? new ClaudeQuotaLookupError("claude-cli-missing", "The Claude Code CLI (`claude`) was not found on PATH; install it and sign in before retrying.")
				: new ClaudeQuotaLookupError("lookup-failed", `Unable to start Claude Code: ${error.message}`));
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (failure) reject(failure);
			else resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
		});
	});
}

export async function fetchClaudeUsageSnapshot(options: { timeoutMs: number }): Promise<ClaudeUsageSnapshot> {
	const panel = readUsageEnvelope(await runClaude(options.timeoutMs));
	return { panel, fetchedAtMs: Date.now() };
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
