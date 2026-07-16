import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "./routing.ts";

export const USAGE_SCHEMA_VERSION = 1;

export type UsageField = "input" | "cacheRead" | "cacheWrite" | "cacheWrite1h" | "output" | "reasoning";

export interface ObservedUsage {
	input: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	cacheWrite1h: number | null;
	output: number | null;
	reasoning: number | null;
}

export interface UsageRecordV1 {
	schemaVersion: typeof USAGE_SCHEMA_VERSION;
	recordId: string;
	timestamp: string;
	sessionId: string;
	routeRunId: string;
	responseIndex: number;
	tier: string;
	tierSourceSkill: string;
	routedSkills: string[];
	provider: string;
	model: string;
	responseModel: string | null;
	thinking: ThinkingLevel;
	stopReason: AssistantMessage["stopReason"];
	usage: ObservedUsage;
	unknownUsageFields: UsageField[];
	providerReportedCost: null;
}

export interface UsageTotals {
	responses: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h: number;
	output: number;
	reasoning: number;
	unknown: Record<UsageField, number>;
}

function observed(value: number | undefined): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function normalizeUsage(message: AssistantMessage): { usage: ObservedUsage; unknownUsageFields: UsageField[] } {
	const usage: ObservedUsage = {
		input: observed(message.usage.input),
		cacheRead: observed(message.usage.cacheRead),
		cacheWrite: observed(message.usage.cacheWrite),
		cacheWrite1h: observed(message.usage.cacheWrite1h),
		output: observed(message.usage.output),
		reasoning: observed(message.usage.reasoning),
	};
	const unknownUsageFields = (Object.keys(usage) as UsageField[]).filter((field) => usage[field] === null);
	return { usage, unknownUsageFields };
}

const USAGE_FIELDS: UsageField[] = ["input", "cacheRead", "cacheWrite", "cacheWrite1h", "output", "reasoning"];
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const STOP_REASONS = new Set<AssistantMessage["stopReason"]>(["stop", "length", "toolUse", "error", "aborted"]);

export function isUsageRecordV1(value: unknown): value is UsageRecordV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Partial<UsageRecordV1>;
	if (
		record.schemaVersion !== USAGE_SCHEMA_VERSION ||
		typeof record.recordId !== "string" || !record.recordId ||
		typeof record.timestamp !== "string" || !Number.isFinite(Date.parse(record.timestamp)) ||
		typeof record.sessionId !== "string" || !record.sessionId ||
		typeof record.routeRunId !== "string" || !record.routeRunId ||
		!Number.isInteger(record.responseIndex) || (record.responseIndex ?? 0) < 1 ||
		typeof record.tier !== "string" || !record.tier ||
		typeof record.tierSourceSkill !== "string" || !record.tierSourceSkill ||
		!Array.isArray(record.routedSkills) || !record.routedSkills.every((skill) => typeof skill === "string" && Boolean(skill)) ||
		typeof record.provider !== "string" || !record.provider ||
		typeof record.model !== "string" || !record.model ||
		(record.responseModel !== null && typeof record.responseModel !== "string") ||
		typeof record.thinking !== "string" || !THINKING_LEVELS.has(record.thinking as ThinkingLevel) ||
		typeof record.stopReason !== "string" || !STOP_REASONS.has(record.stopReason as AssistantMessage["stopReason"]) ||
		!record.usage || typeof record.usage !== "object" || Array.isArray(record.usage) ||
		!Array.isArray(record.unknownUsageFields) ||
		record.providerReportedCost !== null
	) return false;
	const usageKeys = Object.keys(record.usage).sort();
	if (usageKeys.length !== USAGE_FIELDS.length || !USAGE_FIELDS.every((field) => usageKeys.includes(field))) return false;
	const unknownFields = new Set(record.unknownUsageFields);
	if (unknownFields.size !== record.unknownUsageFields.length || !record.unknownUsageFields.every((field) => USAGE_FIELDS.includes(field))) return false;
	return USAGE_FIELDS.every((field) => {
		const usageValue = (record.usage as ObservedUsage)[field];
		const validValue = usageValue === null || (typeof usageValue === "number" && Number.isFinite(usageValue) && usageValue > 0);
		return validValue && unknownFields.has(field) === (usageValue === null);
	});
}

export function emptyUsageTotals(): UsageTotals {
	return {
		responses: 0,
		input: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cacheWrite1h: 0,
		output: 0,
		reasoning: 0,
		unknown: { input: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, output: 0, reasoning: 0 },
	};
}

export function addUsageRecord(totals: UsageTotals, record: UsageRecordV1): UsageTotals {
	totals.responses++;
	for (const field of Object.keys(record.usage) as UsageField[]) {
		const value = record.usage[field];
		if (value === null) totals.unknown[field]++;
	}
	totals.input += record.usage.input ?? 0;
	totals.cacheRead += record.usage.cacheRead ?? 0;
	totals.cacheWrite += record.usage.cacheWrite ?? 0;
	totals.cacheWrite1h += record.usage.cacheWrite1h ?? 0;
	totals.output += record.usage.output ?? 0;
	totals.reasoning += record.usage.reasoning ?? 0;
	return totals;
}
