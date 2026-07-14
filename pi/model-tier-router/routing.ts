import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { Api } from "@earendil-works/pi-ai";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelCandidate {
	model: string;
	metered: boolean;
}

export interface TierRoute {
	rank: number;
	thinking: ThinkingLevel;
	candidates: ModelCandidate[];
}

export interface SkillRoutingMetadata {
	tier?: string;
	costPolicy?: string;
	meteredPolicy?: string;
}

export interface ActiveTier {
	tier: string;
	rank: number;
}

export type TierDecision = "initial" | "upgrade" | "retain-lower" | "retain-equal";

interface RoutingFrontmatter extends Record<string, unknown> {
	"model-tier"?: unknown;
	"model-cost-policy"?: unknown;
	"model-metered-policy"?: unknown;
	model?: unknown;
	"model-second-opinion-tier"?: unknown;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Extract only router-owned metadata. Claude's `model` and second-opinion metadata are intentionally ignored. */
export function parseSkillRouting(content: string): SkillRoutingMetadata {
	const { frontmatter } = parseFrontmatter<RoutingFrontmatter>(content);
	return {
		tier: optionalString(frontmatter["model-tier"]),
		costPolicy: optionalString(frontmatter["model-cost-policy"]),
		meteredPolicy: optionalString(frontmatter["model-metered-policy"]),
	};
}

export function decideTier(active: ActiveTier | undefined, requested: ActiveTier): TierDecision {
	if (!active) return "initial";
	if (requested.rank > active.rank) return "upgrade";
	if (requested.rank < active.rank) return "retain-lower";
	return "retain-equal";
}

export function selectCandidate(route: TierRoute, available: Model<Api>[]): ModelCandidate | undefined {
	const availableIds = new Set(available.map((model) => `${model.provider}/${model.id}`));
	return route.candidates.find((candidate) => availableIds.has(candidate.model));
}

export function findExactModel(candidate: ModelCandidate, available: Model<Api>[]): Model<Api> | undefined {
	return available.find((model) => `${model.provider}/${model.id}` === candidate.model);
}

const METERED_CONFIRMATION_POLICIES = new Set([
	"ask-above-standard",
	"cap-or-ask",
	"ask-before-metered-panel",
]);

export function requiresMeteredConfirmation(
	candidate: ModelCandidate,
	metadata: SkillRoutingMetadata,
): boolean {
	if (!candidate.metered) return false;
	return (
		(metadata.meteredPolicy !== undefined && METERED_CONFIRMATION_POLICIES.has(metadata.meteredPolicy)) ||
		metadata.costPolicy === "deliberate-premium"
	);
}

export function shouldRestoreAfterRun(restoreAfterRun: boolean, manualModelOverride: boolean): boolean {
	return restoreAfterRun && !manualModelOverride;
}

export async function canonicalPath(path: string, cwd: string): Promise<string | undefined> {
	const normalized = path.startsWith("@") ? path.slice(1) : path;
	try {
		return await realpath(resolve(cwd, normalized));
	} catch {
		return undefined;
	}
}
