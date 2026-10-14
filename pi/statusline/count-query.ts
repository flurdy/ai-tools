import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface CountQueryOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

// Shape preflight only; project-workspace remains the topology validator.
export function isProjectWorkspaceRoot(root: string): boolean {
	return [".git", ".beads", "workspace.json", "README.md", "AGENTS.md", "Makefile", "repos", "infrastructure"].every((path) =>
		existsSync(join(root, path)),
	);
}

export function runCountCommand(command: string, root: string, args: string[], options: CountQueryOptions, label = "Count query"): Promise<string> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error(`${label} aborted`));
			return;
		}

		const timeoutMs = options.timeoutMs ?? 2000;
		let settled = false;
		let terminatingError: Error | undefined;
		let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const processGroup = process.platform !== "win32";
		const child = spawn(command, args, {
			cwd: root,
			windowsHide: true,
			detached: processGroup,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stdoutBytes = 0;
		function settle(error?: Error, stdout?: string) {
			if (settled) return;
			settled = true;
			// A collector can exit before its descendants, including with closed pipes.
			kill("SIGKILL");
			if (timeout) clearTimeout(timeout);
			if (forceKillTimeout) clearTimeout(forceKillTimeout);
			options.signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve(stdout ?? "");
		}
		function kill(signal: NodeJS.Signals) {
			if (child.pid === undefined) return;
			try {
				if (processGroup) process.kill(-child.pid, signal);
				else if (child.exitCode === null) child.kill(signal);
			} catch {}
		}
		function terminate(error: Error) {
			if (terminatingError) return;
			terminatingError = error;
			kill("SIGTERM");
			forceKillTimeout = setTimeout(() => {
				kill("SIGKILL");
				child.stdout?.destroy();
				child.stderr?.destroy();
			}, 100);
		}
		function onAbort() {
			terminate(new Error(`${label} aborted`));
		}
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (terminatingError) return;
			stdoutBytes += Buffer.byteLength(chunk);
			if (stdoutBytes > 1024 * 1024) terminate(new Error(`${label} exceeded output limit`));
			else stdout += chunk;
		});
		child.stderr.resume();
		child.on("error", (error) => settle(terminatingError ?? error));
		child.on("close", (code, signal) => settle(
			terminatingError ?? (code === 0 ? undefined : new Error(`${label} failed (${signal ?? code})`)),
			stdout,
		));
		timeout = setTimeout(() => terminate(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
	});
}
