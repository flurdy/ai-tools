import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
