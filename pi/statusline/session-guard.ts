export const SESSION_GUARD_EMOJI = {
	acquiring: "⏳",
	implement: "✅",
	plan: "🔍",
	conflict: "⛔",
	lost: "💥",
	unguarded: "🚨",
} as const;

export type SessionGuardLabel = keyof typeof SESSION_GUARD_EMOJI;
export type LeaseOccupancyProbeResult = "held" | "free" | "unavailable";

const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function sessionGuardLabel(status: string): SessionGuardLabel | undefined {
	const label = status.replace(ANSI_SEQUENCE, "").trim();
	return Object.hasOwn(SESSION_GUARD_EMOJI, label) ? label as SessionGuardLabel : undefined;
}

export function formatSessionGuard(status: string, emojiEnabled = true): string {
	if (!emojiEnabled) return status;
	const label = sessionGuardLabel(status);
	return label ? SESSION_GUARD_EMOJI[label] : status;
}

export interface LeaseOccupancyCacheOptions {
	load(cwd: string, signal: AbortSignal): Promise<LeaseOccupancyProbeResult>;
	ttlMs: number;
	settleMs: number;
	onChange?: () => void;
}

export class LeaseOccupancyCache {
	#cwd: string | undefined;
	#occupied = false;
	#nextRefreshAt = 0;
	#refreshing = false;
	#disposed = false;
	#controller: AbortController | undefined;
	readonly #load: LeaseOccupancyCacheOptions["load"];
	readonly #ttlMs: number;
	readonly #settleMs: number;
	readonly #onChange: (() => void) | undefined;

	constructor(options: LeaseOccupancyCacheOptions) {
		this.#load = options.load;
		this.#ttlMs = options.ttlMs;
		this.#settleMs = options.settleMs;
		this.#onChange = options.onChange;
	}

	occupiedFor(cwd: string): boolean {
		return !this.#disposed && this.#cwd === cwd && this.#occupied;
	}

	async refresh(cwd: string | null, nowMs = Date.now()): Promise<void> {
		if (this.#disposed) return;
		if (!cwd) {
			this.#cwd = undefined;
			this.#occupied = false;
			this.#nextRefreshAt = 0;
			this.#controller?.abort();
			this.#controller = undefined;
			this.#refreshing = false;
			return;
		}
		if (this.#cwd !== cwd) {
			this.#cwd = cwd;
			this.#occupied = false;
			this.#nextRefreshAt = nowMs + this.#settleMs;
			if (this.#settleMs > 0) return;
		}
		if (this.#refreshing || nowMs < this.#nextRefreshAt) return;
		this.#refreshing = true;
		this.#nextRefreshAt = nowMs + this.#ttlMs;
		const controller = new AbortController();
		this.#controller = controller;
		try {
			const result = await this.#load(cwd, controller.signal);
			if (!this.#disposed && this.#controller === controller && this.#cwd === cwd) this.#occupied = result === "held";
		} catch {
			if (!this.#disposed && this.#controller === controller && this.#cwd === cwd) this.#occupied = false;
		} finally {
			if (this.#controller === controller) {
				this.#controller = undefined;
				this.#refreshing = false;
			}
			if (!this.#disposed) this.#onChange?.();
		}
	}

	dispose(): void {
		this.#disposed = true;
		this.#cwd = undefined;
		this.#occupied = false;
		this.#controller?.abort();
		this.#controller = undefined;
	}
}
