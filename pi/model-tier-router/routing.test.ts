import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { loadRouterConfig } from "./config.ts";
import {
	canonicalPath,
	decideTier,
	parseSkillRouting,
	requiresMeteredConfirmation,
	selectCandidate,
	shouldRestoreAfterRun,
	type TierRoute,
} from "./routing.ts";

function model(provider: string, id: string): Model<Api> {
	return { provider, id } as Model<Api>;
}

const standard: TierRoute = {
	rank: 20,
	thinking: "high",
	candidates: [
		{ model: "missing/first", metered: false },
		{ model: "provider/model/id", metered: false },
	],
};

describe("skill routing metadata", () => {
	it("extracts router fields and ignores Claude and second-opinion model fields", () => {
		const metadata = parseSkillRouting(`---
name: review
model: haiku
model-tier: premium-review
model-cost-policy: deliberate-premium
model-metered-policy: ask-above-standard
model-second-opinion-tier: independent-reasoning
---
Body
`);
		assert.deepEqual(metadata, {
			tier: "premium-review",
			costPolicy: "deliberate-premium",
			meteredPolicy: "ask-above-standard",
		});
	});
});

describe("tier decisions", () => {
	it("establishes a first tier and permits only higher-ranked upgrades", () => {
		assert.equal(decideTier(undefined, { tier: "standard", rank: 20 }), "initial");
		assert.equal(decideTier({ tier: "standard", rank: 20 }, { tier: "premium", rank: 40 }), "upgrade");
		assert.equal(decideTier({ tier: "premium", rank: 40 }, { tier: "cheap", rank: 10 }), "retain-lower");
	});

	it("retains the root route for equal-ranked tiers", () => {
		assert.equal(decideTier({ tier: "premium-review", rank: 40 }, { tier: "premium-reasoning", rank: 40 }), "retain-equal");
	});
});

describe("candidate selection", () => {
	it("requires metered confirmation only when skill policy asks for it", () => {
		const metered = { model: "provider/premium", metered: true };
		assert.equal(requiresMeteredConfirmation(metered, {}), false);
		assert.equal(requiresMeteredConfirmation(metered, { meteredPolicy: "ask-above-standard" }), true);
		assert.equal(requiresMeteredConfirmation(metered, { costPolicy: "deliberate-premium" }), true);
		assert.equal(requiresMeteredConfirmation({ ...metered, metered: false }, { costPolicy: "deliberate-premium" }), false);
	});

	it("uses exact provider/model ids and configured fallback order", () => {
		const selected = selectCandidate(standard, [model("provider", "model/id"), model("other", "first")]);
		assert.deepEqual(selected, { model: "provider/model/id", metered: false });
	});

	it("returns undefined when no configured candidate is available", () => {
		assert.equal(selectCandidate(standard, [model("provider", "different")]), undefined);
	});
});

describe("configuration", () => {
	it("loads global configuration and merges trusted project tiers", () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "model-tier-router.json"),
			JSON.stringify({
				enabled: true,
				tiers: {
					standard: { rank: 20, thinking: "high", candidates: [{ model: "global/standard", metered: false }] },
					cheap: { rank: 10, thinking: "low", candidates: [] },
				},
			}),
		);
		writeFileSync(
			join(cwd, ".pi", "model-tier-router.json"),
			JSON.stringify({
				restoreAfterRun: false,
				tiers: {
					standard: { rank: 25, thinking: "medium", candidates: [{ model: "project/standard", metered: true }] },
				},
			}),
		);

		const result = loadRouterConfig({ agentDir, cwd, projectTrusted: true });
		assert.equal(result.config.restoreAfterRun, false);
		assert.equal(result.config.tiers.standard.rank, 25);
		assert.equal(result.config.tiers.standard.candidates[0]?.model, "project/standard");
		assert.equal(result.config.tiers.cheap.rank, 10);
		assert.equal(result.loadedPaths.length, 2);
	});

	it("ignores an untrusted project override", () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "model-tier-router.json"), JSON.stringify({ enabled: true }));
		writeFileSync(join(cwd, ".pi", "model-tier-router.json"), JSON.stringify({ enabled: false }));

		const result = loadRouterConfig({ agentDir, cwd, projectTrusted: false });
		assert.equal(result.config.enabled, true);
		assert.deepEqual(result.loadedPaths, [join(agentDir, "model-tier-router.json")]);
	});
});

describe("path and restoration safety", () => {
	it("canonicalises symlinked skill paths", async () => {
		const root = mkdtempSync(join(tmpdir(), "model-tier-router-"));
		const skillDir = join(root, "real-skill");
		mkdirSync(skillDir);
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: test\ndescription: test\n---\n");
		symlinkSync(skillDir, join(root, "linked-skill"));
		assert.equal(await canonicalPath("linked-skill/SKILL.md", root), join(skillDir, "SKILL.md"));
	});

	it("suppresses restoration after a manual model override", () => {
		assert.equal(shouldRestoreAfterRun(true, false), true);
		assert.equal(shouldRestoreAfterRun(true, true), false);
		assert.equal(shouldRestoreAfterRun(false, false), false);
	});
});
