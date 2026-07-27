import { execFile } from "node:child_process";

export interface FetchGitBehindOptions {
	command?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface GitBehindCacheOptions {
	load: (branch: string, signal: AbortSignal) => Promise<number>;
	ttlMs: number;
	onChange?: () => void;
}

export function formatGitBehind(count: number | undefined): string {
	return count && count > 0 ? `⇣${count}` : "";
}

export function fetchGitBehind(cwd: string, branch: string, options: FetchGitBehindOptions = {}): Promise<number> {
	return new Promise((resolve, reject) => {
		execFile(
			options.command ?? "git",
			["-C", cwd, "rev-list", "--count", `${branch}..${branch}@{upstream}`],
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
				const output = stdout.trim();
				if (!/^\d+$/.test(output)) {
					reject(new Error("Invalid git behind count"));
					return;
				}
				const count = Number(output);
				if (!Number.isSafeInteger(count)) reject(new Error("Invalid git behind count"));
				else resolve(count);
			},
		);
	});
}

export class GitBehindCache {
	#snapshot: { branch: string; count: number | undefined } | undefined;
	#nextRefreshAt = 0;
	#refreshing = false;
	#disposed = false;
	#controller: AbortController | undefined;
	readonly #load: GitBehindCacheOptions["load"];
	readonly #ttlMs: number;
	readonly #onChange: (() => void) | undefined;

	constructor(options: GitBehindCacheOptions) {
		this.#load = options.load;
		this.#ttlMs = options.ttlMs;
		this.#onChange = options.onChange;
	}

	countFor(branch: string | null): number | undefined {
		return branch && this.#snapshot?.branch === branch ? this.#snapshot.count : undefined;
	}

	async refresh(branch: string | null, nowMs = Date.now()): Promise<void> {
		if (this.#disposed || !branch || this.#refreshing) return;
		if (this.#snapshot?.branch === branch && nowMs < this.#nextRefreshAt) return;
		this.#refreshing = true;
		this.#nextRefreshAt = nowMs + this.#ttlMs;
		const controller = new AbortController();
		this.#controller = controller;
		try {
			const count = await this.#load(branch, controller.signal);
			if (!this.#disposed && this.#controller === controller) this.#snapshot = { branch, count };
		} catch {
			if (!this.#disposed && this.#controller === controller) this.#snapshot = { branch, count: undefined };
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
