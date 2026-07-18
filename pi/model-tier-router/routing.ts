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
	effort?: ThinkingLevel;
}

export interface ActiveTier {
	tier: string;
	rank: number;
}

export interface ModelIdentity {
	provider: string;
	model: string;
}

export type MeteredClassification = boolean | "unknown";
export type ConsentBasis = "not-needed" | "confirmed" | "declined" | "unavailable-ui" | "not-requested-implicit" | "not-applicable";
export type RestorationResult = "not-applicable" | "pending" | "deferred" | "restored" | "failed" | "cancelled-by-manual-override";

/** One consistent account of a model-routing decision, including outcomes that retain the current route. */
export interface RouteDecisionRecord {
	requestedTier: string;
	effectiveTier: string;
	candidate: ModelCandidate | null;
	effectiveModel: ModelIdentity | null;
	thinkingLevel: ThinkingLevel;
	meteredClassification: MeteredClassification;
	consentBasis: ConsentBasis;
	reason: string;
	warnings: string[];
	restoration: RestorationResult;
}

export interface RouteDecisionInput {
	requestedTier: string;
	effectiveTier?: string;
	candidate?: ModelCandidate;
	effectiveModel?: ModelIdentity;
	thinkingLevel: ThinkingLevel;
	meteredClassification?: MeteredClassification;
	consentBasis: ConsentBasis;
	reason: string;
	warnings?: string[];
	restoration?: RestorationResult;
}

export function createRouteDecision(input: RouteDecisionInput): RouteDecisionRecord {
	return {
		requestedTier: input.requestedTier,
		effectiveTier: input.effectiveTier ?? input.requestedTier,
		candidate: input.candidate ? { ...input.candidate } : null,
		effectiveModel: input.effectiveModel ? { ...input.effectiveModel } : null,
		thinkingLevel: input.thinkingLevel,
		meteredClassification: input.meteredClassification ?? input.candidate?.metered ?? "unknown",
		consentBasis: input.consentBasis,
		reason: input.reason,
		warnings: [...(input.warnings ?? [])],
		restoration: input.restoration ?? "not-applicable",
	};
}

export type TierDecision = "initial" | "upgrade" | "retain-lower" | "retain-equal";

interface RoutingFrontmatter extends Record<string, unknown> {
	"model-tier"?: unknown;
	"model-cost-policy"?: unknown;
	"model-metered-policy"?: unknown;
	model?: unknown;
	"model-second-opinion-tier"?: unknown;
	effort?: unknown;
}

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalThinkingLevel(value: unknown): ThinkingLevel | undefined {
	const normalized = optionalString(value);
	return normalized && THINKING_LEVELS.includes(normalized as ThinkingLevel)
		? (normalized as ThinkingLevel)
		: undefined;
}

/** Extract only router-owned metadata. Claude's `model` and second-opinion metadata are intentionally ignored. */
export function parseSkillRouting(content: string): SkillRoutingMetadata {
	const { frontmatter } = parseFrontmatter<RoutingFrontmatter>(content);
	return {
		tier: optionalString(frontmatter["model-tier"]),
		costPolicy: optionalString(frontmatter["model-cost-policy"]),
		meteredPolicy: optionalString(frontmatter["model-metered-policy"]),
		effort: optionalThinkingLevel(frontmatter.effort),
	};
}

export function maxThinkingLevel(left: ThinkingLevel, right: ThinkingLevel): ThinkingLevel {
	return THINKING_LEVELS.indexOf(left) >= THINKING_LEVELS.indexOf(right) ? left : right;
}

export function decideTier(active: ActiveTier | undefined, requested: ActiveTier): TierDecision {
	if (!active) return "initial";
	if (requested.rank > active.rank) return "upgrade";
	if (requested.rank < active.rank) return "retain-lower";
	return "retain-equal";
}

/**
 * Selects one exact configured candidate before the provider request starts.
 *
 * This is deliberately not a post-launch retry mechanism. Runtime fallback, if
 * introduced, must remain bounded to configured candidates and reapply the
 * identity, metering, and consent checks documented in README.md.
 */
export function selectCandidate(route: TierRoute, available: Model<Api>[]): ModelCandidate | undefined {
	const availableIds = new Set(available.map((model) => `${model.provider}/${model.id}`));
	return route.candidates.find((candidate) => availableIds.has(candidate.model));
}

export function findExactModel(candidate: ModelCandidate, available: Model<Api>[]): Model<Api> | undefined {
	return available.find((model) => `${model.provider}/${model.id}` === candidate.model);
}

export function requiresMeteredConfirmation(candidate: ModelCandidate): boolean {
	return candidate.metered;
}

export async function canonicalPath(path: string, cwd: string): Promise<string | undefined> {
	const normalized = path.startsWith("@") ? path.slice(1) : path;
	try {
		return await realpath(resolve(cwd, normalized));
	} catch {
		return undefined;
	}
}
