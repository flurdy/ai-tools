import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireWorktreeLease, lockIdentity } from "./lease.ts";
import { probeWorktreeLeaseOccupancy } from "./lease-observer.ts";

async function gitRepo(): Promise<{ repo: string; runtimeDir: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "pi-lease-observer-"));
	const repo = join(root, "repo");
	const runtimeDir = join(root, "runtime");
	await mkdir(repo);
	execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
	return { repo, runtimeDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("observes the authoritative flock without trusting metadata or creating a lock", async () => {
	const fixture = await gitRepo();
	try {
		const root = execFileSync("git", ["-C", fixture.repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
		const lockPath = join(fixture.runtimeDir, `${lockIdentity(root)}.lock`);
		const metadataPath = join(fixture.runtimeDir, `${lockIdentity(root)}.json`);

		assert.deepEqual(await probeWorktreeLeaseOccupancy(fixture.repo, { runtimeDir: fixture.runtimeDir }), { kind: "free", root });
		await assert.rejects(access(lockPath, constants.F_OK));

		await mkdir(fixture.runtimeDir, { recursive: true });
		await writeFile(metadataPath, '{"pid":999999}\n');
		assert.deepEqual(await probeWorktreeLeaseOccupancy(fixture.repo, { runtimeDir: fixture.runtimeDir }), { kind: "free", root });

		const lease = await acquireWorktreeLease(fixture.repo, { runtimeDir: fixture.runtimeDir });
		assert.equal(lease.kind, "held");
		try {
			assert.deepEqual(await probeWorktreeLeaseOccupancy(fixture.repo, { runtimeDir: fixture.runtimeDir }), { kind: "free", root });
			const runtimeAlias = join(fixture.repo, "..", "runtime-link");
			await symlink(fixture.runtimeDir, runtimeAlias);
			assert.deepEqual(await probeWorktreeLeaseOccupancy(fixture.repo, {
				runtimeDir: runtimeAlias,
				selfPid: -1,
			}), { kind: "held", root });
		} finally {
			if (lease.kind === "held") await lease.release();
		}
		assert.deepEqual(await probeWorktreeLeaseOccupancy(fixture.repo, { runtimeDir: fixture.runtimeDir }), { kind: "free", root });
	} finally {
		await fixture.cleanup();
	}
});

test("hides non-Git, unavailable, malformed, and timed-out occupancy probes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-lease-observer-errors-"));
	try {
		assert.equal((await probeWorktreeLeaseOccupancy(directory)).kind, "unavailable");

		const fixture = await gitRepo();
		try {
			const root = execFileSync("git", ["-C", fixture.repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
			await mkdir(fixture.runtimeDir, { recursive: true });
			await writeFile(join(fixture.runtimeDir, `${lockIdentity(root)}.lock`), "");

			const malformed = join(directory, "malformed-lslocks");
			await writeFile(malformed, "#!/bin/sh\nprintf 'not json\\n'\n");
			await chmod(malformed, 0o700);
			assert.equal((await probeWorktreeLeaseOccupancy(fixture.repo, {
				runtimeDir: fixture.runtimeDir,
				lslocksCommand: malformed,
			})).kind, "unavailable");

			const slow = join(directory, "slow-lslocks");
			await writeFile(slow, "#!/bin/sh\nexec sleep 10\n");
			await chmod(slow, 0o700);
			assert.equal((await probeWorktreeLeaseOccupancy(fixture.repo, {
				runtimeDir: fixture.runtimeDir,
				lslocksCommand: slow,
				timeoutMs: 10,
			})).kind, "unavailable");
		} finally {
			await fixture.cleanup();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
