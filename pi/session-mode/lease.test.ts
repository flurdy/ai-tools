import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { acquireWorktreeLease, lockIdentity } from "./lease.ts";

async function gitRepo(): Promise<{ repo: string; runtimeDir: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "pi-session-mode-"));
	const repo = join(root, "repo");
	const runtimeDir = join(root, "runtime");
	await mkdir(repo);
	execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
	execFileSync("git", ["-C", repo, "config", "user.name", "Session Mode Test"]);
	execFileSync("git", ["-C", repo, "config", "user.email", "session-mode@example.com"]);
	await writeFile(join(repo, "README.md"), "fixture\n");
	execFileSync("git", ["-C", repo, "add", "README.md"]);
	execFileSync("git", ["-C", repo, "commit", "-qm", "fixture"]);
	return { repo, runtimeDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("uses one stable identity for canonical and symlinked worktree paths", async () => {
	const fixture = await gitRepo();
	try {
		const alias = join(fixture.repo, "..", "repo-link");
		await symlink(fixture.repo, alias);
		const canonical = await realpath(fixture.repo);
		assert.equal(lockIdentity(canonical), lockIdentity(await realpath(alias)));

		const first = await acquireWorktreeLease(fixture.repo, { runtimeDir: fixture.runtimeDir, sessionId: "first" });
		assert.equal(first.kind, "held");
		const second = await acquireWorktreeLease(alias, { runtimeDir: fixture.runtimeDir, sessionId: "second" });
		assert.equal(second.kind, "contended");
		if (second.kind === "contended") assert.equal(second.holder?.sessionId, "first");
		if (first.kind === "held") await first.release();
	} finally {
		await fixture.cleanup();
	}
});

test("rejects unsafe diagnostic holder pid values", async () => {
	const fixture = await gitRepo();
	try {
		const held = await acquireWorktreeLease(fixture.repo, { runtimeDir: fixture.runtimeDir, sessionId: "holder" });
		assert.equal(held.kind, "held");
		try {
			const root = await realpath(fixture.repo);
			const metadataPath = join(fixture.runtimeDir, `${lockIdentity(root)}.json`);
			for (const fields of [
				'"pid":1.5,"parentPid":1',
				'"pid":-1,"parentPid":1',
				'"pid":1e999,"parentPid":1',
				'"pid":1,"parentPid":1.5',
				'"pid":1,"parentPid":-1',
				'"pid":1,"parentPid":1e999',
			]) {
				await writeFile(metadataPath, `{"root":"${root}",${fields},"sessionId":"holder","startedAt":"now"}\n`);
				const contender = await acquireWorktreeLease(fixture.repo, { runtimeDir: fixture.runtimeDir, sessionId: "contender" });
				assert.equal(contender.kind, "contended");
				if (contender.kind === "contended") assert.equal(contender.holder, undefined);
			}
		} finally {
			if (held.kind === "held") await held.release();
		}
	} finally {
		await fixture.cleanup();
	}
});

test("releases the kernel lease when the holder exits", async () => {
	const fixture = await gitRepo();
	try {
		const first = await acquireWorktreeLease(fixture.repo, { runtimeDir: fixture.runtimeDir, sessionId: "first" });
		assert.equal(first.kind, "held");
		if (first.kind !== "held") return;

		process.kill(first.holderPid, "SIGKILL");
		await first.lost;

		const second = await acquireWorktreeLease(fixture.repo, { runtimeDir: fixture.runtimeDir, sessionId: "second" });
		assert.equal(second.kind, "held");
		if (second.kind === "held") await second.release();
	} finally {
		await fixture.cleanup();
	}
});

test("does not report held until the child completes the ready handshake", async () => {
	const fixture = await gitRepo();
	try {
		const wrapper = join(fixture.runtimeDir, "slow-flock");
		await mkdir(fixture.runtimeDir, { recursive: true });
		await writeFile(wrapper, "#!/bin/sh\nsleep 0.1\nexec flock \"$@\"\n");
		await chmod(wrapper, 0o700);
		let settled = false;
		const acquisition = acquireWorktreeLease(fixture.repo, {
			runtimeDir: fixture.runtimeDir,
			flockCommand: wrapper,
		}).then((result) => { settled = true; return result; });
		await delay(20);
		assert.equal(settled, false);
		const result = await acquisition;
		assert.equal(result.kind, "held");
		if (result.kind === "held") await result.release();
	} finally {
		await fixture.cleanup();
	}
});

test("fails open after a timed-out holder releases the kernel lease", async () => {
	const fixture = await gitRepo();
	try {
		const result = await acquireWorktreeLease(fixture.repo, {
			runtimeDir: fixture.runtimeDir,
			readyTimeoutMs: 50,
			writeMetadata: () => new Promise(() => undefined),
		});

		assert.equal(result.kind, "unguarded");
		if (result.kind === "unguarded") {
			assert.equal(result.reason, "lease-error");
			assert.match(result.detail ?? "", /ready handshake timed out/);
		}

		let replacement = await acquireWorktreeLease(fixture.repo, { runtimeDir: fixture.runtimeDir });
		for (let attempt = 0; replacement.kind === "contended" && attempt < 20; attempt += 1) {
			await delay(10);
			replacement = await acquireWorktreeLease(fixture.repo, { runtimeDir: fixture.runtimeDir });
		}
		assert.equal(replacement.kind, "held");
		if (replacement.kind === "held") await replacement.release();
	} finally {
		await fixture.cleanup();
	}
});

test("fails open when holder metadata cannot be written", async () => {
	const fixture = await gitRepo();
	try {
		const result = await acquireWorktreeLease(fixture.repo, {
			runtimeDir: fixture.runtimeDir,
			writeMetadata: async () => { throw new Error("metadata write refused"); },
		});

		assert.equal(result.kind, "unguarded");
		if (result.kind === "unguarded") {
			assert.equal(result.reason, "lease-error");
			assert.equal(result.detail, "metadata write refused");
		}

		let replacement = await acquireWorktreeLease(fixture.repo, { runtimeDir: fixture.runtimeDir });
		for (let attempt = 0; replacement.kind === "contended" && attempt < 20; attempt += 1) {
			await delay(10);
			replacement = await acquireWorktreeLease(fixture.repo, { runtimeDir: fixture.runtimeDir });
		}
		assert.equal(replacement.kind, "held");
		if (replacement.kind === "held") await replacement.release();
	} finally {
		await fixture.cleanup();
	}
});

test("does not report held when the holder exits during metadata persistence", async () => {
	const fixture = await gitRepo();
	try {
		await mkdir(fixture.runtimeDir, { recursive: true });
		const wrapper = join(fixture.runtimeDir, "exiting-flock");
		await writeFile(wrapper, "#!/bin/sh\nsleep 0.01\n");
		await chmod(wrapper, 0o700);

		let metadataStartedResolve: (() => void) | undefined;
		let metadataCompleteResolve: (() => void) | undefined;
		const metadataStarted = new Promise<void>((resolve) => (metadataStartedResolve = resolve));
		const metadataComplete = new Promise<void>((resolve) => (metadataCompleteResolve = resolve));
		const acquisition = acquireWorktreeLease(fixture.repo, {
			runtimeDir: fixture.runtimeDir,
			flockCommand: wrapper,
			async writeMetadata(path, contents) {
				await writeFile(path, contents, { mode: 0o600 });
				metadataStartedResolve?.();
				await metadataComplete;
			},
		});

		await metadataStarted;
		await delay(50);
		metadataCompleteResolve?.();
		const result = await acquisition;
		assert.equal(result.kind, "unguarded");
		if (result.kind === "unguarded") {
			assert.equal(result.reason, "lease-error");
			assert.match(result.detail ?? "", /exited before ready/);
		}
	} finally {
		await fixture.cleanup();
	}
});

test("an expired holder cannot overwrite newer holder metadata", async () => {
	const fixture = await gitRepo();
	try {
		await mkdir(fixture.runtimeDir, { recursive: true });
		const wrapper = join(fixture.runtimeDir, "exiting-flock");
		await writeFile(wrapper, "#!/bin/sh\nsleep 0.01\n");
		await chmod(wrapper, 0o700);

		let metadataStartedResolve: (() => void) | undefined;
		let metadataCompleteResolve: (() => void) | undefined;
		const metadataStarted = new Promise<void>((resolve) => (metadataStartedResolve = resolve));
		const metadataComplete = new Promise<void>((resolve) => (metadataCompleteResolve = resolve));
		const expiredAcquisition = acquireWorktreeLease(fixture.repo, {
			runtimeDir: fixture.runtimeDir,
			flockCommand: wrapper,
			sessionId: "expired",
			async writeMetadata(path, contents) {
				metadataStartedResolve?.();
				await metadataComplete;
				await writeFile(path, contents, { mode: 0o600 });
			},
		});

		await metadataStarted;
		await delay(50);
		const current = await acquireWorktreeLease(fixture.repo, {
			runtimeDir: fixture.runtimeDir,
			sessionId: "current",
		});
		assert.equal(current.kind, "held");

		metadataCompleteResolve?.();
		const expired = await expiredAcquisition;
		assert.equal(expired.kind, "unguarded");
		const root = await realpath(fixture.repo);
		const metadataPath = join(fixture.runtimeDir, `${lockIdentity(root)}.json`);
		const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as { sessionId?: string };
		assert.equal(metadata.sessionId, "current");
		if (current.kind === "held") await current.release();
	} finally {
		await fixture.cleanup();
	}
});

test("permits separate Git worktrees and reacquires after a clean release", async () => {
	const fixture = await gitRepo();
	try {
		const worktree = join(fixture.repo, "..", "other-worktree");
		execFileSync("git", ["-C", fixture.repo, "worktree", "add", "-q", "-b", "feature/test", worktree]);
		const main = await acquireWorktreeLease(fixture.repo, { runtimeDir: fixture.runtimeDir, sessionId: "main" });
		const other = await acquireWorktreeLease(worktree, { runtimeDir: fixture.runtimeDir, sessionId: "other" });
		assert.equal(main.kind, "held");
		assert.equal(other.kind, "held");
		if (main.kind === "held") await main.release();
		if (other.kind === "held") await other.release();

		const reloaded = await acquireWorktreeLease(fixture.repo, { runtimeDir: fixture.runtimeDir, sessionId: "reloaded" });
		assert.equal(reloaded.kind, "held");
		if (reloaded.kind === "held") await reloaded.release();
	} finally {
		await fixture.cleanup();
	}
});

test("injects the timeout-bounded one-shot Git root lookup", async () => {
	let request: { command: string; args: string[]; timeoutMs: number } | undefined;
	const result = await acquireWorktreeLease("/repo", {
		gitCommand: "custom-git",
		gitTimeoutMs: 321,
		exec: async (command, args, options) => {
			request = { command, args, timeoutMs: options.timeoutMs };
			return { code: 128, stdout: "", stderr: "not a repository" };
		},
	});
	assert.deepEqual(request, {
		command: "custom-git",
		args: ["-C", "/repo", "rev-parse", "--show-toplevel"],
		timeoutMs: 321,
	});
	assert.deepEqual(result, { kind: "unguarded", reason: "non-git" });
});

test("fails open when the Git root executor rejects or is unavailable", async () => {
	const rejected = await acquireWorktreeLease("/repo", {
		exec: async () => { throw new Error("executor failed"); },
	});
	assert.deepEqual(rejected, { kind: "unguarded", reason: "git-unavailable", detail: "executor failed" });

	const missing = await acquireWorktreeLease("/repo", { gitCommand: "/definitely/missing/git" });
	assert.deepEqual(missing, { kind: "unguarded", reason: "git-unavailable" });
});

test("times out the default Git root lookup", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-session-mode-git-timeout-"));
	try {
		const slowGit = join(directory, "slow-git");
		await writeFile(slowGit, "#!/bin/sh\nexec sleep 10\n");
		await chmod(slowGit, 0o700);
		const result = await acquireWorktreeLease(directory, {
			gitCommand: slowGit,
			gitTimeoutMs: 10,
		});
		try {
			assert.equal(result.kind, "unguarded");
			if (result.kind === "unguarded") {
				assert.equal(result.reason, "git-unavailable");
				assert.equal(result.detail, "git root lookup timed out after 10ms");
			}
		} finally {
			if (result.kind === "held") await result.release();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("does not claim protection outside Git or when flock is unavailable", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-session-mode-nongit-"));
	try {
		const nonGit = await acquireWorktreeLease(root, { runtimeDir: join(root, "runtime") });
		assert.deepEqual(nonGit, { kind: "unguarded", reason: "non-git" });

		const fixture = await gitRepo();
		try {
			const unavailable = await acquireWorktreeLease(fixture.repo, {
				runtimeDir: fixture.runtimeDir,
				flockCommand: join(root, "missing-flock"),
			});
			assert.equal(unavailable.kind, "unguarded");
			if (unavailable.kind === "unguarded") assert.equal(unavailable.reason, "flock-unavailable");
		} finally {
			await fixture.cleanup();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
