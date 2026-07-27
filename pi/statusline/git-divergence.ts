import { execFile } from "node:child_process";

export interface GitDivergence {
	ahead: number;
	behind: number;
}

export interface FetchGitDivergenceOptions {
	command?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface GitDivergenceCacheOptions {
	load: (branch: string, signal: AbortSignal) => Promise<GitDivergence>;
	ttlMs: number;
	onChange?: () => void;
}

export function formatGitDivergence(divergence: GitDivergence | undefined): string {
	if (!divergence) return "";
	return [divergence.ahead > 0 ? `⇡${divergence.ahead}` : "", divergence.behind > 0 ? `⇣${divergence.behind}` : ""]
		.filter(Boolean)
		.join(" ");
}

export function fetchGitDivergence(
	cwd: string,
	branch: string,
	options: FetchGitDivergenceOptions = {},
): Promise<GitDivergence> {
	return new Promise((resolve, reject) => {
		execFile(
			options.command ?? "git",
			["-C", cwd, "rev-list", "--left-right", "--count", `${branch}@{upstream}...${branch}`],
			{
				encoding: "utf8",
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
	readonly #ttlMs: number;
	readonly #onChange: (() => void) | undefined;

	constructor(options: GitDivergenceCacheOptions) {
		this.#load = options.load;
		this.#ttlMs = options.ttlMs;
		this.#onChange = options.onChange;
	}

	divergenceFor(branch: string | null): GitDivergence | undefined {
		return branch && this.#snapshot?.branch === branch ? this.#snapshot.divergence : undefined;
	}

	async refresh(branch: string | null, nowMs = Date.now()): Promise<void> {
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
			if (!this.#disposed && this.#controller === controller) this.#snapshot = { branch, divergence: undefined };
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
