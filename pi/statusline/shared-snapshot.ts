/**
 * Host-shared account-quota snapshots: concurrent Pi footers on one host reuse
 * one lookup per source per interval instead of each polling the CLI.
 *
 * Wraps a SnapshotCache load. The cache file holds the parsed snapshot (usage
 * percentages and reset times), a cooldown after a failed lookup and a
 * non-identifying digest; never credentials, account identifiers or raw output.
 */

import { createHash, randomBytes } from "node:crypto";
import { accessSync, constants, lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { lstat, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const SCHEMA_VERSION = 1;
/** A lookup is hard-timeout-bounded, so a lock older than timeout plus this is abandoned. */
const LOCK_GRACE_MS = 30_000;
const CLOCK_SKEW_MS = 60_000;

export interface SharedSnapshotOptions<T> {
	/** Undefined disables sharing: the wrapped load runs as before. */
	directory: string | undefined;
	source: string;
	/** Non-identifying account/CLI digest; undefined disables sharing for that refresh. */
	identity: () => string | undefined;
	refreshMs: number;
	timeoutMs: number;
	load: (signal: AbortSignal) => Promise<T>;
	/** Validates a persisted snapshot; undefined is a miss. */
	parse: (value: unknown) => T | undefined;
	/** Builds the source's own error type so callers' instanceof checks still hold. */
	error: (message: string) => Error;
	/** Whether other sessions should back off after this failure; default true. */
	shareFailure?: (error: unknown) => boolean;
	now?: () => number;
	pollMs?: number;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function privateDirectory(directory: string, uid: number): boolean {
	try {
		const stat = lstatSync(directory);
		return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o077) === 0;
	} catch {
		return false;
	}
}

function ensurePrivateDirectory(directory: string, uid: number): boolean {
	try {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
	} catch {
		return false;
	}
	return privateDirectory(directory, uid);
}

/**
 * The private per-user cache directory, or undefined when sharing is disabled or
 * no safe directory exists. Prefers the login runtime directory; falls back to
 * the cache home. A caller-supplied directory is used only when private.
 */
export function quotaCacheDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (env.PI_STATUSLINE_QUOTA_CACHE === "0") return undefined;
	const uid = process.getuid?.();
	if (uid === undefined) return undefined;
	const override = env.PI_STATUSLINE_QUOTA_CACHE_DIR?.trim();
	if (override) return isAbsolute(override) && ensurePrivateDirectory(override, uid) ? override : undefined;
	const runtime = env.XDG_RUNTIME_DIR?.trim();
	const candidates = [
		runtime && privateDirectory(runtime, uid) ? join(runtime, "pi-statusline") : undefined,
		join(env.XDG_CACHE_HOME?.trim() || join(homedir(), ".cache"), "pi-statusline"),
	];
	return candidates.find((candidate) => candidate !== undefined && ensurePrivateDirectory(candidate, uid));
}

export interface IdentityParts {
	source: string;
	configDirectory: string;
	/** Stat metadata only; the file is never read. */
	credentialFile: string;
	/** Command name resolved on PATH, or a path. */
	executable: string;
	/** Environment variables that redirect authentication; any present disables sharing. */
	overrides: readonly string[];
	env?: NodeJS.ProcessEnv;
}

function fingerprint(path: string): unknown {
	try {
		const stat = statSync(path);
		return [realpathSync(path), stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
	} catch {
		return "absent";
	}
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | undefined {
	if (command.includes("/")) return command;
	for (const entry of (env.PATH ?? "").split(delimiter)) {
		if (!entry) continue;
		const candidate = join(entry, command);
		try {
			accessSync(candidate, constants.X_OK);
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			// Try the next PATH entry.
		}
	}
	return undefined;
}

/**
 * A SHA-256 digest of the uid, source, configuration directory, resolved CLI and
 * credential-file metadata. Any change (login, CLI upgrade, other config dir)
 * produces a new digest and a cache miss. Only the digest is ever persisted.
 */
export function identityDigest(parts: IdentityParts): string | undefined {
	const env = parts.env ?? process.env;
	if (parts.overrides.some((name) => env[name])) return undefined;
	const uid = process.getuid?.();
	if (uid === undefined) return undefined;
	const executable = resolveExecutable(parts.executable, env);
	let configDirectory: string;
	try {
		configDirectory = realpathSync(parts.configDirectory);
	} catch {
		configDirectory = parts.configDirectory;
	}
	return createHash("sha256")
		.update(JSON.stringify([uid, parts.source, configDirectory, executable ? fingerprint(executable) : "absent", fingerprint(parts.credentialFile)]))
		.digest("hex");
}

interface LockHolder {
	pid: number;
	startedAtMs: number;
	token: string;
}

function parseLock(raw: string): LockHolder | undefined {
	try {
		const holder = asObject(JSON.parse(raw));
		return holder && typeof holder.pid === "number" && typeof holder.startedAtMs === "number" && typeof holder.token === "string"
			? { pid: holder.pid, startedAtMs: holder.startedAtMs, token: holder.token }
			: undefined;
	} catch {
		return undefined;
	}
}

class SharedEntry<T> {
	private readonly options: SharedSnapshotOptions<T>;
	private readonly key: string;
	private readonly uid: number;
	private readonly file: string;
	private readonly lock: string;

	constructor(options: SharedSnapshotOptions<T>, directory: string, key: string, uid: number) {
		this.options = options;
		this.key = key;
		this.uid = uid;
		this.file = join(directory, `${options.source}-${key.slice(0, 32)}.json`);
		this.lock = `${this.file}.lock`;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	async load(signal: AbortSignal): Promise<T> {
		const { options } = this;
		const deadline = this.now() + 2 * (options.timeoutMs + LOCK_GRACE_MS);
		let token: string | "unavailable" | undefined;
		while (!token) {
			if (signal.aborted) throw options.error(`Shared ${options.source} quota lookup aborted`);
			const cached = await this.read();
			if (cached.value !== undefined) return cached.value;
			if (cached.cooldown) throw options.error(`A recent shared ${options.source} quota lookup failed; waiting before retrying.`);
			token = await this.tryLock();
			if (token === "unavailable") return options.load(signal);
			if (!token) {
				if (this.now() >= deadline) throw options.error(`Another session's ${options.source} quota lookup did not finish; retrying later.`);
				await sleep(options.pollMs ?? 250);
			}
		}
		try {
			const cached = await this.read();
			if (cached.value !== undefined) return cached.value;
			if (cached.cooldown) throw options.error(`A recent shared ${options.source} quota lookup failed; waiting before retrying.`);
			let value: T;
			try {
				value = await options.load(signal);
			} catch (error) {
				if (!signal.aborted && (options.shareFailure?.(error) ?? true)) await this.publish({ cooldown: { untilMs: this.now() + options.refreshMs } });
				throw error;
			}
			if (!signal.aborted) await this.publish({ fetchedAtMs: this.now(), value });
			return value;
		} finally {
			await this.release(token);
		}
	}

	private async read(): Promise<{ value?: T; cooldown?: true }> {
		let raw: string;
		try {
			const stat = await lstat(this.file);
			if (!stat.isFile() || stat.uid !== this.uid || (stat.mode & 0o077) !== 0) return {};
			raw = await readFile(this.file, "utf8");
		} catch {
			return {};
		}
		let file: JsonObject | undefined;
		try {
			file = asObject(JSON.parse(raw));
		} catch {
			return {};
		}
		if (!file || file.v !== SCHEMA_VERSION || file.source !== this.options.source || file.key !== this.key) return {};
		const now = this.now();
		const result: { value?: T; cooldown?: true } = {};
		const fetchedAtMs = file.fetchedAtMs;
		if (typeof fetchedAtMs === "number" && fetchedAtMs <= now + CLOCK_SKEW_MS && now - fetchedAtMs < this.options.refreshMs) {
			const value = this.options.parse(file.value);
			if (value !== undefined) result.value = value;
		}
		const untilMs = asObject(file.cooldown)?.untilMs;
		if (typeof untilMs === "number" && untilMs > now && untilMs <= now + this.options.refreshMs + CLOCK_SKEW_MS) result.cooldown = true;
		return result;
	}

	/** Unique temp file plus rename; a concurrent publisher only ever replaces valid data with valid data. */
	private async publish(body: { fetchedAtMs: number; value: T } | { cooldown: { untilMs: number } }): Promise<void> {
		const temp = `${this.file}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
		try {
			await writeFile(temp, JSON.stringify({ v: SCHEMA_VERSION, source: this.options.source, key: this.key, ...body }), { mode: 0o600 });
			await rename(temp, this.file);
		} catch {
			await rm(temp, { force: true });
		}
	}

	private async tryLock(retryAfterReclaim = true): Promise<string | "unavailable" | undefined> {
		const token = `${process.pid}-${randomBytes(8).toString("hex")}`;
		try {
			const handle = await open(this.lock, "wx", 0o600);
			try {
				await handle.writeFile(JSON.stringify({ pid: process.pid, startedAtMs: this.now(), token } satisfies LockHolder));
			} finally {
				await handle.close();
			}
			return token;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") return "unavailable";
			if (await this.reclaimIfStale() && retryAfterReclaim) return this.tryLock(false);
			return undefined;
		}
	}

	/**
	 * Only a dead holder or an impossibly old lock is reclaimed. The lock is first
	 * renamed to a unique name, so concurrent reclaimers cannot delete a lock that
	 * a new holder created in the meantime.
	 */
	private async reclaimIfStale(): Promise<boolean> {
		let raw: string;
		let mtimeMs: number;
		try {
			mtimeMs = (await lstat(this.lock)).mtimeMs;
			raw = await readFile(this.lock, "utf8");
		} catch {
			return false;
		}
		const holder = parseLock(raw);
		const ageMs = this.now() - (holder?.startedAtMs ?? mtimeMs);
		const dead = holder !== undefined && !processAlive(holder.pid);
		if (!dead && ageMs <= this.options.timeoutMs + LOCK_GRACE_MS) return false;
		const reclaimed = `${this.lock}.stale-${randomBytes(4).toString("hex")}`;
		try {
			await rename(this.lock, reclaimed);
		} catch {
			return false;
		}
		let current: string | undefined;
		try {
			current = await readFile(reclaimed, "utf8");
		} catch {
			return false;
		}
		if (current === raw) {
			await rm(reclaimed, { force: true });
			return true;
		}
		await rename(reclaimed, this.lock).catch(() => {});
		return false;
	}

	private async release(token: string): Promise<void> {
		try {
			if (parseLock(await readFile(this.lock, "utf8"))?.token === token) await rm(this.lock, { force: true });
		} catch {
			// Already reclaimed or released.
		}
	}
}

/** Wraps a SnapshotCache load so concurrent footers share one lookup and its result. */
export function sharedLoad<T>(options: SharedSnapshotOptions<T>): (signal: AbortSignal) => Promise<T> {
	return (signal) => {
		const uid = process.getuid?.();
		const key = options.directory && uid !== undefined ? options.identity() : undefined;
		if (!options.directory || uid === undefined || !key) return options.load(signal);
		return new SharedEntry(options, options.directory, key, uid).load(signal);
	};
}
