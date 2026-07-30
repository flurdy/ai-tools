import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export type OpenByPriority = [number, number, number, number, number];

export interface BeadsCounts {
	openByPriority: OpenByPriority;
	inProgress: number;
	blocked: number;
}

export interface FetchBeadsCountsOptions {
	command?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface BeadsCountsCacheOptions {
	load: (signal: AbortSignal) => Promise<BeadsCounts>;
	ttlMs: number;
	onChange?: () => void;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function findBeadsRoot(cwd: string): string | undefined {
	let directory = cwd;
	while (true) {
		if (existsSync(`${directory}/.beads`)) return directory;
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

export function parseBeadsCounts(issuesStdout: string, blockedStdout: string): BeadsCounts | undefined {
	try {
		const issues = JSON.parse(issuesStdout) as unknown;
		const blockedIssues = JSON.parse(blockedStdout) as unknown;
		if (!Array.isArray(issues) || !Array.isArray(blockedIssues)) return undefined;

		const openByPriority: OpenByPriority = [0, 0, 0, 0, 0];
		let inProgress = 0;
		for (const value of issues) {
			const issue = asObject(value);
			if (!issue || typeof issue.status !== "string") return undefined;
			if (issue.status === "in_progress") {
				inProgress += 1;
				continue;
			}
			if (issue.status !== "open") continue;
			const priority = count(issue.priority);
			if (priority === undefined || priority > 4) return undefined;
			openByPriority[priority] += 1;
		}

		return { openByPriority, inProgress, blocked: blockedIssues.length };
	} catch {
		return undefined;
	}
}

export function formatBeadsCounts(counts: BeadsCounts | undefined): string {
	if (!counts) return "";
	const priorities = counts.openByPriority.flatMap((value, priority) => (value > 0 ? [`P${priority}:${value}`] : []));
	const parts = ["◉", ...(priorities.length > 0 ? priorities : ["0"])];
	if (counts.inProgress > 0) parts.push(`◐${counts.inProgress}`);
	if (counts.blocked > 0) parts.push(`⛔${counts.blocked}`);
	return parts.join(" ");
}

function runBd(root: string, args: string[], options: FetchBeadsCountsOptions): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			options.command ?? "bd",
			args,
			{
				cwd: root,
				encoding: "utf8",
				timeout: options.timeoutMs ?? 2000,
				windowsHide: true,
				signal: options.signal,
			},
			(error, stdout) => {
				if (error) reject(error);
				else resolve(stdout);
			},
		);
	});
}

export async function fetchBeadsCounts(root: string, options: FetchBeadsCountsOptions = {}): Promise<BeadsCounts> {
	const [issuesStdout, blockedStdout] = await Promise.all([
		runBd(root, ["list", "--json", "--limit", "0", "--readonly"], options),
		runBd(root, ["blocked", "--json", "--readonly"], options),
	]);
	const counts = parseBeadsCounts(issuesStdout, blockedStdout);
	if (!counts) throw new Error("Invalid bd count response");
	return counts;
}

export class BeadsCountsCache {
	#counts: BeadsCounts | undefined;
	#nextRefreshAt = 0;
	#refreshing = false;
	#disposed = false;
	#controller: AbortController | undefined;
	readonly #load: BeadsCountsCacheOptions["load"];
	readonly #ttlMs: number;
	readonly #onChange: (() => void) | undefined;

	constructor(options: BeadsCountsCacheOptions) {
		this.#load = options.load;
		this.#ttlMs = options.ttlMs;
		this.#onChange = options.onChange;
	}

	get counts(): BeadsCounts | undefined {
		return this.#counts;
	}

	async refresh(nowMs = Date.now()): Promise<void> {
		if (this.#disposed || this.#refreshing || nowMs < this.#nextRefreshAt) return;
		this.#refreshing = true;
		this.#nextRefreshAt = nowMs + this.#ttlMs;
		const controller = new AbortController();
		this.#controller = controller;
		try {
			const counts = await this.#load(controller.signal);
			if (!this.#disposed && this.#controller === controller) this.#counts = counts;
		} catch {
			if (!this.#disposed && this.#controller === controller) this.#counts = undefined;
		} finally {
			if (this.#controller === controller) this.#controller = undefined;
			this.#refreshing = false;
			if (!this.#disposed) this.#onChange?.();
		}
	}

	dispose(): void {
		this.#disposed = true;
		this.#counts = undefined;
		this.#controller?.abort();
		this.#controller = undefined;
	}
}
