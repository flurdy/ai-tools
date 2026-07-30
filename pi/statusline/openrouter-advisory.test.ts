import assert from "node:assert/strict";
import test from "node:test";
import {
	OpenRouterCostAdvisory,
	openRouterAdvisoryConfig,
	type AdvisoryModel,
	type AdvisoryState,
} from "./openrouter-advisory.ts";

const openRouterModel = (input = 5): AdvisoryModel => ({
	provider: "openrouter",
	id: "openai/gpt-5.6-sol",
	cost: { input },
});

const config = {
	enabled: true,
	tokenThreshold: 100_000,
	costThreshold: 1,
};

function advisory(state: AdvisoryState = new Map()): OpenRouterCostAdvisory {
	return new OpenRouterCostAdvisory(config, state);
}

test("loads conservative defaults and configurable advisory thresholds", () => {
	assert.deepEqual(openRouterAdvisoryConfig({}), config);
	assert.deepEqual(
		openRouterAdvisoryConfig({
			PI_STATUSLINE_OPENROUTER_WARN: "0",
			PI_STATUSLINE_OPENROUTER_WARN_TOKENS: "250000",
			PI_STATUSLINE_OPENROUTER_WARN_COST: "2.5",
		}),
		{ enabled: false, tokenThreshold: 250_000, costThreshold: 2.5 },
	);
	assert.deepEqual(
		openRouterAdvisoryConfig({
			PI_STATUSLINE_OPENROUTER_WARN_TOKENS: "invalid",
			PI_STATUSLINE_OPENROUTER_WARN_COST: "-1",
		}),
		config,
	);
});

test("warns immediately after a manual switch to OpenRouter with large context", () => {
	const warning = advisory().warningForModelSelect("session-1", openRouterModel(), 200_000, "set");

	assert.match(warning ?? "", /openrouter\/openai\/gpt-5\.6-sol/);
	assert.match(warning ?? "", /200,000 context tokens/);
	assert.match(warning ?? "", /estimated uncached input \$1\.00/);
	assert.match(warning ?? "", /not provider billing/);
});

test("includes the submitted prompt before evaluating the first request", () => {
	const warning = advisory();
	const modelWithoutPricing = openRouterModel(Number.NaN);

	assert.equal(warning.warningForTurn("session-1", modelWithoutPricing, 99_999), undefined);
	assert.match(warning.warningForPrompt("session-1", modelWithoutPricing, 99_999, "four") ?? "", /100,000 context tokens/);
	assert.equal(warning.warningForTurn("session-1", modelWithoutPricing, 99_999), undefined);
	assert.match(warning.warningForPrompt("session-2", modelWithoutPricing, 98_800, "", 1) ?? "", /100,000 context tokens/);
});

test("warns as a continuing OpenRouter session crosses each configured threshold band", () => {
	const costWarning = advisory();
	const expensiveModel = openRouterModel(40);

	assert.equal(costWarning.warningForTurn("session-1", expensiveModel, 20_000), undefined);
	assert.match(costWarning.warningForTurn("session-1", expensiveModel, 25_000) ?? "", /estimated uncached input \$1\.00/);
	assert.equal(costWarning.warningForTurn("session-1", expensiveModel, 30_000), undefined);
	assert.match(costWarning.warningForTurn("session-1", expensiveModel, 50_000) ?? "", /estimated uncached input \$2\.00/);

	const tokenWarning = advisory();
	const modelWithoutPricing = openRouterModel(Number.NaN);
	assert.equal(tokenWarning.warningForTurn("session-2", modelWithoutPricing, 99_999), undefined);
	assert.match(tokenWarning.warningForTurn("session-2", modelWithoutPricing, 100_000) ?? "", /100,000 context tokens/);
	assert.equal(tokenWarning.warningForTurn("session-2", modelWithoutPricing, 150_000), undefined);
	assert.match(tokenWarning.warningForTurn("session-2", modelWithoutPricing, 200_000) ?? "", /200,000 context tokens/);
});

test("deduplicates model-switch and turn warnings by session, model, and threshold band", () => {
	const warning = advisory();
	const model = openRouterModel();

	assert.ok(warning.warningForModelSelect("session-1", model, 200_000, "cycle"));
	assert.equal(warning.warningForTurn("session-1", model, 200_000), undefined);
	assert.equal(warning.warningForModelSelect("session-1", model, 200_000, "set"), undefined);
	assert.ok(warning.warningForTurn("session-1", { ...model, id: "anthropic/another-model" }, 200_000));
	assert.ok(warning.warningForTurn("session-2", model, 200_000));
});

test("retains deduplication state across reloads and ignores restore events", () => {
	const state: AdvisoryState = new Map();
	const beforeReload = advisory(state);
	const afterReload = advisory(state);
	const model = openRouterModel();

	assert.ok(beforeReload.warningForTurn("session-1", model, 100_000));
	assert.equal(afterReload.warningForModelSelect("session-1", model, 100_000, "restore"), undefined);
	assert.equal(afterReload.warningForTurn("session-1", model, 100_000), undefined);
});

test("scopes warnings to OpenRouter and requires valid context usage", () => {
	const warning = advisory();
	const model = openRouterModel();

	assert.equal(warning.warningForTurn("session-1", { ...model, provider: "openai-codex" }, 200_000), undefined);
	assert.equal(warning.warningForTurn("session-1", model, null), undefined);
	assert.equal(warning.warningForTurn("session-1", model, Number.NaN), undefined);
	assert.equal(warning.warningForTurn("session-1", model, 50_000), undefined);
});

test("omits estimates for missing pricing and applies request-wide pricing tiers", () => {
	const withoutPricing = advisory().warningForTurn("session-1", openRouterModel(Number.NaN), 100_000);
	assert.match(withoutPricing ?? "", /100,000 context tokens/);
	assert.doesNotMatch(withoutPricing ?? "", /\$/);

	const tieredModel: AdvisoryModel = {
		...openRouterModel(1),
		cost: {
			input: 1,
			tiers: [
				{ inputTokensAbove: 100_000, input: 40 },
				{ inputTokensAbove: 50_000, input: 20 },
			],
		},
	};
	assert.equal(advisory().warningForTurn("session-2", tieredModel, 50_000), undefined);
	const tiered = advisory().warningForTurn("session-3", tieredModel, 50_001);
	assert.match(tiered ?? "", /estimated uncached input \$1\.00/);
});

test("supports disabling the advisory and either threshold", () => {
	assert.equal(new OpenRouterCostAdvisory({ ...config, enabled: false }).warningForTurn("session-1", openRouterModel(), 200_000), undefined);
	assert.ok(
		new OpenRouterCostAdvisory({ enabled: true, tokenThreshold: 0, costThreshold: 1 }).warningForTurn(
			"session-1",
			openRouterModel(40),
			25_000,
		),
	);
	assert.ok(
		new OpenRouterCostAdvisory({ enabled: true, tokenThreshold: 100_000, costThreshold: 0 }).warningForTurn(
			"session-1",
			openRouterModel(Number.NaN),
			100_000,
		),
	);
	assert.equal(
		new OpenRouterCostAdvisory({ enabled: true, tokenThreshold: 0, costThreshold: 0 }).warningForTurn(
			"session-1",
			openRouterModel(40),
			200_000,
		),
		undefined,
	);
});
