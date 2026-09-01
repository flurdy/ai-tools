import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { worktreeLeaseLockPath } from "./lease.ts";

export type WorktreeLeaseOccupancy =
	| { kind: "held" | "free"; root: string }
	| { kind: "unavailable"; reason: string };

export interface ProbeWorktreeLeaseOccupancyOptions {
	runtimeDir?: string;
	gitCommand?: string;
	lslocksCommand?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	selfPid?: number;
}

interface CommandOutput {
	stdout: string;
}

function runCommand(command: string, args: string[], options: ProbeWorktreeLeaseOccupancyOptions): Promise<CommandOutput> {
	return new Promise((resolve, reject) => {
		execFile(command, args, {
			encoding: "utf8",
			timeout: options.timeoutMs ?? 500,
			windowsHide: true,
			signal: options.signal,
		}, (error, stdout) => {
			if (error) reject(error);
			else resolve({ stdout });
		});
	});
}

interface LockObservation {
	held: boolean;
	holderPid?: number;
}

function observeLock(stdout: string, lockPath: string): LockObservation | undefined {
	try {
		const payload = JSON.parse(stdout) as { locks?: unknown };
		if (!Array.isArray(payload.locks)) return undefined;
		for (const value of payload.locks) {
			if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
			const lock = value as { path?: unknown; type?: unknown; mode?: unknown; pid?: unknown };
			if (lock.path !== lockPath || lock.type !== "FLOCK" || lock.mode !== "WRITE") continue;
			if (typeof lock.pid !== "number" || !Number.isSafeInteger(lock.pid) || lock.pid <= 0) return undefined;
			return { held: true, holderPid: lock.pid };
		}
		return { held: false };
	} catch {
		return undefined;
	}
}

async function processParentPid(pid: number, signal?: AbortSignal): Promise<number | undefined> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, { encoding: "utf8", signal });
		const commandEnd = stat.lastIndexOf(") ");
		if (commandEnd < 0) return undefined;
		const fields = stat.slice(commandEnd + 2).trim().split(/\s+/);
		const parentPid = Number(fields[1]);
		return Number.isSafeInteger(parentPid) && parentPid > 0 ? parentPid : undefined;
	} catch {
		return undefined;
	}
}

export async function probeWorktreeLeaseOccupancy(
	cwd: string,
	options: ProbeWorktreeLeaseOccupancyOptions = {},
): Promise<WorktreeLeaseOccupancy> {
	let root: string;
	try {
		const git = await runCommand(options.gitCommand ?? "git", ["-C", cwd, "rev-parse", "--show-toplevel"], options);
		root = await realpath(git.stdout.trim());
	} catch (error) {
		return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
	}

	let lockPath: string;
	try {
		lockPath = await realpath(worktreeLeaseLockPath(root, options.runtimeDir));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "free", root };
		return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
	}

	try {
		const locks = await runCommand(
			options.lslocksCommand ?? "lslocks",
			["--json", "--output", "PATH,TYPE,MODE,PID"],
			options,
		);
		const observation = observeLock(locks.stdout, lockPath);
		if (!observation) return { kind: "unavailable", reason: "lslocks returned an incompatible response" };
		if (!observation.held) return { kind: "free", root };
		const parentPid = await processParentPid(observation.holderPid!, options.signal);
		return parentPid === (options.selfPid ?? process.pid) ? { kind: "free", root } : { kind: "held", root };
	} catch (error) {
		return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
	}
}
