import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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

export interface LeaseExecOptions {
	timeoutMs: number;
}

export interface LeaseCommandResult {
	code: number | null;
	stdout: string;
	stderr: string;
	error?: NodeJS.ErrnoException & { killed?: boolean; signal?: string };
}

export type LeaseExec = (command: string, args: string[], options: LeaseExecOptions) => Promise<LeaseCommandResult>;

export interface AcquireWorktreeLeaseOptions {
	runtimeDir?: string;
	flockCommand?: string;
	gitCommand?: string;
	gitTimeoutMs?: number;
	exec?: LeaseExec;
	sessionId?: string;
	readyTimeoutMs?: number;
	writeMetadata?(path: string, contents: string): Promise<void>;
}

function defaultExec(command: string, args: string[], options: LeaseExecOptions): Promise<LeaseCommandResult> {
	return new Promise((resolve) => {
		const child = execFile(command, args, {
			encoding: "utf8",
			timeout: options.timeoutMs,
			windowsHide: true,
		}, (error, stdout, stderr) => {
			resolve({
				code: typeof error?.code === "number" ? error.code : child.exitCode,
				stdout,
				stderr,
				...(error ? { error: error as NodeJS.ErrnoException } : {}),
			});
		});
	});
}

export function lockIdentity(root: string): string {
	return createHash("sha256").update(root).digest("hex");
}

export function worktreeLeaseRuntimeDir(): string {
	return join(process.env.XDG_RUNTIME_DIR || tmpdir(), `pi-session-guard-${process.getuid?.() ?? "user"}`);
}

export function worktreeLeaseLockPath(root: string, runtimeDir = worktreeLeaseRuntimeDir()): string {
	return join(runtimeDir, `${lockIdentity(root)}.lock`);
}

async function resolveGitRoot(
	cwd: string,
	options: AcquireWorktreeLeaseOptions,
): Promise<{ root: string } | { reason: "non-git" | "git-unavailable"; detail?: string }> {
	const configuredTimeoutMs = options.gitTimeoutMs ?? 2000;
	const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : 2000;
	let result: LeaseCommandResult;
	try {
		result = await (options.exec ?? defaultExec)(
			options.gitCommand ?? "git",
			["-C", cwd, "rev-parse", "--show-toplevel"],
			{ timeoutMs },
		);
	} catch (error) {
		return { reason: "git-unavailable", detail: error instanceof Error ? error.message : String(error) };
	}
	if (result.error?.code === "ENOENT") return { reason: "git-unavailable" };
	if (result.error?.killed && result.error.signal === "SIGTERM") {
		return { reason: "git-unavailable", detail: `git root lookup timed out after ${timeoutMs}ms` };
	}
	if (result.code !== 0) {
		if (result.code === 128) return { reason: "non-git" };
		return { reason: "git-unavailable", detail: result.stderr.trim() || result.error?.message || `git exited ${result.code}` };
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

export async function acquireWorktreeLease(
	cwd: string,
	options: AcquireWorktreeLeaseOptions = {},
): Promise<WorktreeLeaseResult> {
	const resolved = await resolveGitRoot(cwd, options);
	if (!("root" in resolved)) return { kind: "unguarded", ...resolved };

	const runtimeDir = options.runtimeDir ?? worktreeLeaseRuntimeDir();
	try {
		await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
		await chmod(runtimeDir, 0o700);
	} catch (error) {
		return { kind: "unguarded", reason: "lease-error", detail: error instanceof Error ? error.message : String(error) };
	}

	const identity = lockIdentity(resolved.root);
	const lockPath = worktreeLeaseLockPath(resolved.root, runtimeDir);
	const metadataPath = join(runtimeDir, `${identity}.json`);
	const metadataTempPath = `${metadataPath}.${randomUUID()}.tmp`;
	const flockCommand = options.flockCommand ?? "flock";
	const sessionId = options.sessionId ?? process.env.PI_SESSION_ID ?? `pid-${process.pid}`;
	const writeMetadata = options.writeMetadata
		?? ((path: string, contents: string) => writeFile(path, contents, { mode: 0o600 }));
	const holderScript = 'if ! IFS= read -r command || [ "$command" != publish ]; then rm -f -- "$1"; exit 70; fi; mv -f -- "$1" "$2" || exit 71; printf "ready\\n"; exec cat >/dev/null';
	const child = spawn(
		flockCommand,
		["-n", "-F", "-E", "75", lockPath, "sh", "-c", holderScript, "pi-session-guard", metadataTempPath, metadataPath],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);

	return new Promise<WorktreeLeaseResult>((resolve) => {
		let output = "";
		let errorOutput = "";
		let holderPid: number | undefined;
		let phase: "acquiring" | "held" | "finished" = "acquiring";
		let releasing = false;
		let lostResolve: (() => void) | undefined;
		const lost = new Promise<void>((done) => (lostResolve = done));
		const cleanupTemp = () => void unlink(metadataTempPath).catch(() => undefined);
		const readyTimer = setTimeout(() => {
			if (phase !== "acquiring") return;
			phase = "finished";
			cleanupTemp();
			child.kill("SIGKILL");
			resolve({ kind: "unguarded", reason: "lease-error", detail: "flock ready handshake timed out" });
		}, options.readyTimeoutMs ?? 2000);

		child.stdin.on("error", () => undefined);
		child.stderr.on("data", (chunk) => (errorOutput += String(chunk)));
		child.once("spawn", () => {
			// spawn precedes stdout data; flock -F and exec keep this PID as the lock holder.
			holderPid = child.pid!;
			const metadata: LeaseHolderMetadata = {
				root: resolved.root,
				pid: holderPid,
				parentPid: process.pid,
				sessionId,
				startedAt: new Date().toISOString(),
			};
			void writeMetadata(metadataTempPath, `${JSON.stringify(metadata)}\n`)
				.then(() => {
					if (phase !== "acquiring") {
						cleanupTemp();
						return;
					}
					child.stdin.write("publish\n");
				})
				.catch((error) => {
					cleanupTemp();
					if (phase !== "acquiring") return;
					phase = "finished";
					clearTimeout(readyTimer);
					child.kill("SIGKILL");
					resolve({ kind: "unguarded", reason: "lease-error", detail: error instanceof Error ? error.message : String(error) });
				});
		});
		child.once("error", (error: NodeJS.ErrnoException) => {
			if (phase !== "acquiring") return;
			phase = "finished";
			cleanupTemp();
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
			cleanupTemp();
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
			let releasePromise: Promise<void> | undefined;
			resolve({
				kind: "held",
				root: resolved.root,
				holderPid: holderPid!,
				lost,
				release() {
					if (releasePromise) return releasePromise;
					releasing = true;
					releasePromise = new Promise<void>((done) => {
						if (phase === "finished") {
							done();
							return;
						}
						child.once("close", done);
						child.stdin.end();
					});
					return releasePromise;
				},
			});
		});
	});
}
