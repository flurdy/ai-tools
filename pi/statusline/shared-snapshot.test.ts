import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { identityDigest, quotaCacheDirectory, sharedLoad, type SharedSnapshotOptions } from "./shared-snapshot.ts";

type Snapshot = { n: number };
type Pending = { resolve(value: Snapshot): void; reject(error: Error): void; signal: AbortSignal };

class SourceError extends Error {}

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-shared-snapshot-"));
	try {
		await run(directory);
	} finally {
		await chmod(directory, 0o700).catch(() => {});
		await rm(directory, { recursive: true, force: true });
	}
}

function harness(directory: string | undefined, overrides: Partial<SharedSnapshotOptions<Snapshot>> = {}) {
	let now = 1_000_000;
	const loads: Pending[] = [];
	const options: SharedSnapshotOptions<Snapshot> = {
		directory,
		source: "test",
		identity: () => "a".repeat(64),
		refreshMs: 1000,
		timeoutMs: 100,
		load: (signal) => new Promise((resolve, reject) => loads.push({ resolve, reject, signal })),
		parse: (value) => {
			const n = (value as { n?: unknown } | null)?.n;
			return typeof n === "number" ? { n } : undefined;
		},
		error: (message) => new SourceError(message),
		now: () => now,
		pollMs: 2,
		...overrides,
	};
	const load = sharedLoad(options);
	return {
		loads,
		advance: (ms: number) => { now += ms; },
		now: () => now,
		load: (signal = new AbortController().signal) => load(signal),
		/** Lets the wrapper reach its lookup (file and lock I/O first), then answers the latest one. */
		async settle(value: Snapshot) {
			await new Promise((resolve) => setTimeout(resolve, 10));
			loads[loads.length - 1].resolve(value);
		},
	};
}

async function cacheFiles(directory: string): Promise<string[]> {
	return (await readdir(directory)).sort();
}

test("shares one lookup and its result; a stale entry is looked up again", () => withDirectory(async (directory) => {
	const h = harness(directory);
	const first = h.load();
	await h.settle({ n: 1 });
	assert.deepEqual(await first, { n: 1 });
	assert.deepEqual(await h.load(), { n: 1 });
	assert.equal(h.loads.length, 1);
	const [file] = await cacheFiles(directory);
	assert.match(file, /^test-a{32}\.json$/);
	assert.equal((await lstat(join(directory, file))).mode & 0o777, 0o600);
	assert.doesNotMatch(await readFile(join(directory, file), "utf8"), /lock|token|pid/);

	h.advance(1000);
	const second = h.load();
	await h.settle({ n: 2 });
	assert.deepEqual(await second, { n: 2 });
	assert.equal(h.loads.length, 2);
	assert.deepEqual(await cacheFiles(directory), [file]);
}));

test("a waiter reuses the holder's result instead of looking up itself", () => withDirectory(async (directory) => {
	const a = harness(directory);
	const b = harness(directory);
	const first = a.load();
	await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(a.loads.length, 1);
	const second = b.load();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(b.loads.length, 0);
	a.loads[0].resolve({ n: 7 });
	assert.deepEqual(await first, { n: 7 });
	assert.deepEqual(await second, { n: 7 });
	assert.equal(b.loads.length, 0);
}));

test("reclaims a dead holder's lock and an abandoned lock, but never a live one", () => withDirectory(async (directory) => {
	const h = harness(directory);
	const lock = join(directory, `test-${"a".repeat(32)}.json.lock`);
	await writeFile(lock, JSON.stringify({ pid: 2 ** 22 - 1, startedAtMs: h.now(), token: "dead" }));
	const dead = h.load();
	await h.settle({ n: 1 });
	assert.deepEqual(await dead, { n: 1 });

	h.advance(1000);
	await writeFile(lock, JSON.stringify({ pid: process.pid, startedAtMs: h.now() - 200_000, token: "old" }));
	const abandoned = h.load();
	await h.settle({ n: 2 });
	assert.deepEqual(await abandoned, { n: 2 });

	h.advance(1000);
	await writeFile(lock, JSON.stringify({ pid: process.pid, startedAtMs: h.now(), token: "live" }));
	const blocked = h.load();
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(h.loads.length, 2);
	assert.equal(JSON.parse(await readFile(lock, "utf8")).token, "live");
	h.advance(200_000);
	await h.settle({ n: 3 });
	assert.deepEqual(await blocked, { n: 3 });

	h.advance(1000);
	await rm(lock, { force: true });
	await mkdir(lock);
	const unreclaimable = h.load();
	await new Promise((resolve) => setTimeout(resolve, 20));
	h.advance(10 * 60_000);
	await assert.rejects(unreclaimable, (error) => error instanceof SourceError && /did not finish/.test(error.message));
	assert.equal(h.loads.length, 3);
}));

