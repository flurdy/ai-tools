import { spawn } from "node:child_process";
import { fetchOpenRouterCredits, OpenRouterCreditsError, type OpenRouterCredits } from "../statusline/openrouter-credits.ts";
import { formatLocal, MAX_TIMEOUT_MS, MIN_TIMEOUT_MS, parseQuotaArgs, sanitizeMessage } from "./quota-common.ts";

const SOURCE = "openrouter-account-credits";
const KEY_LOOKUP_TIMEOUT_MS = 2000;

export const SOURCE_CAVEATS: readonly string[] = [
	"Values describe the OpenRouter account of the openrouter_management key for SECRET_API_KEY_PROJECT; alignment with inference keys or Pi's active account is not verified.",
	"Totals are canonical decimal strings of the API's parsed numeric values, not the original JSON spelling; remaining credits is their decimal difference, not a provider-reported field.",
	"Credits are an account balance, not a subscription window, reset, percentage or request/token allowance.",
];

export const USAGE = `usage: openrouter-quota [--timeout-ms <${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}>] [--help]

Prints the explicitly configured OpenRouter account's credits as JSON.
Read-only: one GET /api/v1/credits; no inference, retry or account mutation.
Requires SECRET_API_KEY_PROJECT and secret-api-key lookup openrouter_management <project>.
Exit codes: 0 report printed, 1 lookup failed (JSON error envelope), 2 usage error.
`;

type ErrorKind = "not-configured" | "key-helper-missing" | "credential-unavailable" | "authorization" | "timeout" | "lookup-failed" | "unexpected-response";
const MESSAGES: Record<ErrorKind, string> = {
	"not-configured": "Set SECRET_API_KEY_PROJECT to an explicit keyring project (letters, digits, dots, hyphens or underscores; starting with a letter or digit).",
	"key-helper-missing": "The secret-api-key helper was not found on PATH.",
	"credential-unavailable": "The configured project's OpenRouter management credential is unavailable or invalid; no inference-key fallback is used.",
	authorization: "OpenRouter refused the credits request (HTTP 401 or 403); check the configured management credential and account.",
	timeout: "The OpenRouter credits lookup timed out.",
	"lookup-failed": "The OpenRouter credits lookup failed; no retry was made.",
	"unexpected-response": "OpenRouter did not return valid numeric credit totals.",
};

export class OpenRouterQuotaLookupError extends Error {
	readonly kind: ErrorKind;
	constructor(kind: ErrorKind) {
		super(MESSAGES[kind]);
		this.kind = kind;
	}
}

export interface OpenRouterQuotaReport {
	schemaVersion: 1;
	status: "ok";
	source: typeof SOURCE;
	timeZone: string;
	fetchedAt: string;
	fetchedAtLocal: string;
	credits: {
		unit: "credits";
		reported: { totalCredits: string; totalUsage: string };
		derived: { remainingCredits: string };
	};
	caveats: string[];
}

