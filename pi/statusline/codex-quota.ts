import { spawn } from "node:child_process";

const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const WINDOW_TOLERANCE = 0.05;

export interface CodexWeeklyQuota {
	usedPercent: number;
	remainingPercent: number;
	resetsAtMs: number | null;
	fetchedAtMs: number;
}

export interface FetchCodexQuotaOptions {
	command?: string;
	args?: string[];
	timeoutMs?: number;
	signal?: AbortSignal;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function valueAt(object: JsonObject, camelCase: string, snakeCase: string): unknown {
	return object[camelCase] ?? object[snakeCase];
}

function isWeeklyWindow(minutes: number): boolean {
	return minutes >= WEEKLY_WINDOW_MINUTES * (1 - WINDOW_TOLERANCE) && minutes <= WEEKLY_WINDOW_MINUTES * (1 + WINDOW_TOLERANCE);
}

/** Select the seven-day Codex window without assuming it is primary or secondary. */
export function selectCodexWeeklyQuota(result: unknown, fetchedAtMs = Date.now()): CodexWeeklyQuota | undefined {
	const root = asObject(result);
	if (!root) return undefined;
	const byLimitId = asObject(root.rateLimitsByLimitId ?? root.rate_limits_by_limit_id);
	const limits = asObject(byLimitId?.codex) ?? asObject(root.rateLimits ?? root.rate_limits);
	if (!limits) return undefined;

	const windows = [asObject(limits.primary), asObject(limits.secondary)].filter((window): window is JsonObject => Boolean(window));
	for (const window of windows) {
		const windowMinutes = finiteNumber(valueAt(window, "windowDurationMins", "window_minutes"));
		const usedPercent = finiteNumber(valueAt(window, "usedPercent", "used_percent"));
		if (windowMinutes === undefined || usedPercent === undefined || !isWeeklyWindow(windowMinutes)) continue;

		const boundedUsed = Math.max(0, Math.min(100, usedPercent));
		const resetsAtSeconds = finiteNumber(valueAt(window, "resetsAt", "resets_at"));
		return {
			usedPercent: boundedUsed,
			remainingPercent: 100 - boundedUsed,
			resetsAtMs: resetsAtSeconds === undefined ? null : resetsAtSeconds * 1000,
			fetchedAtMs,
		};
	}
	return undefined;
}

export function isCodexQuotaStale(quota: CodexWeeklyQuota, nowMs: number, staleAfterMs: number): boolean {
	return nowMs - quota.fetchedAtMs > staleAfterMs || (quota.resetsAtMs !== null && nowMs >= quota.resetsAtMs);
}

function errorMessage(value: unknown): string {
	const object = asObject(value);
	return typeof object?.message === "string" ? object.message : "unknown Codex app-server error";
}

/** Query Codex's authenticated app-server API without reading credential files. */
export function fetchCodexWeeklyQuota(options: FetchCodexQuotaOptions = {}): Promise<CodexWeeklyQuota> {
	const command = options.command ?? "codex";
	const args = options.args ?? ["app-server", "--stdio"];
	const timeoutMs = options.timeoutMs ?? 10_000;

	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("Codex quota query aborted"));
			return;
		}

		const child = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		let settled = false;
		let terminating = false;
		let pendingError: Error | undefined;
		let pendingQuota: CodexWeeklyQuota | undefined;
		let stdoutBuffer = "";
		let stderr = "";
		let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;

		const settle = (error?: Error, quota?: CodexWeeklyQuota) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (forceKillTimeout) clearTimeout(forceKillTimeout);
			options.signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else if (quota) resolve(quota);
			else reject(new Error("Codex quota query returned no result"));
		};
		const terminate = (error?: Error, quota?: CodexWeeklyQuota) => {
			if (settled || terminating) return;
			terminating = true;
			pendingError = error;
			pendingQuota = quota;
			clearTimeout(timeout);
			options.signal?.removeEventListener("abort", onAbort);
			try {
				child.stdin.end();
			} catch {}
			if (child.pid === undefined || child.exitCode !== null) {
				settle(pendingError, pendingQuota);
				return;
			}
			child.kill("SIGTERM");
			forceKillTimeout = setTimeout(() => {
				if (!settled && child.exitCode === null) child.kill("SIGKILL");
			}, 1000);
		};
		const fail = (message: string) => terminate(new Error(message));
		const onAbort = () => fail("Codex quota query aborted");
		const timeout = setTimeout(() => fail(`Codex quota query timed out after ${timeoutMs}ms`), timeoutMs);

		function send(message: JsonObject): void {
			if (settled || terminating) return;
			child.stdin.write(`${JSON.stringify(message)}\n`);
		}

		function handleMessage(message: JsonObject): void {
			if (message.id === 1) {
				if (message.error !== undefined) {
					fail(`Codex app-server initialization failed: ${errorMessage(message.error)}`);
					return;
				}
				send({ method: "initialized", params: {} });
				send({ method: "account/rateLimits/read", id: 2 });
				return;
			}
			if (message.id !== 2) return;
			if (message.error !== undefined) {
				fail(`Codex quota query failed: ${errorMessage(message.error)}`);
				return;
			}
			const quota = selectCodexWeeklyQuota(message.result);
			if (!quota) {
				fail("Codex quota response did not include a weekly window");
				return;
			}
			terminate(undefined, quota);
		}

		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBuffer += chunk.toString("utf8");
			let newline = stdoutBuffer.indexOf("\n");
			while (newline >= 0) {
				const line = stdoutBuffer.slice(0, newline).trim();
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				if (line) {
					try {
						handleMessage(JSON.parse(line) as JsonObject);
					} catch {
						// Ignore non-protocol stdout and continue looking for the requested response.
					}
				}
				newline = stdoutBuffer.indexOf("\n");
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 4096) stderr += chunk.toString("utf8").slice(0, 4096 - stderr.length);
		});
		child.on("error", (error) => {
			if (!terminating) fail(`Unable to start Codex app-server: ${error.message}`);
		});
		child.on("close", (code) => {
			if (terminating) {
				settle(pendingError, pendingQuota);
				return;
			}
			settle(new Error(`Codex app-server exited before replying (${code ?? "unknown"})${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
		});
		child.stdin.on("error", (error) => {
			if (!terminating) fail(`Unable to write to Codex app-server: ${error.message}`);
		});
		options.signal?.addEventListener("abort", onAbort, { once: true });

		if (options.signal?.aborted) {
			onAbort();
			return;
		}
		send({
			method: "initialize",
			id: 1,
			params: {
				clientInfo: {
					name: "pi_statusline",
					title: "Pi statusline",
					version: "1.0.0",
				},
			},
		});
	});
}
