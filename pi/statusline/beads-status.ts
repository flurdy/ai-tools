import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type OpenByPriority = [number, number, number, number, number];

export interface BeadsCounts {
	openByPriority: OpenByPriority;
	inProgress: number;
	blocked: number;
	successfulSources: number;
	unavailableSources: number;
}

export interface FetchBeadsCountsOptions {
	command?: string;
	workspaceCommand?: string;
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

function isProjectWorkspaceRoot(root: string): boolean {
	return [".git", ".beads", "workspace.json", "README.md", "AGENTS.md", "Makefile", "repos", "infrastructure"].every((path) =>
		existsSync(join(root, path)),
	);
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

		return {
			openByPriority,
			inProgress,
			blocked: blockedIssues.length,
			successfulSources: 1,
			unavailableSources: 0,
		};
	} catch {
		return undefined;
	}
}

export function formatBeadsCounts(counts: BeadsCounts | undefined): string {
	if (!counts) return "";
	const priorities = counts.openByPriority.flatMap((value, priority) => (value > 0 ? [`P${priority}:${value}`] : []));
	const summary = counts.successfulSources === 0 ? ["?"] : priorities.length > 0 ? priorities : ["0"];
	const parts = ["◉", ...summary];
	if (counts.inProgress > 0) parts.push(`◐${counts.inProgress}`);
	if (counts.blocked > 0) parts.push(`⛔${counts.blocked}`);
	if (counts.unavailableSources > 0) parts.push(`⚠ ${counts.unavailableSources}`);
	return parts.join(" ");
}

function runCommand(command: string, root: string, args: string[], options: FetchBeadsCountsOptions): Promise<string> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("Beads count query aborted"));
			return;
		}

		const timeoutMs = options.timeoutMs ?? 2000;
		let settled = false;
		let terminatingError: Error | undefined;
		let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const processGroup = process.platform !== "win32";
		const child = spawn(command, args, {
			cwd: root,
			windowsHide: true,
			detached: processGroup,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stdoutBytes = 0;
		function settle(error?: Error, stdout?: string) {
			if (settled) return;
			settled = true;
			// A collector can exit before its descendants, including with closed pipes.
			kill("SIGKILL");
			if (timeout) clearTimeout(timeout);
			if (forceKillTimeout) clearTimeout(forceKillTimeout);
			options.signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve(stdout ?? "");
		}
		function kill(signal: NodeJS.Signals) {
			if (child.pid === undefined) return;
			try {
				if (processGroup) process.kill(-child.pid, signal);
				else if (child.exitCode === null) child.kill(signal);
			} catch {}
		}
		function terminate(error: Error) {
			if (terminatingError) return;
			terminatingError = error;
			kill("SIGTERM");
			forceKillTimeout = setTimeout(() => {
				kill("SIGKILL");
				child.stdout?.destroy();
				child.stderr?.destroy();
			}, 100);
		}
		function onAbort() {
			terminate(new Error("Beads count query aborted"));
		}
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (terminatingError) return;
			stdoutBytes += Buffer.byteLength(chunk);
			if (stdoutBytes > 1024 * 1024) terminate(new Error("Beads count query exceeded output limit"));
			else stdout += chunk;
		});
		child.stderr.resume();
		child.on("error", (error) => settle(terminatingError ?? error));
		child.on("close", (code, signal) => settle(
			terminatingError ?? (code === 0 ? undefined : new Error(`Beads count query failed (${signal ?? code})`)),
			stdout,
		));
		timeout = setTimeout(() => terminate(new Error(`Beads count query timed out after ${timeoutMs}ms`)), timeoutMs);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
	});
}

function parseWorkspaceBeadsCounts(stdout: string): BeadsCounts | undefined {
	try {
		const payload = asObject(JSON.parse(stdout) as unknown);
		if (!payload || payload.version !== 1 || !Array.isArray(payload.openByPriority) || payload.openByPriority.length !== 5) return undefined;
		const priorities = payload.openByPriority.map(count);
		const inProgress = count(payload.inProgress);
		const blocked = count(payload.blocked);
		const successfulSources = count(payload.successfulSources);
		const unavailableSources = count(payload.unavailableSources);
		if (
			priorities.some((value) => value === undefined) ||
			inProgress === undefined ||
			blocked === undefined ||
			successfulSources === undefined ||
			unavailableSources === undefined ||
			successfulSources + unavailableSources === 0 ||
			!Array.isArray(payload.diagnostics) ||
			payload.diagnostics.length !== unavailableSources ||
			payload.diagnostics.some((value) => typeof value !== "string")
		) return undefined;
		return {
			openByPriority: priorities as OpenByPriority,
			inProgress,
			blocked,
			successfulSources,
			unavailableSources,
		};
	} catch {
		return undefined;
	}
}

export async function fetchBeadsCounts(root: string, options: FetchBeadsCountsOptions = {}): Promise<BeadsCounts> {
	if (isProjectWorkspaceRoot(root)) {
		const timeoutMs = options.timeoutMs ?? 2000;
		const sourceTimeoutSeconds = Math.max(0.05, (timeoutMs - 100) / 1000);
		const stdout = await runCommand(
			options.workspaceCommand ?? "project-workspace",
			root,
			["beads-counts", "--workspace", root, "--timeout", String(sourceTimeoutSeconds)],
			options,
		);
		const counts = parseWorkspaceBeadsCounts(stdout);
		if (!counts) throw new Error("Invalid project-workspace count response");
		return counts;
	}

	const timeoutMs = options.timeoutMs ?? 2000;
	const deadline = performance.now() + timeoutMs;
	const run = (args: string[]) => {
		const remaining = deadline - performance.now();
		if (remaining <= 0) throw new Error(`Beads count query timed out after ${timeoutMs}ms`);
		return runCommand(options.command ?? "bd", root, args, { ...options, timeoutMs: Math.ceil(remaining) });
	};
	const issuesStdout = await run(["list", "--json", "--limit", "0", "--readonly"]);
	const blockedStdout = await run(["blocked", "--json", "--readonly"]);
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
