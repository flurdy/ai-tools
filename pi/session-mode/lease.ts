import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface LeaseHolderMetadata {
	root: string;
	pid: number;
	parentPid: number;
	sessionId: string;
	startedAt: string;
}

export interface HeldWorktreeLease {
	kind: "held";
	root: string;
	holderPid: number;
	lost: Promise<void>;
	release(): Promise<void>;
}

export type WorktreeLeaseResult =
	| HeldWorktreeLease
	| { kind: "contended"; root: string; holder?: LeaseHolderMetadata }
	| { kind: "unguarded"; reason: "non-git" | "git-unavailable" | "flock-unavailable" | "lease-error"; detail?: string };

export interface AcquireWorktreeLeaseOptions {
	runtimeDir?: string;
	flockCommand?: string;
	sessionId?: string;
	readyTimeoutMs?: number;
}

interface CommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
	error?: NodeJS.ErrnoException;
}

function run(command: string, args: string[]): Promise<CommandResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let error: NodeJS.ErrnoException | undefined;
		child.stdout.on("data", (chunk) => (stdout += String(chunk)));
		child.stderr.on("data", (chunk) => (stderr += String(chunk)));
		child.once("error", (value) => (error = value as NodeJS.ErrnoException));
		child.once("close", (code) => resolve({ code, stdout, stderr, error }));
	});
}

export function lockIdentity(root: string): string {
	return createHash("sha256").update(root).digest("hex");
}

function defaultRuntimeDir(): string {
	return join(process.env.XDG_RUNTIME_DIR || tmpdir(), `pi-session-guard-${process.getuid?.() ?? "user"}`);
}

async function resolveGitRoot(cwd: string): Promise<{ root: string } | { reason: "non-git" | "git-unavailable"; detail?: string }> {
	const result = await run("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
	if (result.error?.code === "ENOENT") return { reason: "git-unavailable" };
	if (result.code !== 0) {
		if (result.code === 128) return { reason: "non-git" };
		return { reason: "git-unavailable", detail: result.stderr.trim() || `git exited ${result.code}` };
	}
	try {
		return { root: await realpath(result.stdout.trim()) };
	} catch (error) {
		return { reason: "git-unavailable", detail: error instanceof Error ? error.message : String(error) };
	}
}

async function readHolder(path: string): Promise<LeaseHolderMetadata | undefined> {
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as Partial<LeaseHolderMetadata>;
		if (
			typeof value.root === "string" &&
			typeof value.pid === "number" &&
			typeof value.parentPid === "number" &&
			typeof value.sessionId === "string" &&
			typeof value.startedAt === "string"
		) {
			return value as LeaseHolderMetadata;
		}
	} catch {
		// Diagnostic metadata is best effort and never establishes ownership.
	}
	return undefined;
}

async function unlinkOwnedMetadata(path: string, sessionId: string, pid: number): Promise<void> {
	const holder = await readHolder(path);
	if (holder?.sessionId !== sessionId || holder.pid !== pid) return;
	await unlink(path).catch(() => undefined);
}

export async function acquireWorktreeLease(
	cwd: string,
	options: AcquireWorktreeLeaseOptions = {},
): Promise<WorktreeLeaseResult> {
	const resolved = await resolveGitRoot(cwd);
	if (!("root" in resolved)) return { kind: "unguarded", ...resolved };

	const runtimeDir = options.runtimeDir ?? defaultRuntimeDir();
	try {
		await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
		await chmod(runtimeDir, 0o700);
	} catch (error) {
		return { kind: "unguarded", reason: "lease-error", detail: error instanceof Error ? error.message : String(error) };
	}

	const identity = lockIdentity(resolved.root);
	const lockPath = join(runtimeDir, `${identity}.lock`);
	const metadataPath = join(runtimeDir, `${identity}.json`);
	const flockCommand = options.flockCommand ?? "flock";
	const sessionId = options.sessionId ?? process.env.PI_SESSION_ID ?? `pid-${process.pid}`;
	const child = spawn(
		flockCommand,
		["-n", "-E", "75", lockPath, "sh", "-c", 'printf "ready\\n"; cat >/dev/null'],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);

	return new Promise<WorktreeLeaseResult>((resolve) => {
		let output = "";
		let errorOutput = "";
		let phase: "acquiring" | "held" | "finished" = "acquiring";
		let releasing = false;
		let lostResolve: (() => void) | undefined;
		const lost = new Promise<void>((done) => (lostResolve = done));
		const readyTimer = setTimeout(() => {
			if (phase !== "acquiring") return;
			phase = "finished";
			child.kill("SIGKILL");
			resolve({ kind: "unguarded", reason: "lease-error", detail: "flock ready handshake timed out" });
		}, options.readyTimeoutMs ?? 2000);

		child.stderr.on("data", (chunk) => (errorOutput += String(chunk)));
		child.once("error", (error: NodeJS.ErrnoException) => {
			if (phase !== "acquiring") return;
			phase = "finished";
			clearTimeout(readyTimer);
			resolve({
				kind: "unguarded",
				reason: error.code === "ENOENT" ? "flock-unavailable" : "lease-error",
				detail: error.message,
			});
		});

		child.once("close", (code) => {
			if (phase === "held") {
				phase = "finished";
				if (!releasing) lostResolve?.();
				return;
			}
			if (phase !== "acquiring") return;
			phase = "finished";
			clearTimeout(readyTimer);
			if (code === 75) {
				void readHolder(metadataPath).then((holder) => resolve({ kind: "contended", root: resolved.root, holder }));
				return;
			}
			resolve({
				kind: "unguarded",
				reason: "lease-error",
				detail: errorOutput.trim() || `flock exited before ready (${code ?? "signal"})`,
			});
		});

		child.stdout.on("data", (chunk) => {
			if (phase !== "acquiring") return;
			output += String(chunk);
			if (!output.includes("\n") || output.split("\n", 1)[0] !== "ready") return;
			phase = "held";
			clearTimeout(readyTimer);
			const holderPid = child.pid;
			if (holderPid === undefined) {
				phase = "finished";
				child.kill("SIGKILL");
				resolve({ kind: "unguarded", reason: "lease-error", detail: "flock process has no pid" });
				return;
			}
			const metadata: LeaseHolderMetadata = {
				root: resolved.root,
				pid: holderPid,
				parentPid: process.pid,
				sessionId,
				startedAt: new Date().toISOString(),
			};
			void writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 })
				.then(() => {
					let releasePromise: Promise<void> | undefined;
					resolve({
						kind: "held",
						root: resolved.root,
						holderPid,
						lost,
						release() {
							if (releasePromise) return releasePromise;
							releasing = true;
							releasePromise = new Promise<void>((done) => {
								if (phase === "finished") {
									void unlinkOwnedMetadata(metadataPath, sessionId, holderPid).finally(done);
									return;
								}
								child.once("close", () => void unlinkOwnedMetadata(metadataPath, sessionId, holderPid).finally(done));
								child.stdin.end();
							});
							return releasePromise;
						},
					});
				})
				.catch((error) => {
					releasing = true;
					child.stdin.end();
					resolve({ kind: "unguarded", reason: "lease-error", detail: error instanceof Error ? error.message : String(error) });
				});
		});
	});
}
