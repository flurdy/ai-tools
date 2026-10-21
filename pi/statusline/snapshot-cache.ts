export interface SnapshotCacheOptions<T> {
	load: (signal: AbortSignal) => Promise<T>;
	/** Interval between successful lookups. */
	refreshMs: number;
	/** Upper bound for the doubling delay after consecutive failures. */
	maxBackoffMs: number;
	/** Failures that make further lookups pointless or unsafe until the footer is recreated. */
	isPermanentFailure?: (error: unknown) => boolean;
	onChange?: () => void;
	now?: () => number;
}

/**
 * Last-good snapshot with one in-flight lookup, a refresh interval and failure backoff.
 * It owns no timers: callers poll `refreshIfDue()`, so rendering never starts a lookup.
 */
export class SnapshotCache<T> {
	private current: T | undefined;
	private lastFailed = false;
	private permanentlyFailed = false;
	private failures = 0;
	private nextAttemptMs = 0;
	private inFlight: Promise<void> | undefined;
	private controller: AbortController | undefined;
	private disposed = false;
	private readonly options: SnapshotCacheOptions<T>;

	constructor(options: SnapshotCacheOptions<T>) {
		this.options = options;
	}

	get value(): T | undefined {
		return this.current;
	}

	/** The most recent lookup failed; any value is from an earlier success. */
	get failed(): boolean {
		return this.lastFailed;
	}

	get stopped(): boolean {
		return this.permanentlyFailed;
	}

	refreshIfDue(): Promise<void> {
		if (this.inFlight) return this.inFlight;
		if (this.disposed || this.permanentlyFailed || this.now() < this.nextAttemptMs) return Promise.resolve();
		const controller = new AbortController();
		this.controller = controller;
		this.inFlight = this.attempt(controller.signal).finally(() => {
			this.inFlight = undefined;
			if (this.controller === controller) this.controller = undefined;
		});
		return this.inFlight;
	}

	dispose(): void {
		this.disposed = true;
		this.controller?.abort();
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	private async attempt(signal: AbortSignal): Promise<void> {
		try {
			const value = await this.options.load(signal);
			if (this.disposed) return;
			this.current = value;
			this.lastFailed = false;
			this.failures = 0;
			this.nextAttemptMs = this.now() + this.options.refreshMs;
		} catch (error) {
			if (this.disposed) return;
			this.lastFailed = true;
			this.failures++;
			this.permanentlyFailed = this.options.isPermanentFailure?.(error) ?? false;
			const backoff = this.options.refreshMs * 2 ** (this.failures - 1);
			this.nextAttemptMs = this.now() + Math.min(backoff, this.options.maxBackoffMs);
		}
		this.options.onChange?.();
	}
}
