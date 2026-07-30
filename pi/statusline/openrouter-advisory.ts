export type AdvisoryModel = {
	provider?: string;
	id?: string;
	cost?: {
		input?: number;
		tiers?: Array<{
			inputTokensAbove?: number;
			input?: number;
		}>;
	};
};

export type OpenRouterAdvisoryConfig = {
	enabled: boolean;
	tokenThreshold: number;
	costThreshold: number;
};

type AdvisoryBands = {
	tokens: number;
	cost: number;
};

export type AdvisoryState = Map<string, AdvisoryBands>;

type ModelSelectSource = "set" | "cycle" | "restore";

const DEFAULT_TOKEN_THRESHOLD = 100_000;
const DEFAULT_COST_THRESHOLD = 1;
const CHARS_PER_TOKEN = 4;
const TOKENS_PER_IMAGE = 1200;
const MAX_STATE_ENTRIES = 100;

function configuredThreshold(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === "") return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function openRouterAdvisoryConfig(env: NodeJS.ProcessEnv = process.env): OpenRouterAdvisoryConfig {
	return {
		enabled: env.PI_STATUSLINE_OPENROUTER_WARN !== "0",
		tokenThreshold: configuredThreshold(env.PI_STATUSLINE_OPENROUTER_WARN_TOKENS, DEFAULT_TOKEN_THRESHOLD),
		costThreshold: configuredThreshold(env.PI_STATUSLINE_OPENROUTER_WARN_COST, DEFAULT_COST_THRESHOLD),
	};
}

function inputRate(model: AdvisoryModel, tokens: number): number | undefined {
	let rate = model.cost?.input;
	let matchedThreshold = -1;
	for (const tier of model.cost?.tiers ?? []) {
		const threshold = tier.inputTokensAbove;
		if (!Number.isFinite(threshold) || !Number.isFinite(tier.input) || (threshold ?? -1) < 0 || tokens <= (threshold ?? 0)) continue;
		if (threshold !== undefined && tier.input !== undefined && threshold > matchedThreshold) {
			rate = tier.input;
			matchedThreshold = threshold;
		}
	}
	return Number.isFinite(rate) && (rate ?? 0) > 0 ? rate : undefined;
}

function estimatedUncachedInputCost(model: AdvisoryModel, tokens: number): number | undefined {
	const rate = inputRate(model, tokens);
	if (rate === undefined) return undefined;
	const estimate = (tokens / 1_000_000) * rate;
	return Number.isFinite(estimate) && estimate >= 0 ? estimate : undefined;
}

function thresholdBand(value: number | undefined, threshold: number): number {
	if (value === undefined || threshold <= 0 || value < threshold) return 0;
	return Math.max(1, Math.floor(value / threshold));
}

function modelKey(sessionId: string, model: AdvisoryModel): string {
	return `${sessionId}\0${model.provider}/${model.id}`;
}

function warningMessage(model: AdvisoryModel, tokens: number, estimate: number | undefined): string {
	const modelName = `${model.provider}/${model.id}`;
	const context = `${tokens.toLocaleString("en-US")} context tokens`;
	if (estimate === undefined) return `OpenRouter cost warning: ${modelName} has ${context}.`;
	const cost = estimate < 0.01 ? "<$0.01" : `$${estimate.toFixed(2)}`;
	return `OpenRouter cost warning: ${modelName} has ${context}; estimated uncached input ${cost} for the next request (Pi model pricing, not provider billing).`;
}

export class OpenRouterCostAdvisory {
	constructor(
		private readonly config: OpenRouterAdvisoryConfig,
		private readonly state: AdvisoryState = new Map(),
	) {}

	warningForModelSelect(
		sessionId: string,
		model: AdvisoryModel,
		tokens: number | null,
		source: ModelSelectSource,
	): string | undefined {
		if (source === "restore") return undefined;
		return this.warning(sessionId, model, tokens);
	}

	warningForPrompt(
		sessionId: string,
		model: AdvisoryModel,
		currentTokens: number | null,
		prompt: string,
		imageCount = 0,
	): string | undefined {
		if (!Number.isFinite(currentTokens) || (currentTokens ?? -1) < 0) return undefined;
		const promptTokens = Math.ceil(prompt.length / CHARS_PER_TOKEN) + Math.max(0, imageCount) * TOKENS_PER_IMAGE;
		return this.warning(sessionId, model, (currentTokens as number) + promptTokens);
	}

	warningForTurn(sessionId: string, model: AdvisoryModel, tokens: number | null): string | undefined {
		return this.warning(sessionId, model, tokens);
	}

	private warning(sessionId: string, model: AdvisoryModel, tokens: number | null): string | undefined {
		if (!this.config.enabled || model.provider !== "openrouter" || !model.id) return undefined;
		if (!Number.isFinite(tokens) || (tokens ?? -1) < 0) return undefined;

		const contextTokens = tokens as number;
		const estimate = estimatedUncachedInputCost(model, contextTokens);
		const bands = {
			tokens: thresholdBand(contextTokens, this.config.tokenThreshold),
			cost: thresholdBand(estimate, this.config.costThreshold),
		};
		if (bands.tokens === 0 && bands.cost === 0) return undefined;

		const key = modelKey(sessionId, model);
		const previous = this.state.get(key) ?? { tokens: 0, cost: 0 };
		if (bands.tokens <= previous.tokens && bands.cost <= previous.cost) return undefined;

		if (!this.state.has(key) && this.state.size >= MAX_STATE_ENTRIES) {
			const oldest = this.state.keys().next().value;
			if (oldest !== undefined) this.state.delete(oldest);
		}
		this.state.set(key, {
			tokens: Math.max(previous.tokens, bands.tokens),
			cost: Math.max(previous.cost, bands.cost),
		});
		return warningMessage(model, contextTokens, estimate);
	}
}

const globalState = globalThis as typeof globalThis & {
	__flurdyPiStatuslineOpenRouterAdvisoryState?: AdvisoryState;
};

export function sharedOpenRouterAdvisoryState(): AdvisoryState {
	globalState.__flurdyPiStatuslineOpenRouterAdvisoryState ??= new Map();
	return globalState.__flurdyPiStatuslineOpenRouterAdvisoryState;
}