// Subtract the shortest round-trip decimal representations, not binary floats.
// Inputs have already been parsed as finite, nonnegative numbers by the shared fetcher.
function decimalDifference(left: number, right: number): string {
	function scaled(value: number): { coefficient: bigint; scale: number } {
		const [mantissa, exponent = "0"] = String(value).split("e");
		const [whole, fraction = ""] = mantissa.split(".");
		const scale = fraction.length - Number(exponent);
		const coefficient = BigInt(whole + fraction);
		return scale < 0 ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 } : { coefficient, scale };
	}
	const a = scaled(left), b = scaled(right), scale = Math.max(a.scale, b.scale);
	const difference = a.coefficient * 10n ** BigInt(scale - a.scale) - b.coefficient * 10n ** BigInt(scale - b.scale);
	if (difference === 0n) return "0";
	const sign = difference < 0n ? "-" : "";
	const digits = (difference < 0n ? -difference : difference).toString().padStart(scale + 1, "0");
	if (scale === 0) return sign + digits;
	return sign + `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/0+$/, "").replace(/\.$/, "");
}

export function buildOpenRouterQuotaReport(snapshot: OpenRouterCredits, options: { timeZone: string }): OpenRouterQuotaReport {
	if (![snapshot.totalCredits, snapshot.totalUsage].every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
		throw new OpenRouterQuotaLookupError("unexpected-response");
	}
	return {
		schemaVersion: 1,
		status: "ok",
		source: SOURCE,
		timeZone: options.timeZone,
		fetchedAt: new Date(snapshot.fetchedAtMs).toISOString(),
		fetchedAtLocal: formatLocal(snapshot.fetchedAtMs, options.timeZone),
		credits: {
			unit: "credits",
			reported: { totalCredits: String(snapshot.totalCredits), totalUsage: String(snapshot.totalUsage) },
			derived: { remainingCredits: decimalDifference(snapshot.totalCredits, snapshot.totalUsage) },
		},
		caveats: [...SOURCE_CAVEATS],
	};
}

interface LookupOptions { timeoutMs: number; signal: AbortSignal }
type ManagementKeyLookup = (project: string, options: LookupOptions) => Promise<string>;

const lookupManagementKey: ManagementKeyLookup = (project, options) => new Promise((resolve, reject) => {
	if (options.signal.aborted) { reject(new OpenRouterQuotaLookupError("timeout")); return; }
	const child = spawn("secret-api-key", ["lookup", "openrouter_management", project], {
		stdio: ["ignore", "pipe", "ignore"], detached: true,
	});
	let settled = false, size = 0;
	const chunks: Buffer[] = [];
	const finish = (kind?: ErrorKind) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		options.signal.removeEventListener("abort", abort);
		child.stdout.destroy();
		if (kind) reject(new OpenRouterQuotaLookupError(kind));
		else resolve(Buffer.concat(chunks).toString("utf8"));
	};
	const stop = (kind: ErrorKind) => {
		// Close our pipe as well as killing the owned group: an escaped descendant
		// must not keep the CLI alive by retaining the helper's stdout.
		if (child.pid !== undefined) {
			try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
		}
		finish(kind);
	};
	const abort = () => stop("timeout");
	const timer = setTimeout(abort, options.timeoutMs);
	options.signal.addEventListener("abort", abort, { once: true });
	child.stdout.on("data", (chunk: Buffer) => {
		size += chunk.length;
		if (size > 8192) stop("credential-unavailable");
		else chunks.push(chunk);
	});
	// Child output and error messages can contain arbitrary credentials; never forward them.
	child.on("error", (error: NodeJS.ErrnoException) => finish(error.code === "ENOENT" ? "key-helper-missing" : "credential-unavailable"));
	child.on("close", (code) => finish(code === 0 ? undefined : "credential-unavailable"));
});

interface FetchOptions {
	timeoutMs: number;
	env?: NodeJS.ProcessEnv;
	lookup?: ManagementKeyLookup;
	fetchImpl?: typeof fetch;
}

export async function fetchOpenRouterQuotaSnapshot(options: FetchOptions): Promise<OpenRouterCredits> {
	const project = (options.env ?? process.env).SECRET_API_KEY_PROJECT?.trim();
	if (!project || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(project)) throw new OpenRouterQuotaLookupError("not-configured");
	const controller = new AbortController();
	const deadline = Date.now() + options.timeoutMs;
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	try {
		let value: string;
		try {
			value = await (options.lookup ?? lookupManagementKey)(project, { timeoutMs: Math.min(options.timeoutMs, KEY_LOOKUP_TIMEOUT_MS), signal: controller.signal });
		} catch (error) {
			if (error instanceof OpenRouterQuotaLookupError) throw error;
			throw new OpenRouterQuotaLookupError(controller.signal.aborted ? "timeout" : "credential-unavailable");
		}
		const remainingMs = deadline - Date.now();
		if (controller.signal.aborted || remainingMs <= 0) throw new OpenRouterQuotaLookupError("timeout");
		const key = value.replace(/\r?\n$/, "");
		if (!key || /[\u0000-\u0020\u007f]/.test(key)) throw new OpenRouterQuotaLookupError("credential-unavailable");
		try {
			return await fetchOpenRouterCredits({
				apiKey: key, timeoutMs: remainingMs, signal: controller.signal,
				fetchImpl: (url, init) => (options.fetchImpl ?? fetch)(url, { ...init, redirect: "error" }),
			});
		} catch (error) {
			if (controller.signal.aborted || error instanceof OpenRouterCreditsError && /timed out/.test(error.message)) throw new OpenRouterQuotaLookupError("timeout");
			if (error instanceof OpenRouterCreditsError && error.kind === "authorization") throw new OpenRouterQuotaLookupError("authorization");
			if (error instanceof OpenRouterCreditsError && error.kind === "invalid-response") throw new OpenRouterQuotaLookupError("unexpected-response");
			throw new OpenRouterQuotaLookupError("lookup-failed");
		}
	} finally { clearTimeout(timer); }
}

interface RunDependencies {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	fetch?: (options: { timeoutMs: number }) => Promise<OpenRouterCredits>;
	timeZone?: string;
}

export async function runOpenRouterQuota(argv: string[], deps: RunDependencies): Promise<number> {
	const args = parseQuotaArgs(argv);
	if ("error" in args) {
		deps.stderr(`openrouter-quota: ${sanitizeMessage(args.error, "")}\n${USAGE}`);
		return 2;
	}
	if ("help" in args) { deps.stdout(USAGE); return 0; }
	try {
		const snapshot = await (deps.fetch ?? fetchOpenRouterQuotaSnapshot)({ timeoutMs: args.timeoutMs });
		const report = buildOpenRouterQuotaReport(snapshot, { timeZone: deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone });
		deps.stdout(`${JSON.stringify(report, null, 2)}\n`);
		return 0;
	} catch (error) {
		const kind = error instanceof OpenRouterQuotaLookupError ? error.kind : "lookup-failed";
		deps.stdout(`${JSON.stringify({ schemaVersion: 1, status: "error", source: SOURCE, error: { kind, message: MESSAGES[kind] }, caveats: [...SOURCE_CAVEATS] }, null, 2)}\n`);
		return 1;
	}
}
