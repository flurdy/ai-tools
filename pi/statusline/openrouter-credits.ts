export interface OpenRouterCredits {
	totalCredits: number;
	totalUsage: number;
	remainingCredits: number;
	fetchedAtMs: number;
}

export type OpenRouterCreditsErrorKind = "authorization" | "invalid-response" | "transient";

export class OpenRouterCreditsError extends Error {
	constructor(
		message: string,
		readonly kind: OpenRouterCreditsErrorKind,
	) {
		super(message);
		this.name = "OpenRouterCreditsError";
	}
}

export interface FetchOpenRouterCreditsOptions {
	apiKey: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	fetchedAtMs?: number;
}

export interface CreateOpenRouterCreditsCacheOptions {
	apiKey?: string;
	timeoutMs?: number;
	staleAfterMs?: number;
	fetchImpl?: typeof fetch;
	onChange?: () => void;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function openRouterCreditsApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.PI_STATUSLINE_OPENROUTER_CREDITS === "0") return undefined;
	return env.PI_STATUSLINE_OPENROUTER_MANAGEMENT_KEY?.trim() || undefined;
}

export function isOpenRouterCreditsStale(credits: OpenRouterCredits, nowMs: number, staleAfterMs: number): boolean {
	return nowMs - credits.fetchedAtMs > staleAfterMs;
}

export async function fetchOpenRouterCredits(options: FetchOpenRouterCreditsOptions): Promise<OpenRouterCredits> {
	if (options.signal?.aborted) throw new OpenRouterCreditsError("OpenRouter credits query aborted", "transient");

	const timeoutMs = options.timeoutMs ?? 5000;
	const controller = new AbortController();
	let timedOut = false;
	const onAbort = () => controller.abort();
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	options.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		let response: Response;
		try {
			response = await (options.fetchImpl ?? fetch)("https://openrouter.ai/api/v1/credits", {
				headers: { Authorization: `Bearer ${options.apiKey}` },
				signal: controller.signal,
			});
		} catch {
			if (timedOut) throw new OpenRouterCreditsError(`OpenRouter credits query timed out after ${timeoutMs}ms`, "transient");
			if (options.signal?.aborted) throw new OpenRouterCreditsError("OpenRouter credits query aborted", "transient");
			throw new OpenRouterCreditsError("OpenRouter credits query failed", "transient");
		}

		if (response.status === 401 || response.status === 403) {
			throw new OpenRouterCreditsError(`OpenRouter credits query failed with HTTP ${response.status}`, "authorization");
		}
		if (!response.ok) throw new OpenRouterCreditsError(`OpenRouter credits query failed with HTTP ${response.status}`, "transient");

		let body: unknown;
		try {
			body = await response.json();
		} catch {
			if (timedOut) throw new OpenRouterCreditsError(`OpenRouter credits query timed out after ${timeoutMs}ms`, "transient");
			if (options.signal?.aborted) throw new OpenRouterCreditsError("OpenRouter credits query aborted", "transient");
			throw new OpenRouterCreditsError("OpenRouter credits response was not valid JSON", "invalid-response");
		}
		const data = asObject(asObject(body)?.data);
		const totalCredits = nonNegativeNumber(data?.total_credits);
		const totalUsage = nonNegativeNumber(data?.total_usage);
		if (totalCredits === undefined || totalUsage === undefined) {
			throw new OpenRouterCreditsError("OpenRouter credits response did not include valid totals", "invalid-response");
		}
		return {
			totalCredits,
			totalUsage,
			remainingCredits: totalCredits - totalUsage,
			fetchedAtMs: options.fetchedAtMs ?? Date.now(),
		};
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

export class OpenRouterCreditsCache {
	private current: OpenRouterCredits | undefined;
	private failedTransiently = false;
	private refreshing = false;
	private disposed = false;
	private controller: AbortController | undefined;

	constructor(
		private readonly load: (signal: AbortSignal) => Promise<OpenRouterCredits>,
		private readonly staleAfterMs: number,
		private readonly onChange?: () => void,
	) {}

	get credits(): OpenRouterCredits | undefined {
		return this.current;
	}

	isStale(nowMs = Date.now()): boolean {
		return Boolean(this.current && (this.failedTransiently || isOpenRouterCreditsStale(this.current, nowMs, this.staleAfterMs)));
	}

	async refresh(): Promise<void> {
		if (this.refreshing || this.disposed) return;
		this.refreshing = true;
		const controller = new AbortController();
		this.controller = controller;
		try {
			const credits = await this.load(controller.signal);
			if (this.disposed) return;
			this.current = credits;
			this.failedTransiently = false;
		} catch (error) {
			if (this.disposed) return;
			if (error instanceof OpenRouterCreditsError && error.kind !== "transient") {
				this.current = undefined;
				this.failedTransiently = false;
			} else {
				this.failedTransiently = true;
			}
		} finally {
			this.refreshing = false;
			if (this.controller === controller) this.controller = undefined;
			if (!this.disposed) this.onChange?.();
		}
	}

	dispose(): void {
		this.disposed = true;
		this.controller?.abort();
		this.controller = undefined;
	}
}

export function createOpenRouterCreditsCache(options: CreateOpenRouterCreditsCacheOptions): OpenRouterCreditsCache | undefined {
	const apiKey = options.apiKey;
	if (!apiKey) return undefined;
	return new OpenRouterCreditsCache(
		(signal) =>
			fetchOpenRouterCredits({
				apiKey,
				timeoutMs: options.timeoutMs,
				signal,
				fetchImpl: options.fetchImpl,
			}),
		options.staleAfterMs ?? 15 * 60_000,
		options.onChange,
	);
}