test("concurrent reclaimers of one stale lock produce one lookup", () => withDirectory(async (directory) => {
	const lock = join(directory, `test-${"a".repeat(32)}.json.lock`);
	await writeFile(lock, JSON.stringify({ pid: 2 ** 22 - 1, startedAtMs: 0, token: "dead" }));
	const a = harness(directory);
	const b = harness(directory);
	const results = Promise.all([a.load(), b.load()]);
	await new Promise((resolve) => setTimeout(resolve, 20));
	assert.equal(a.loads.length + b.loads.length, 1);
	(a.loads[0] ?? b.loads[0]).resolve({ n: 3 });
	assert.deepEqual(await results, [{ n: 3 }, { n: 3 }]);
	assert.deepEqual(await cacheFiles(directory), [`test-${"a".repeat(32)}.json`]);
}));

test("malformed, foreign, old-schema, future and non-private entries are misses", () => withDirectory(async (directory) => {
	const h = harness(directory);
	const file = join(directory, `test-${"a".repeat(32)}.json`);
	const entry = (patch: Record<string, unknown>) => JSON.stringify({ v: 1, source: "test", key: "a".repeat(64), fetchedAtMs: h.now(), value: { n: 9 }, ...patch });
	for (const content of [
		"{not json",
		entry({ source: "other" }),
		entry({ key: "b".repeat(64) }),
		entry({ v: 2 }),
		entry({ fetchedAtMs: h.now() + 120_000 }),
		entry({ value: { n: "nine" } }),
	]) {
		await writeFile(file, content, { mode: 0o600 });
		const load = h.load();
		await h.settle({ n: 1 });
		assert.deepEqual(await load, { n: 1 }, content);
		await rm(file);
	}
	await writeFile(file, entry({}), { mode: 0o644 });
	const load = h.load();
	await h.settle({ n: 1 });
	assert.deepEqual(await load, { n: 1 });
	assert.equal((await lstat(file)).mode & 0o777, 0o600);
}));

test("falls back to a plain lookup without sharing or an unwritable directory", async () => {
	const h = harness(undefined);
	const load = h.load();
	await h.settle({ n: 1 });
	assert.deepEqual(await load, { n: 1 });
	await withDirectory(async (directory) => {
		await chmod(directory, 0o500);
		const unwritable = harness(directory);
		const first = unwritable.load();
		await unwritable.settle({ n: 2 });
		assert.deepEqual(await first, { n: 2 });
		const second = unwritable.load();
		await unwritable.settle({ n: 3 });
		assert.deepEqual(await second, { n: 3 });
		assert.deepEqual(await cacheFiles(directory), []);
	});
	const disabled = harness("/nonexistent/pi-shared-snapshot", { identity: () => undefined });
	const plain = disabled.load();
	await disabled.settle({ n: 4 });
	assert.deepEqual(await plain, { n: 4 });
});

test("a failed lookup cools other sessions down for one interval without a lookup", () => withDirectory(async (directory) => {
	const a = harness(directory);
	const b = harness(directory);
	const failed = a.load();
	await new Promise((resolve) => setTimeout(resolve, 10));
	a.loads[0].reject(new Error("offline"));
	await assert.rejects(failed, /offline/);
	await assert.rejects(b.load(), (error) => error instanceof SourceError && /failed; waiting/.test(error.message));
	assert.equal(b.loads.length, 0);
	b.advance(1000);
	const retry = b.load();
	await b.settle({ n: 1 });
	assert.deepEqual(await retry, { n: 1 });

	a.advance(2000);
	const local = harness(directory, { now: a.now, shareFailure: () => false });
	const localFailure = local.load();
	await new Promise((resolve) => setTimeout(resolve, 10));
	local.loads[0].reject(new Error("missing"));
	await assert.rejects(localFailure, /missing/);
	b.advance(1000);
	const unaffected = b.load();
	await b.settle({ n: 2 });
	assert.deepEqual(await unaffected, { n: 2 });
}));

test("an aborted lookup publishes nothing and releases the lock", () => withDirectory(async (directory) => {
	const h = harness(directory);
	const controller = new AbortController();
	const aborted = h.load(controller.signal);
	await new Promise((resolve) => setTimeout(resolve, 10));
	controller.abort();
	h.loads[0].reject(new Error("aborted"));
	await assert.rejects(aborted, /aborted/);
	assert.deepEqual(await cacheFiles(directory), []);
	const next = h.load();
	await h.settle({ n: 1 });
	assert.deepEqual(await next, { n: 1 });
	await assert.rejects(h.load(AbortSignal.abort()), (error) => error instanceof SourceError && /aborted/.test(error.message));
}));

