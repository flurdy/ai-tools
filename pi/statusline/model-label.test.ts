import assert from "node:assert/strict";
import test from "node:test";
import { activeModelLabel, modelLabel, shortModel } from "./model-label.ts";

const shortenedModels = [
	["gpt-6.1-sol", "Sol 6.1"],
	["openai/gpt-5.6-terra", "Terra 5.6"],
	["gpt-5.6-luna", "Luna 5.6"],
	["gpt-6-astra", "Astra 6"],
	["gpt-6.1-sol-pro", "Sol 6.1+"],
	["gpt-6-astra-pro", "Astra 6+"],
	["gpt-5.6-sol", "Sol 5.6"],
	["gpt-5.6a-sol", "Sol 5.6a"],
	["gpt_5.6_sol", "Sol 5.6"],
	["gpt-5.3-codex-spark", "Codex Spark 5.3"],
	["anthropic/claude-sonnet-5-5", "Sonnet 5.5"],
	["claude-opus-5.5", "Opus 5.5"],
	["claude-fable-5-1", "Fable 5.1"],
	["claude-haiku-4-5-20251001", "Haiku 4.5"],
	["claude-sonnet-4-6", "Sonnet 4.6"],
] as const;

for (const [id, label] of shortenedModels) {
	test(`shortens ${id} to ${label}`, () => {
		assert.equal(shortModel(id), label);
	});
}

test("keeps useful unnamed GPT, unknown, and other-provider labels", () => {
	for (const [id, label] of [
		["gpt-5", "GPT-5"],
		["gpt-6.1", "GPT-6.1"],
		["gpt-6.1-pro", "GPT-6.1+"],
		["unknown/custom-model", "Custom Model"],
		["claude-experimental", "Experimental"],
		["no-model", "No Model"],
		["codex", "Codex"],
		["google/gemini-3.1-pro-preview", "Gemini 3.1 Pro"],
		["gemini-2.5-flash", "Gemini 2.5 Flash"],
		["mistral-large", "Mistral Large"],
	] as const) {
		assert.equal(shortModel(id), label);
	}
});

test("preserves the OR marker only for the OpenRouter route", () => {
	assert.equal(modelLabel("openai-codex", "gpt-6.1-sol"), "Sol 6.1");
	assert.equal(modelLabel("openrouter", "openai/gpt-6.1-sol-pro"), "OR Sol 6.1+");
	assert.equal(modelLabel("openrouter", "anthropic/claude-sonnet-5-5"), "OR Sonnet 5.5");
	assert.equal(modelLabel("anthropic", "claude-sonnet-5-5"), "Sonnet 5.5");
	assert.equal(modelLabel(undefined, "gpt-6.1-sol"), "Sol 6.1");
});

test("uses the same short label for the active model and current thinking level", () => {
	for (const [id, label] of shortenedModels) {
		assert.equal(activeModelLabel("openai-codex", id, "xhigh"), `Running: ${label} · thinking xhigh`);
	}
	assert.equal(activeModelLabel("openrouter", "openai/gpt-6.1-sol-pro", "high"), "Running: OR Sol 6.1+ · thinking high");
	assert.equal(activeModelLabel("anthropic", "claude-sonnet-5-5", ""), "Running: Sonnet 5.5");
});

test("does not render an active indicator without a model", () => {
	assert.equal(activeModelLabel(undefined, undefined, "high"), undefined);
});
