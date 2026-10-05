import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { BeadsCountsCache, fetchBeadsCounts, findBeadsRoot, formatBeadsCounts, parseBeadsCounts, type BeadsCounts } from "./beads-status.ts";

const firstCounts: BeadsCounts = {
	openByPriority: [0, 0, 0, 0, 4],
	inProgress: 1,
	blocked: 0,
	successfulSources: 1,
	unavailableSources: 0,
};
const secondCounts: BeadsCounts = {
	openByPriority: [0, 1, 2, 0, 0],
	inProgress: 2,
	blocked: 1,
	successfulSources: 1,
	unavailableSources: 0,
};

test("groups open Beads by priority and counts active and blocked work", () => {
	const issues = [
		{ status: "open", priority: 0 },
		{ status: "open", priority: 2 },
		{ status: "open", priority: 2 },
		{ status: "open", priority: 4 },
		{ status: "in_progress", priority: 1 },
		{ status: "in_progress", priority: 4 },
		{ status: "deferred", priority: 3 },
	];
	assert.deepEqual(parseBeadsCounts(JSON.stringify(issues), JSON.stringify([{ id: "blocked-1" }])), {
		openByPriority: [1, 0, 2, 0, 1],
		inProgress: 2,
		blocked: 1,
		successfulSources: 1,
		unavailableSources: 0,
	});
});

test("rejects malformed or invalid Beads lists", () => {
	assert.equal(parseBeadsCounts("not json", "[]"), undefined);
	assert.equal(parseBeadsCounts("[]", "{}"), undefined);
	assert.equal(parseBeadsCounts(JSON.stringify([{ status: "open", priority: 5 }]), "[]"), undefined);
	assert.equal(parseBeadsCounts(JSON.stringify([{ priority: 2 }]), "[]"), undefined);
});

test("formats compact priority, active, and blocked indicators", () => {
	assert.equal(formatBeadsCounts(undefined), "");
	assert.equal(
		formatBeadsCounts({ openByPriority: [0, 0, 0, 0, 5], inProgress: 1, blocked: 0, successfulSources: 1, unavailableSources: 0 }),
		"◉ P4:5 ◐1",
	);
	assert.equal(
		formatBeadsCounts({ openByPriority: [1, 0, 2, 0, 5], inProgress: 1, blocked: 2, successfulSources: 1, unavailableSources: 0 }),
		"◉ P0:1 P2:2 P4:5 ◐1 ⛔2",
	);
	assert.equal(
		formatBeadsCounts({ openByPriority: [0, 0, 0, 0, 0], inProgress: 0, blocked: 0, successfulSources: 1, unavailableSources: 0 }),
		"◉ 0",
	);
	assert.equal(
		formatBeadsCounts({ openByPriority: [0, 0, 1, 0, 0], inProgress: 0, blocked: 2, successfulSources: 2, unavailableSources: 1 }),
		"◉ P2:1 ⛔2 ⚠ 1",
	);
	assert.equal(
		formatBeadsCounts({ openByPriority: [0, 0, 0, 0, 0], inProgress: 0, blocked: 0, successfulSources: 0, unavailableSources: 2 }),
		"◉ ? ⚠ 2",
	);
});

