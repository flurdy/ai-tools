import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TierRoute, ThinkingLevel } from "./routing.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface UsageLedgerConfig {
	enabled: boolean;
	retentionDays: number;
	maxBytes: number;
}

export interface RouterConfig {
	enabled: boolean;
	routeImplicitSkillReads: boolean;
	usageLedger: UsageLedgerConfig;
	tiers: Record<string, TierRoute>;
}

export interface LoadedRouterConfig {
	config: RouterConfig;
	globalPath: string;
	projectPath: string;
	loadedPaths: string[];
	warnings: string[];
}

export interface LoadConfigOptions {
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
	configDirName?: string;
}

function emptyTiers(): Record<string, TierRoute> {
	return Object.create(null) as Record<string, TierRoute>;
}

const DEFAULT_CONFIG: RouterConfig = {
	enabled: true,
	routeImplicitSkillReads: true,
	usageLedger: { enabled: false, retentionDays: 30, maxBytes: 10 * 1024 * 1024 },
	tiers: emptyTiers(),
};

function readJson(path: string, warnings: string[]): unknown | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function parseTier(name: string, value: unknown, path: string, warnings: string[]): TierRoute | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		warnings.push(`${path}: tier ${name} must be an object`);
		return undefined;
	}
	const input = value as Record<string, unknown>;
	if (typeof input.rank !== "number" || !Number.isFinite(input.rank)) {
		warnings.push(`${path}: tier ${name} has an invalid rank`);
		return undefined;
	}
	if (typeof input.thinking !== "string" || !THINKING_LEVELS.has(input.thinking as ThinkingLevel)) {
		warnings.push(`${path}: tier ${name} has an invalid thinking level`);
		return undefined;
	}
	if (!Array.isArray(input.candidates)) {
		warnings.push(`${path}: tier ${name} candidates must be an array`);
		return undefined;
	}

	const candidates: TierRoute["candidates"] = [];
	for (const [index, candidate] of input.candidates.entries()) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
			warnings.push(`${path}: tier ${name} candidate ${index + 1} must be an object`);
			continue;
		}
		const item = candidate as Record<string, unknown>;
		if (typeof item.model !== "string" || !item.model.includes("/") || item.model.startsWith("/") || item.model.endsWith("/")) {
			warnings.push(`${path}: tier ${name} candidate ${index + 1} must use provider/model`);
			continue;
		}
		if (typeof item.metered !== "boolean") {
			warnings.push(`${path}: tier ${name} candidate ${index + 1} must declare a boolean metered flag`);
			continue;
		}
		candidates.push({ model: item.model, metered: item.metered });
	}

	return {
		rank: input.rank,
		thinking: input.thinking as ThinkingLevel,
		candidates,
	};
}

interface PartialRouterConfig {
	enabled?: boolean;
	routeImplicitSkillReads?: boolean;
	usageLedger?: UsageLedgerConfig;
	tiers: Record<string, TierRoute>;
}

function parseConfig(value: unknown, path: string, warnings: string[]): PartialRouterConfig | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		warnings.push(`${path}: configuration must be an object`);
		return undefined;
	}
	const input = value as Record<string, unknown>;
	const parsed: PartialRouterConfig = { tiers: emptyTiers() };
	for (const key of ["enabled", "routeImplicitSkillReads"] as const) {
		if (input[key] === undefined) continue;
		if (typeof input[key] !== "boolean") warnings.push(`${path}: ${key} must be boolean`);
		else parsed[key] = input[key];
	}
	if (input.usageLedger !== undefined) {
		if (!input.usageLedger || typeof input.usageLedger !== "object" || Array.isArray(input.usageLedger)) {
			warnings.push(`${path}: usageLedger must be an object`);
		} else {
			const ledger = input.usageLedger as Record<string, unknown>;
			if (typeof ledger.enabled !== "boolean") warnings.push(`${path}: usageLedger.enabled must be boolean`);
			else if (!Number.isInteger(ledger.retentionDays) || (ledger.retentionDays as number) < 1) warnings.push(`${path}: usageLedger.retentionDays must be a positive integer`);
			else if (!Number.isInteger(ledger.maxBytes) || (ledger.maxBytes as number) < 1024) warnings.push(`${path}: usageLedger.maxBytes must be an integer of at least 1024`);
			else parsed.usageLedger = { enabled: ledger.enabled, retentionDays: ledger.retentionDays as number, maxBytes: ledger.maxBytes as number };
		}
	}
	if (input.tiers !== undefined) {
		if (!input.tiers || typeof input.tiers !== "object" || Array.isArray(input.tiers)) {
			warnings.push(`${path}: tiers must be an object`);
		} else {
			for (const [name, tier] of Object.entries(input.tiers)) {
				const parsedTier = parseTier(name, tier, path, warnings);
				if (parsedTier) parsed.tiers[name] = parsedTier;
			}
		}
	}
	return parsed;
}

function mergeConfig(base: RouterConfig, override: PartialRouterConfig): RouterConfig {
	return {
		enabled: override.enabled ?? base.enabled,
		routeImplicitSkillReads: override.routeImplicitSkillReads ?? base.routeImplicitSkillReads,
		usageLedger: override.usageLedger ?? base.usageLedger,
		tiers: Object.assign(emptyTiers(), base.tiers, override.tiers),
	};
}

export function loadRouterConfig(options: LoadConfigOptions): LoadedRouterConfig {
	const globalPath = join(options.agentDir, "model-tier-router.json");
	const projectPath = join(options.cwd, options.configDirName ?? ".pi", "model-tier-router.json");
	const loadedPaths: string[] = [];
	const warnings: string[] = [];
	let config = DEFAULT_CONFIG;

	const globalValue = readJson(globalPath, warnings);
	if (globalValue !== undefined) {
		const parsed = parseConfig(globalValue, globalPath, warnings);
		if (parsed) {
			config = mergeConfig(config, parsed);
			loadedPaths.push(globalPath);
		}
	}

	if (options.projectTrusted) {
		const projectValue = readJson(projectPath, warnings);
		if (projectValue !== undefined) {
			const parsed = parseConfig(projectValue, projectPath, warnings);
			if (parsed) {
				if (parsed.usageLedger) {
					warnings.push(`${projectPath}: usageLedger is global-only and was ignored`);
					parsed.usageLedger = undefined;
				}
				config = mergeConfig(config, parsed);
				loadedPaths.push(projectPath);
			}
		}
	}

	return { config, globalPath, projectPath, loadedPaths, warnings };
}
