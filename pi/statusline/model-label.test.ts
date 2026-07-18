import assert from "node:assert/strict";
import test from "node:test";
import { activeModelLabel } from "./model-label.ts";

test("formats an active model with its current thinking level", () => {
	assert.equal(
		activeModelLabel("openai-codex", "gpt-5.6-sol", "xhigh"),
		"Running: GPT-5.6 Sol · thinking xhigh",
	);
});

test("does not render an active indicator without a model", () => {
	assert.equal(activeModelLabel(undefined, undefined, "high"), undefined);
});