test("finds the nearest Beads workspace", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-statusline-beads-"));
	try {
		const workspace = join(directory, "workspace");
		const nested = join(workspace, "one", "two");
		await mkdir(join(workspace, ".beads"), { recursive: true });
		await mkdir(nested, { recursive: true });
		assert.equal(findBeadsRoot(nested), workspace);
		assert.equal(findBeadsRoot(directory), undefined);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("aggregates a validated workspace root through project-workspace", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-statusline-workspace-beads-"));
	try {
		await Promise.all([
			mkdir(join(directory, ".git")),
			mkdir(join(directory, ".beads")),
			mkdir(join(directory, "repos")),
			mkdir(join(directory, "infrastructure")),
		]);
		await Promise.all(
			["workspace.json", "README.md", "AGENTS.md", "Makefile"].map((name) => writeFile(join(directory, name), "{}\n")),
		);
		const command = join(directory, "project-workspace-test");
		const fixture = fileURLToPath(new URL("../../shared/project-workspace/tests/fixtures/beads-counts-partial.json", import.meta.url));
		await writeFile(
			command,
			`#!/usr/bin/env bash
			[[ "$1" == "beads-counts" ]] || exit 2
			cat ${JSON.stringify(fixture)}
			`,
		);
		await chmod(command, 0o755);

		const counts = await fetchBeadsCounts(directory, { workspaceCommand: command });
		assert.deepEqual(counts, {
			openByPriority: [1, 0, 0, 0, 2],
			inProgress: 2,
			blocked: 1,
			successfulSources: 2,
			unavailableSources: 1,
		});
		assert.equal(formatBeadsCounts(counts), "◉ P0:1 P4:2 ◐2 ⛔1 ⚠ 1");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("keeps a registered repository scoped to its nearest local store", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-statusline-local-beads-"));
	try {
		const workspace = join(directory, "workspace");
		const repository = join(workspace, "repos", "service");
		const nested = join(repository, "nested");
		await mkdir(join(workspace, ".beads"), { recursive: true });
		await writeFile(join(workspace, "workspace.json"), "{}\n");
		await mkdir(join(repository, ".beads"), { recursive: true });
		await writeFile(join(repository, "workspace.json"), "{}\n");
		await mkdir(nested);
		const command = join(directory, "bd-test");
		await writeFile(
			command,
			`#!/usr/bin/env bash
			if [[ "$1" == "list" ]]; then
				printf '%s\\n' '[{"status":"open","priority":4}]'
			elif [[ "$1" == "blocked" ]]; then
				printf '%s\\n' '[]'
			else
				exit 2
			fi
			`,
		);
		await chmod(command, 0o755);

		const root = findBeadsRoot(nested);
		assert.equal(root, repository);
		assert.deepEqual(await fetchBeadsCounts(root, { command }), {
			openByPriority: [0, 0, 0, 0, 1],
			inProgress: 0,
			blocked: 0,
			successfulSources: 1,
			unavailableSources: 0,
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("force-kills a Beads command that ignores the timeout signal", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-statusline-beads-timeout-"));
	try {
		await mkdir(join(directory, ".beads"));
		const pidFile = join(directory, "pid");
		const command = join(directory, "bd-test");
		await writeFile(
			command,
			`#!/usr/bin/env bash
			if [[ "$1" == "blocked" ]]; then
				printf '%s\\n' '[]'
				exit
			fi
			trap '' TERM
			printf '%s' "$$" > ${JSON.stringify(pidFile)}
			while true; do sleep 1; done
			`,
		);
		await chmod(command, 0o755);

		const started = Date.now();
		await assert.rejects(fetchBeadsCounts(directory, { command, timeoutMs: 50 }), /timed out after 50ms/);
		assert.ok(Date.now() - started < 1000);
		const pid = Number(await readFile(pidFile, "utf8"));
		assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("serializes local reads and skips blocked after a failed list", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-statusline-beads-serial-"));
	try {
		const command = join(directory, "bd-test");
		await writeFile(command, `#!/usr/bin/env bash
set -e
mkdir reading || exit 7
trap 'rmdir reading' EXIT
printf '%s\\n' "$1" >> calls
if [[ "$1" == list ]]; then
  sleep 0.1
  [[ ! -f fail ]] || exit 1
fi
printf '[]\\n'
`);
		await chmod(command, 0o755);
		assert.equal((await fetchBeadsCounts(directory, { command })).successfulSources, 1);
		assert.equal(await readFile(join(directory, "calls"), "utf8"), "list\nblocked\n");
		await writeFile(join(directory, "calls"), "");
		await writeFile(join(directory, "fail"), "");
		await assert.rejects(fetchBeadsCounts(directory, { command }));
		assert.equal(await readFile(join(directory, "calls"), "utf8"), "list\n");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("shares one deadline across sequential local reads", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-statusline-beads-budget-"));
	try {
		const command = join(directory, "bd-test");
		await writeFile(command, "#!/usr/bin/env bash\nsleep 0.3\nprintf '[]\\n'\n");
		await chmod(command, 0o755);
		const started = Date.now();
		await assert.rejects(fetchBeadsCounts(directory, { command, timeoutMs: 500 }), /timed out/);
		assert.ok(Date.now() - started < 1000);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

async function processRunning(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		if (process.platform === "linux") {
			const stat = await readFile(`/proc/${pid}/stat`, "utf8");
			return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
		}
		return true;
	} catch (error) {
		if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
		throw error;
	}
}

for (const abort of [false, true]) {
	for (const inheritPipes of [false, true]) {
		test(`cleans a TERM-ignoring descendant on ${abort ? "abort" : "timeout"}, ${inheritPipes ? "workspace/inherited pipes" : "local/closed pipes"}`, {
			skip: process.platform === "win32",
		}, async () => {
			const directory = await mkdtemp(join(tmpdir(), "pi-statusline-beads-tree-"));
			const pidFile = join(directory, "reader-pid");
			const command = join(directory, "bd-test");
			const controller = new AbortController();
			let readerPid: number | undefined;
			try {
				if (inheritPipes) {
					for (const name of [".git", ".beads", "repos", "infrastructure"]) await mkdir(join(directory, name));
					for (const name of ["workspace.json", "README.md", "AGENTS.md", "Makefile"]) await writeFile(join(directory, name), "{}\n");
				}
				const reader = `process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
				await writeFile(command, `#!${process.execPath}
if (process.argv[2] === "blocked") { console.log("[]"); process.exit(0); }
require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(reader)}], { stdio: ${JSON.stringify(inheritPipes ? "inherit" : "ignore")} });
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`);
				await chmod(command, 0o755);
				const pending = assert.rejects(fetchBeadsCounts(directory, {
					command, workspaceCommand: command, timeoutMs: abort ? 5000 : 500, signal: controller.signal,
				}), abort ? /aborted/ : /timed out/);
				const deadline = Date.now() + 2000;
				while (!readerPid && Date.now() < deadline) {
					try { readerPid = Number(await readFile(pidFile, "utf8")); } catch {}
					if (!readerPid) await delay(10);
				}
				assert.ok(readerPid, "descendant started before cancellation");
				if (abort) controller.abort();
				await pending;
				const exitDeadline = Date.now() + 1000;
				while (await processRunning(readerPid) && Date.now() < exitDeadline) await delay(10);
				assert.equal(await processRunning(readerPid), false, "descendant still running after query settled");
			} finally {
				controller.abort();
				if (readerPid) { try { process.kill(readerPid, "SIGKILL"); } catch {} }
				await rm(directory, { recursive: true, force: true });
			}
		});
	}
}

test("rejects missing commands and pre-aborted requests", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(fetchBeadsCounts(tmpdir(), { command: "/missing/beads-test", signal: controller.signal }), /aborted/);
	await assert.rejects(fetchBeadsCounts(tmpdir(), { command: "/missing/beads-test" }), /ENOENT/);
});

test("bounds count output and rejects failed queries", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-statusline-beads-output-"));
	try {
		const command = join(directory, "bd-test");
		await writeFile(command, `#!${process.execPath}\nprocess.stdout.write("x".repeat(2 * 1024 * 1024));\n`);
		await chmod(command, 0o755);
		await assert.rejects(fetchBeadsCounts(directory, { command }), /exceeded output limit/);
		await writeFile(command, `#!${process.execPath}\nprocess.exit(3);\n`);
		await assert.rejects(fetchBeadsCounts(directory, { command }), /failed \(3\)/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("deduplicates refreshes and honors the cache interval", async () => {
	const pending: Array<(counts: BeadsCounts) => void> = [];
	let loads = 0;
	let changes = 0;
	const cache = new BeadsCountsCache({
		load: () => {
			loads += 1;
			return new Promise((resolve) => pending.push(resolve));
		},
		ttlMs: 1000,
		onChange: () => {
			changes += 1;
		},
	});

	const first = cache.refresh(1000);
	await cache.refresh(1001);
	assert.equal(loads, 1);
	pending.shift()?.(firstCounts);
	await first;
	assert.deepEqual(cache.counts, firstCounts);
	assert.equal(changes, 1);

	await cache.refresh(1999);
	assert.equal(loads, 1);
	const second = cache.refresh(2000);
	assert.equal(loads, 2);
	pending.shift()?.(secondCounts);
	await second;
	assert.deepEqual(cache.counts, secondCounts);
});

test("hides stale counts after a failed refresh", async () => {
	let fail = false;
	const cache = new BeadsCountsCache({
		load: async () => {
			if (fail) throw new Error("bd unavailable");
			return firstCounts;
		},
		ttlMs: 1000,
	});

	await cache.refresh(1000);
	assert.deepEqual(cache.counts, firstCounts);
	fail = true;
	await cache.refresh(2000);
	assert.equal(cache.counts, undefined);
});

test("aborts an active refresh and ignores late results when disposed", async () => {
	let changed = false;
	let aborted = false;
	let resolveLoad: ((counts: BeadsCounts) => void) | undefined;
	const cache = new BeadsCountsCache({
		load: (signal) => {
			signal.addEventListener(
				"abort",
				() => {
					aborted = true;
				},
				{ once: true },
			);
			return new Promise((resolve) => {
				resolveLoad = resolve;
			});
		},
		ttlMs: 1000,
		onChange: () => {
			changed = true;
		},
	});

	const refresh = cache.refresh();
	cache.dispose();
	resolveLoad?.(secondCounts);
	await refresh;
	assert.equal(aborted, true);
	assert.equal(cache.counts, undefined);
	assert.equal(changed, false);
});