test("three processes starting together share one lookup", () => withDirectory(async (directory) => {
	const child = join(directory, "child.ts");
	const log = join(directory, "lookups");
	const cache = join(directory, "cache");
	await writeFile(child, `
import { appendFileSync } from "node:fs";
import { sharedLoad } from ${JSON.stringify(new URL("./shared-snapshot.ts", import.meta.url).href)};
const load = sharedLoad({
	directory: ${JSON.stringify(cache)}, source: "multi", identity: () => "c".repeat(64), refreshMs: 60_000, timeoutMs: 2000,
	load: async () => { appendFileSync(${JSON.stringify(log)}, process.pid + "\\n"); await new Promise((r) => setTimeout(r, 150)); return { n: 42 }; },
	parse: (value) => typeof value?.n === "number" ? value : undefined, error: (message) => new Error(message), pollMs: 10,
});
const value = await load(new AbortController().signal);
process.stdout.write(JSON.stringify(value));
`);
	await mkdir(cache, { mode: 0o700 });
	const outputs = await Promise.all([0, 1, 2].map(() => new Promise<string>((resolve, reject) => {
		const proc = spawn(process.execPath, ["--no-warnings", child], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		proc.stdout.on("data", (chunk) => { out += chunk; });
		proc.stderr.on("data", (chunk) => { err += chunk; });
		proc.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`child exited ${code}: ${err}`))));
	})));
	assert.deepEqual(outputs.map((out) => JSON.parse(out)), [{ n: 42 }, { n: 42 }, { n: 42 }]);
	assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);
	assert.deepEqual(await cacheFiles(cache), [`multi-${"c".repeat(32)}.json`]);
}));

test("identity digests change with credentials, config and CLI, and vanish under auth overrides", () => withDirectory(async (directory) => {
	const bin = join(directory, "bin");
	await mkdir(bin);
	await writeFile(join(bin, "tool"), "#!/bin/sh\n", { mode: 0o700 });
	const config = join(directory, "config");
	await mkdir(config);
	const credential = join(config, "credentials.json");
	const env = { PATH: bin } as NodeJS.ProcessEnv;
	const parts = { source: "test", configDirectory: config, credentialFile: credential, executable: "tool", overrides: ["TEST_API_KEY"], env };
	const digest = identityDigest(parts);
	assert.match(digest ?? "", /^[0-9a-f]{64}$/);
	assert.equal(identityDigest(parts), digest);
	await writeFile(credential, "secret", { mode: 0o600 });
	const withCredential = identityDigest(parts);
	assert.notEqual(withCredential, digest);
	assert.equal(identityDigest({ ...parts, configDirectory: directory }) === withCredential, false);
	await writeFile(join(bin, "tool"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	assert.notEqual(identityDigest(parts), withCredential);
	assert.equal(identityDigest({ ...parts, env: { ...env, TEST_API_KEY: "x" } }), undefined);
	assert.notEqual(identityDigest({ ...parts, executable: "missing" }), undefined);
}));

test("chooses a private runtime or cache directory and refuses unsafe ones", () => withDirectory(async (directory) => {
	assert.equal(quotaCacheDirectory({ PI_STATUSLINE_QUOTA_CACHE: "0" }), undefined);
	assert.equal(quotaCacheDirectory({ PI_STATUSLINE_QUOTA_CACHE_DIR: "relative/path" }), undefined);
	const override = join(directory, "override");
	assert.equal(quotaCacheDirectory({ PI_STATUSLINE_QUOTA_CACHE_DIR: override }), override);
	assert.equal((await lstat(override)).mode & 0o777, 0o700);

	const runtime = join(directory, "runtime");
	const cacheHome = join(directory, "cache-home");
	await mkdir(runtime, { mode: 0o700 });
	assert.equal(quotaCacheDirectory({ XDG_RUNTIME_DIR: runtime, XDG_CACHE_HOME: cacheHome }), join(runtime, "pi-statusline"));
	await chmod(runtime, 0o755);
	assert.equal(quotaCacheDirectory({ XDG_RUNTIME_DIR: runtime, XDG_CACHE_HOME: cacheHome }), join(cacheHome, "pi-statusline"));
	await symlink(runtime, join(directory, "link"));
	assert.equal(quotaCacheDirectory({ PI_STATUSLINE_QUOTA_CACHE_DIR: join(directory, "link") }), undefined);
	await chmod(join(cacheHome, "pi-statusline"), 0o750);
	assert.equal(quotaCacheDirectory({ XDG_RUNTIME_DIR: runtime, XDG_CACHE_HOME: cacheHome }), undefined);
}));
