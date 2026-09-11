import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireWorktreeLease, lockIdentity } from "./lease.ts";
import { probeWorktreeLeaseOccupancy, type ProbeWorktreeLeaseOccupancyOptions } from "./lease-observer.ts";

async function gitRepo(): Promise<{ repo: string; runtimeDir: string; cleanup: () => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "pi-lease-observer-"));
	const repo = join(root, "repo");
	const runtimeDir = join(root, "runtime");
	await mkdir(repo);
	execFileSync("git", ["-C", repo, "init", "-q", "-b", "main"]);
	return { repo, runtimeDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function scriptedProbe(script: (lockPath: string) => string, options: ProbeWorktreeLeaseOccupancyOptions = {}) {
	const fixture = await gitRepo();
	try {
		await mkdir(fixture.runtimeDir);
		const lockPath = join(fixture.runtimeDir, `${lockIdentity(fixture.repo)}.lock`);
		await writeFile(lockPath, "");
		const command = join(fixture.runtimeDir, "scripted-lslocks");
		await writeFile(command, `#!${process.execPath}\n${script(lockPath)}\n`, { mode: 0o700 });
		return await probeWorktreeLeaseOccupancy(fixture.repo, {
			runtimeDir: fixture.runtimeDir,
			lslocksCommand: command,
			...options,
		});
	} finally {
		await fixture.cleanup();
	}
}

test("default deadline still stops a stalled lock scan", async () => {
	const result = await scriptedProbe(() => `setTimeout(() => process.stdout.write('{"locks":[]}'), 3000);`);
	assert.equal(result.kind, "unavailable");
	if (result.kind === "unavailable") assert.match(result.reason, /scripted-lslocks timed out after 2000ms$/);
});

test("missing commands and nonzero exits never become free, even with valid stdout", async () => {
	for (const script of ["process.exit(2);", `process.stdout.write('{"locks":[]}'); process.exitCode = 2;`]) {
		assert.equal((await scriptedProbe(() => script)).kind, "unavailable");
	}
	assert.equal((await scriptedProbe(() => "", { lslocksCommand: "/nonexistent/pi-test-lslocks" })).kind, "unavailable");
});

test("invalid lock responses stay unavailable", async () => {
	for (const locks of [null, {}, [null], ["invalid"], [0]]) {
		assert.equal((await scriptedProbe(() => `console.log(${JSON.stringify(JSON.stringify({ locks }))});`)).kind, "unavailable");
	}
	for (const pid of [0, -1, 1.5, "123", null]) {
		const result = await scriptedProbe((path) => `console.log(${JSON.stringify(JSON.stringify({ locks: [{ path, type: "FLOCK", mode: "WRITE", pid }] }))});`);
		assert.equal(result.kind, "unavailable");
	}
});

test("cancellation remains unavailable before and during a probe", async () => {
	const preAborted = new AbortController();
	preAborted.abort();
	assert.equal((await scriptedProbe(() => "", { signal: preAborted.signal })).kind, "unavailable");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 100);
	try {
		const result = await scriptedProbe(() => `setTimeout(() => process.stdout.write('{"locks":[]}'), 3000);`, { signal: controller.signal });
		assert.equal(result.kind, "unavailable");
		if (result.kind === "unavailable") assert.match(result.reason, /abort/i);
	} finally {
		clearTimeout(timer);
	}
});

test("observes the authoritative flock without trusting metadata or creating a lock", async () => {
	const fixture = await gitRepo();
	try {
		const root = execFileSync("git", ["-C", fixture.repo, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
		const lockPath = join(fixture.runtimeDir, `${lockIdentity(root)}.lock`);
		const metadataPath = join(fixture.runtimeDir, `${lockIdentity(root)}.json`);
		const probeOptions = { runtimeDir: fixture.runtimeDir, timeoutMs: 10_000 };

		assert.deepEqual(await probeWorktreeLeaseOccupancy(fixture.repo, probeOptions), { kind: "free", root });
		await assert.rejects(access(lockPath, constants.F_OK));

		await mkdir(fixture.runtimeDir, { recursive: true });
		await writeFile(metadataPath, '{"pid":999999}\n');
		assert.deepEqual(await probeWorktreeLeaseOccupancy(fixture.repo, probeOptions), { kind: "free", root });

		const lease = await acquireWorktreeLease(fixture.repo, { runtimeDir: fixture.runtimeDir });
		assert.equal(lease.kind, "held");
		try {
			assert.deepEqual(await probeWorktreeLeaseOccupancy(fixture.repo, probeOptions), { kind: "free", root });
			const runtimeAlias = join(fixture.repo, "..", "runtime-link");
			await symlink(fixture.runtimeDir, runtimeAlias);
			assert.deepEqual(await probeWorktreeLeaseOccupancy(fixture.repo, {
				...probeOptions,
				runtimeDir: runtimeAlias,
				selfPid: -1,
			}), { kind: "held", root });
		} finally {
			if (lease.kind === "held") await lease.release();
		}
		assert.deepEqual(await probeWorktreeLeaseOccupancy(fixture.repo, probeOptions), { kind: "free", root });
	} finally {
		await fixture.cleanup();
	}
});

test("allows a lock scan longer than 500 ms with the default deadline", async () => {
	const fixture = await gitRepo();
	try {
		await mkdir(fixture.runtimeDir);
		await writeFile(join(fixture.runtimeDir, `${lockIdentity(fixture.repo)}.lock`), "");
		const command = join(fixture.runtimeDir, "delayed-lslocks");
		await writeFile(command, `#!${process.execPath}\nsetTimeout(() => process.stdout.write('{"locks":[]}'), 1200);\n`, { mode: 0o700 });
		assert.deepEqual(await probeWorktreeLeaseOccupancy(fixture.repo, {
			runtimeDir: fixture.runtimeDir,
			lslocksCommand: command,
		}), { kind: "free", root: fixture.repo });
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
			const timedOut = await probeWorktreeLeaseOccupancy(fixture.repo, {
				runtimeDir: fixture.runtimeDir,
				lslocksCommand: slow,
				timeoutMs: 100,
			});
			assert.equal(timedOut.kind, "unavailable");
			if (timedOut.kind === "unavailable") assert.equal(timedOut.reason, `${slow} timed out after 100ms`);
		} finally {
			await fixture.cleanup();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
