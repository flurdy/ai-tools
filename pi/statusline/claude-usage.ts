/**
 * Claude Code's local `/usage` panel: one read-only lookup plus its parser.
 * Shared by the statusline footer and the `claude-quota` helper.
 */

import { spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { identityDigest } from "./shared-snapshot.ts";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const RESET_GRACE_MS = 60 * 60_000;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const SESSION_LABEL = "Current session";
const WEEK_LABEL = "Current week (all models)";

export const CLAUDE_USAGE_ARGS: readonly string[] = ["-p", "/usage", "--no-session-persistence", "--output-format", "json"];

export type ClaudeUsageErrorKind = "claude-cli-missing" | "timeout" | "lookup-failed" | "unexpected-response";

export class ClaudeQuotaLookupError extends Error {
	readonly kind: ClaudeUsageErrorKind;

	constructor(kind: ClaudeUsageErrorKind, message: string) {
		super(message);
		this.kind = kind;
	}
}

export interface ClaudeUsageSnapshot {
	panel: string;
	fetchedAtMs: number;
}

export interface ParsedUsageWindow {
	label: string;
	/** Reported usage; null when unrecognised, which is not zero. */
	usedPercent: number | null;
	resetsAtText: string | null;
	resetsTimeZone: string | null;
	resetsAtMs: number | null;
	/** Parser caveats about this window, in the order they were found. */
	caveats: string[];
}

export interface ParsedUsagePanel {
	windows: ParsedUsageWindow[];
	unrecognisedLines: number;
}

export interface ClaudeAccountWindow {
	usedPercent: number | null;
	resetsAtMs: number | null;
}

/** The two account-wide windows the footer shows; an absent window is unknown. */
export interface ClaudeAccountUsage {
	session: ClaudeAccountWindow | undefined;
	week: ClaudeAccountWindow | undefined;
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

function parseWindow(label: string, body: string, fetchedAtMs: number): ParsedUsageWindow {
	const caveats: string[] = [];
	const [usedPart, resetPart, ...extra] = body.split(" · ");
	const used = /^(\d+(?:\.\d+)?)% used$/.exec(usedPart);
	if (!used) caveats.push(`The usage for "${label}" was not recognised; treat it as unknown, not zero.`);
	const window: ParsedUsageWindow = {
		label,
		usedPercent: used ? Number(used[1]) : null,
		resetsAtText: null,
		resetsTimeZone: null,
		resetsAtMs: null,
		caveats,
	};
	if (extra.length > 0) caveats.push(`Extra details for "${label}" were not recognised and are not reported.`);
	if (resetPart === undefined) {
		caveats.push(`The reset time for "${label}" was not reported; time until reset is unknown.`);
		return window;
	}
	const reset = /^resets (.+?)(?: \(([^()]+)\))?$/.exec(resetPart);
	if (!reset) {
		caveats.push(`The reset time for "${label}" was not recognised; resetsAt is unknown.`);
		return window;
	}
	window.resetsAtText = reset[1];
	window.resetsTimeZone = reset[2] ?? null;
	if (window.resetsTimeZone === null || !isTimeZone(window.resetsTimeZone)) {
		caveats.push(`The reset time zone for "${label}" was not reported or not recognised; resetsAt is unknown.`);
		return window;
	}
	window.resetsAtMs = resolveReset(window.resetsAtText, window.resetsTimeZone, fetchedAtMs);
	if (window.resetsAtMs === null) caveats.push(`The reset time for "${label}" was not recognised; resetsAt is unknown.`);
	return window;
}

function normalizeLine(line: string): string {
	return line
		.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Parses every `Current …: N% used · resets <time> (<zone>)` line before the contributing section. */
export function parseClaudeUsagePanel(snapshot: ClaudeUsageSnapshot, cleanLine: (line: string) => string = normalizeLine): ParsedUsagePanel {
	const windows: ParsedUsageWindow[] = [];
	let unrecognisedLines = 0;
	for (const rawLine of snapshot.panel.split("\n")) {
		const line = cleanLine(rawLine);
		if (/^what['’]s contributing/i.test(line)) break;
		const limit = /^(Current [^:]{1,80}):\s*(.+)$/.exec(line);
		if (!limit) {
			if (/%|\bused\b|\bresets?\b|\blimit\b/i.test(line)) unrecognisedLines++;
			continue;
		}
		windows.push(parseWindow(limit[1], limit[2], snapshot.fetchedAtMs));
	}
	return { windows, unrecognisedLines };
}

/** Environment variables that route Claude Code elsewhere than its claude.ai login. */
export const CLAUDE_AUTH_OVERRIDES: readonly string[] = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
];

/** Non-identifying digest of the Claude Code login a `/usage` lookup would describe. */
export function claudeUsageIdentity(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const configDirectory = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
	return identityDigest({
		source: "claude",
		configDirectory,
		credentialFile: join(configDirectory, ".credentials.json"),
		executable: "claude",
		overrides: CLAUDE_AUTH_OVERRIDES,
		env,
	});
}

function parseWindowValue(value: unknown): ClaudeAccountWindow | undefined | null {
	if (value === undefined) return undefined;
	const window = value as Partial<ClaudeAccountWindow> | null;
	if (window === null || typeof window !== "object") return null;
	const percent = window.usedPercent;
	const resets = window.resetsAtMs;
	const valid = (percent === null || (typeof percent === "number" && Number.isFinite(percent)))
		&& (resets === null || (typeof resets === "number" && Number.isFinite(resets)));
	return valid ? { usedPercent: percent as number | null, resetsAtMs: resets as number | null } : null;
}

/** Validates a persisted account usage snapshot; undefined when its shape is not ours. */
export function parseClaudeAccountUsage(value: unknown): ClaudeAccountUsage | undefined {
	const usage = value as Partial<ClaudeAccountUsage> | null;
	if (usage === null || typeof usage !== "object" || typeof usage.fetchedAtMs !== "number" || !Number.isFinite(usage.fetchedAtMs)) return undefined;
	const session = parseWindowValue(usage.session);
	const week = parseWindowValue(usage.week);
	if (session === null || week === null) return undefined;
	return { session, week, fetchedAtMs: usage.fetchedAtMs };
}

export function claudeAccountUsage(snapshot: ClaudeUsageSnapshot): ClaudeAccountUsage {
	const { windows } = parseClaudeUsagePanel(snapshot);
	const pick = (label: string): ClaudeAccountWindow | undefined => {
		const window = windows.find((candidate) => candidate.label === label);
		return window && { usedPercent: window.usedPercent, resetsAtMs: window.resetsAtMs };
	};
	return { session: pick(SESSION_LABEL), week: pick(WEEK_LABEL), fetchedAtMs: snapshot.fetchedAtMs };
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

const aborted = () => new ClaudeQuotaLookupError("lookup-failed", "Claude usage query aborted");

function runClaude(timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(aborted());
			return;
		}
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
		const onAbort = () => stop(aborted());
		const timer = setTimeout(() => stop(new ClaudeQuotaLookupError("timeout", `Claude usage query timed out after ${timeoutMs}ms`)), timeoutMs);
		const finish = () => {
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
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
			finish();
			reject(error.code === "ENOENT"
				? new ClaudeQuotaLookupError("claude-cli-missing", "The Claude Code CLI (`claude`) was not found on PATH; install it and sign in before retrying.")
				: new ClaudeQuotaLookupError("lookup-failed", `Unable to start Claude Code: ${error.message}`));
		});
		child.on("close", (code) => {
			if (settled) return;
			finish();
			if (failure) reject(failure);
			else resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
		});
	});
}

export async function fetchClaudeUsageSnapshot(options: { timeoutMs: number; signal?: AbortSignal }): Promise<ClaudeUsageSnapshot> {
	const panel = readUsageEnvelope(await runClaude(options.timeoutMs, options.signal));
	return { panel, fetchedAtMs: Date.now() };
}
