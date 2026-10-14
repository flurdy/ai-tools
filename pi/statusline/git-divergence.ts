import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { isProjectWorkspaceRoot, runCountCommand } from "./count-query.ts";

interface RepositoryDivergence {
	ahead: number;
	behind: number;
}

interface WorkspaceDivergence {
	repositories: RepositoryDivergence[];
	unavailableSources: number | null;
}

export type GitDivergence = RepositoryDivergence | WorkspaceDivergence;

export function findGitWorkspaceRoot(cwd: string): string | undefined {
	try {
		const root = realpathSync(cwd);
		return isProjectWorkspaceRoot(root) ? root : undefined;
	} catch {
		return undefined;
	}
}

function parseWorkspaceDivergence(stdout: string): WorkspaceDivergence {
	const payload = JSON.parse(stdout);
	const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
	if (
		!payload || payload.version !== 1 || !Array.isArray(payload.repositories) ||
		!count(payload.successfulSources) || !count(payload.unavailableSources) ||
		payload.successfulSources + payload.unavailableSources === 0 ||
		payload.repositories.length !== payload.successfulSources ||
		!Array.isArray(payload.diagnostics) || payload.diagnostics.length !== payload.unavailableSources ||
		payload.diagnostics.some((value: unknown) => typeof value !== "string") ||
		payload.repositories.some((row: { repository?: unknown; path?: unknown; ahead?: unknown; behind?: unknown } | null) =>
			!row || typeof row.repository !== "string" || typeof row.path !== "string" || !count(row.ahead) || !count(row.behind))
	) throw new Error("Invalid project-workspace Git counts");
	return {
		repositories: payload.repositories.map(({ ahead, behind }: RepositoryDivergence) => ({ ahead, behind })),
		unavailableSources: payload.unavailableSources,
	};
}

export interface FetchGitDivergenceOptions {
	command?: string;
	workspaceCommand?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface GitDivergenceCacheOptions {
	load: (branch: string, signal: AbortSignal) => Promise<GitDivergence>;
	workspace?: boolean;
	ttlMs: number;
	onChange?: () => void;
}

export function formatGitDivergence(divergence: GitDivergence | undefined): string {
	if (!divergence) return "";
	if ("repositories" in divergence) {
		const parts = divergence.repositories.map(formatGitDivergence).filter(Boolean);
		if (divergence.repositories.length === 0) parts.push("?");
		if (divergence.unavailableSources === null) parts.push("⚠");
		else if (divergence.unavailableSources > 0) parts.push(`⚠${divergence.unavailableSources}`);
		return parts.join(" ");
	}
	return [divergence.ahead > 0 ? `⇡${divergence.ahead}` : "", divergence.behind > 0 ? `⇣${divergence.behind}` : ""]
		.filter(Boolean)
		.join(" ");
}

export async function fetchGitDivergence(
	cwd: string,
	branch: string,
	options: FetchGitDivergenceOptions = {},
): Promise<GitDivergence> {
	const workspaceRoot = findGitWorkspaceRoot(cwd);
	if (workspaceRoot) {
		const timeoutMs = options.timeoutMs ?? 2000;
		const stdout = await runCountCommand(
			options.workspaceCommand ?? "project-workspace",
			workspaceRoot,
			["git-counts", "--workspace", workspaceRoot, "--timeout", String(Math.max(0.05, (timeoutMs - 100) / 1000))],
			{ ...options, timeoutMs },
			"Git count query",
		);
		return parseWorkspaceDivergence(stdout);
	}
	return new Promise((resolve, reject) => {
		execFile(
			options.command ?? "git",
			["-C", cwd, "rev-list", "--left-right", "--count", `${branch}@{upstream}...${branch}`],
			{
				encoding: "utf8",
				env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
				timeout: options.timeoutMs ?? 500,
				windowsHide: true,
				signal: options.signal,
			},
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				const [behindText, aheadText, ...extra] = stdout.trim().split(/\s+/);
				if (extra.length > 0 || !/^\d+$/.test(behindText ?? "") || !/^\d+$/.test(aheadText ?? "")) {
					reject(new Error("Invalid git divergence counts"));
					return;
				}
				const behind = Number(behindText);
				const ahead = Number(aheadText);
				if (!Number.isSafeInteger(behind) || !Number.isSafeInteger(ahead)) reject(new Error("Invalid git divergence counts"));
				else resolve({ ahead, behind });
			},
		);
	});
}

export class GitDivergenceCache {
	#snapshot: { branch: string; divergence: GitDivergence | undefined } | undefined;
	#nextRefreshAt = 0;
	#refreshing = false;
	#disposed = false;
	#controller: AbortController | undefined;
	readonly #load: GitDivergenceCacheOptions["load"];
	readonly #workspace: boolean;
	readonly #ttlMs: number;
	readonly #onChange: (() => void) | undefined;

	constructor(options: GitDivergenceCacheOptions) {
		this.#load = options.load;
		this.#workspace = options.workspace ?? false;
		this.#ttlMs = options.ttlMs;
		this.#onChange = options.onChange;
	}

	divergenceFor(branch: string | null): GitDivergence | undefined {
		const key = this.#workspace ? "workspace" : branch;
		return key && this.#snapshot?.branch === key ? this.#snapshot.divergence : undefined;
	}

	async refresh(branch: string | null, nowMs = Date.now()): Promise<void> {
		if (this.#workspace) branch = "workspace";
		if (this.#disposed || !branch || this.#refreshing) return;
		if (this.#snapshot?.branch === branch && nowMs < this.#nextRefreshAt) return;
		this.#refreshing = true;
		this.#nextRefreshAt = nowMs + this.#ttlMs;
		const controller = new AbortController();
		this.#controller = controller;
		try {
			const divergence = await this.#load(branch, controller.signal);
			if (!this.#disposed && this.#controller === controller) this.#snapshot = { branch, divergence };
		} catch {
			if (!this.#disposed && this.#controller === controller) {
				this.#snapshot = { branch, divergence: this.#workspace ? { repositories: [], unavailableSources: null } : undefined };
			}
		} finally {
			if (this.#controller === controller) this.#controller = undefined;
			this.#refreshing = false;
			if (!this.#disposed) this.#onChange?.();
		}
	}

	dispose(): void {
		this.#disposed = true;
		this.#snapshot = undefined;
		this.#controller?.abort();
		this.#controller = undefined;
	}
}
