import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	codexQuotaDisplayState,
	fetchCodexQuotaSnapshot,
	isCodexQuotaStale,
	isCodexSnapshotStale,
	selectCodexWeeklyQuota,
	selectCodexQuotaSnapshot,
	showsCodexQuota,
} from "./codex-quota.ts";
import { modelLabel, shortModel } from "./model-label.ts";
import { bar, CODEX_QUOTA_CRIT_PERCENT, CODEX_QUOTA_WARN_PERCENT, codexQuotaTone } from "./quota-display.ts";

const WEEK = 7 * 24 * 60;
const colors = {
	ok: (text: string) => `[ok:${text}]`,
	warn: (text: string) => `[warn:${text}]`,
	crit: (text: string) => `[crit:${text}]`,
	empty: (text: string) => `[empty:${text}]`,
};

test("shows quota in compact and table footer data only for enabled Codex models", () => {
	assert.equal(showsCodexQuota("openai-codex"), true);
	assert.equal(showsCodexQuota("openai-codex", false), false);
	assert.equal(showsCodexQuota("anthropic"), false);
	assert.equal(showsCodexQuota("openrouter"), false);
	assert.equal(showsCodexQuota(undefined), false);
});

test("distinguishes unavailable Codex quota from hidden and cached states", () => {
	const quota = { usedPercent: 20, remainingPercent: 80, fetchedAtMs: 1000, resetsAtMs: 10_000 };

	assert.equal(codexQuotaDisplayState("anthropic", true, undefined, true), "hidden");
	assert.equal(codexQuotaDisplayState("openai-codex", false, undefined, true), "hidden");
	assert.equal(codexQuotaDisplayState("openai-codex", true, undefined, false), "hidden");
	assert.equal(codexQuotaDisplayState("openai-codex", true, undefined, true), "unavailable");
	assert.equal(codexQuotaDisplayState("openai-codex", true, quota, true), "available");
});

test("renders quota bars without rounding usage upward", () => {
	assert.equal(bar(67, 6, CODEX_QUOTA_WARN_PERCENT, CODEX_QUOTA_CRIT_PERCENT, colors), "[warn:▮▮▮▮][empty:▯▯]");
	assert.equal(bar(100, 6, CODEX_QUOTA_WARN_PERCENT, CODEX_QUOTA_CRIT_PERCENT, colors), "[crit:▮▮▮▮▮▮][empty:]");
});

test("uses warning and error quota thresholds at 60% and 75%", () => {
	assert.equal(CODEX_QUOTA_WARN_PERCENT, 60);
	assert.equal(CODEX_QUOTA_CRIT_PERCENT, 75);
	assert.equal(codexQuotaTone(59), "success");
	assert.equal(codexQuotaTone(60), "warning");
	assert.equal(codexQuotaTone(74), "warning");
	assert.equal(codexQuotaTone(75), "error");
});

test("selects a weekly primary window", () => {
	const quota = selectCodexWeeklyQuota(
		{
			rateLimits: {
				primary: { usedPercent: 12, windowDurationMins: WEEK, resetsAt: 1_800_000_000 },
				secondary: null,
			},
		},
		123,
	);
	assert.deepEqual(quota, {
		usedPercent: 12,
		remainingPercent: 88,
		resetsAtMs: 1_800_000_000_000,
		fetchedAtMs: 123,
	});
});

test("selects weekly by duration rather than primary/secondary position", () => {
	const quota = selectCodexWeeklyQuota({
		rateLimits: {
			primary: { usedPercent: 75, windowDurationMins: 300, resetsAt: 1_700_000_000 },
			secondary: { usedPercent: 25, windowDurationMins: WEEK, resetsAt: 1_800_000_000 },
		},
	});
	assert.equal(quota?.usedPercent, 25);
	assert.equal(quota?.remainingPercent, 75);
});

test("prefers the canonical codex bucket", () => {
	const quota = selectCodexWeeklyQuota({
		rateLimits: {
			primary: { usedPercent: 99, windowDurationMins: WEEK },
		},
		rateLimitsByLimitId: {
			codex: { primary: { usedPercent: 40, windowDurationMins: WEEK } },
			codex_special: { primary: { usedPercent: 80, windowDurationMins: WEEK } },
		},
	});
	assert.equal(quota?.usedPercent, 40);
});

test("accepts approximate and snake-case weekly windows", () => {
	const quota = selectCodexWeeklyQuota({
		rate_limits: {
			primary: { used_percent: 33, window_minutes: Math.round(WEEK * 0.96), resets_at: 1_800_000_000 },
		},
	});
	assert.equal(quota?.remainingPercent, 67);
});

test("rejects responses without a weekly window", () => {
	const quota = selectCodexWeeklyQuota({
		rateLimits: {
			primary: { usedPercent: 10, windowDurationMins: 300 },
			secondary: { usedPercent: 20, windowDurationMins: 1440 },
		},
	});
	assert.equal(quota, undefined);
});

test("parses credits from the same canonical snapshot as weekly quota", () => {
	const snapshot = selectCodexQuotaSnapshot({
		rateLimits: { credits: { hasCredits: true, unlimited: false, balance: "999" } },
		rateLimitsByLimitId: {
			codex: {
				primary: { usedPercent: 40, windowDurationMins: WEEK },
				credits: { hasCredits: true, unlimited: false, balance: "12.500" },
			},
			codex_special: { credits: { hasCredits: true, unlimited: false, balance: "777" } },
		},
	}, 123);
	assert.equal(snapshot?.weekly?.usedPercent, 40);
	assert.deepEqual(snapshot?.credits, { kind: "balance", balance: "12.500" });
	assert.equal(snapshot?.fetchedAtMs, 123);
	assert.equal(snapshot?.weekly?.fetchedAtMs, 123);
});

test("does not borrow missing credits from a non-canonical bucket", () => {
	const snapshot = selectCodexQuotaSnapshot({
		rateLimits: { credits: { hasCredits: true, unlimited: false, balance: "999" } },
		rateLimitsByLimitId: { codex: { primary: { usedPercent: 40, windowDurationMins: WEEK } } },
	});
	assert.equal(snapshot?.credits, undefined);
	assert.equal(snapshot?.weekly?.usedPercent, 40);
});

test("supports credits-only, unlimited, exact zero, and snake-case snapshots", () => {
	for (const balance of ["0", "0.00", "12.50", "9007199254740993.125"]) {
		const snapshot = selectCodexQuotaSnapshot({ rateLimits: {
			primary: null, secondary: null, credits: { hasCredits: true, unlimited: false, balance },
		} }, 123);
		assert.equal(snapshot?.weekly, undefined);
		assert.deepEqual(snapshot?.credits, { kind: "balance", balance });
	}
	for (const hasCredits of [true, false]) {
		const snapshot = selectCodexQuotaSnapshot({ rateLimits: { credits: { hasCredits, unlimited: true, balance: null } } });
		assert.deepEqual(snapshot?.credits, { kind: "unlimited" });
	}
	assert.deepEqual(selectCodexQuotaSnapshot({ rate_limits: {
		credits: { has_credits: true, unlimited: false, balance: "7.25" },
	} })?.credits, { kind: "balance", balance: "7.25" });
});

test("hides absent or malformed credits without losing a valid weekly quota", () => {
	const invalidCredits: unknown[] = [undefined, null, [], {},
		{ hasCredits: false, unlimited: false, balance: "10" },
		{ hasCredits: "true", unlimited: false, balance: "10" },
		{ hasCredits: 1, unlimited: true, balance: null },
		{ hasCredits: true, unlimited: "false", balance: "10" },
		{ hasCredits: true, balance: "10" },
		{ unlimited: true, balance: null },
	];
	for (const balance of [null, undefined, 0, 12, true, "", " ", " 1", "1 ", "1\n", "-0", "-1", "+1", "1e3", "0xff", "NaN", "Infinity", "1,000", ".5", "1.", "1.2.3", "1\u001b[31m", "9".repeat(400)]) {
		invalidCredits.push({ hasCredits: true, unlimited: false, balance });
	}
	for (const credits of invalidCredits) {
		const snapshot = selectCodexQuotaSnapshot({ rateLimits: {
			primary: { usedPercent: 20, windowDurationMins: WEEK }, credits,
		} });
		assert.equal(snapshot?.credits, undefined, JSON.stringify(credits));
		assert.equal(snapshot?.weekly?.usedPercent, 20);
	}
});

test("accepts empty account data but rejects missing or malformed envelopes", () => {
	assert.deepEqual(selectCodexQuotaSnapshot({ rateLimits: { primary: null, secondary: null, credits: null } }, 123), {
		weekly: undefined, credits: undefined, fetchedAtMs: 123,
	});
	for (const response of [undefined, null, [], {}, { rateLimits: null }, { rateLimits: [] }]) {
		assert.equal(selectCodexQuotaSnapshot(response), undefined);
	}
});

test("clamps unexpected percentages", () => {
	assert.equal(
		selectCodexWeeklyQuota({ rateLimits: { primary: { usedPercent: 120, windowDurationMins: WEEK } } })?.remainingPercent,
		0,
	);
	assert.equal(
		selectCodexWeeklyQuota({ rateLimits: { primary: { usedPercent: -5, windowDurationMins: WEEK } } })?.remainingPercent,
		100,
	);
});

test("marks old or reset snapshots stale", () => {
	const fresh = { usedPercent: 20, remainingPercent: 80, fetchedAtMs: 1000, resetsAtMs: 10_000 };
	assert.equal(isCodexQuotaStale(fresh, 2000, 5000), false);
	assert.equal(isCodexQuotaStale(fresh, 7000, 5000), true);
	assert.equal(isCodexQuotaStale(fresh, 10_000, 20_000), true);
});

test("shares snapshot age and reset staleness with credits", () => {
	const credits = { kind: "balance" as const, balance: "12.50" };
	const snapshot = { credits, fetchedAtMs: 1000 };
	assert.equal(isCodexSnapshotStale(snapshot, 2000, 5000), false);
	assert.equal(isCodexSnapshotStale(snapshot, 7000, 5000), true);
	const weekly = { usedPercent: 20, remainingPercent: 80, fetchedAtMs: 1000, resetsAtMs: 10_000 };
	assert.equal(isCodexSnapshotStale({ ...snapshot, weekly }, 2000, 20_000), false);
	assert.equal(isCodexSnapshotStale({ ...snapshot, weekly }, 10_000, 20_000), true);
});

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		try {
			await access(path);
			return;
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
	throw new Error(`Timed out waiting for ${path}`);
}

async function withFakeAppServer(source: string, run: (script: string, directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-statusline-codex-"));
	const script = join(directory, "fake-app-server.mjs");
	try {
		await writeFile(script, source, { mode: 0o700 });
		await run(script, directory);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test("performs the JSON-RPC handshake and handles fragmented output", async () => {
	await withFakeAppServer(
		String.raw`
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    if (message.id === 1) {
      const response = JSON.stringify({ id: 1, result: { userAgent: "fake" } }) + "\n";
      process.stdout.write(response.slice(0, 5));
      setTimeout(() => process.stdout.write(response.slice(5)), 5);
    }
    if (message.id === 2) {
      process.stdout.write(JSON.stringify({ id: 2, result: { rateLimits: {
        primary: { usedPercent: 23, windowDurationMins: 10080, resetsAt: 1800000000 },
        credits: { hasCredits: true, unlimited: false, balance: "12.50" }
      } } }) + "\n");
    }
    newline = buffer.indexOf("\n");
  }
});
process.on("SIGTERM", () => process.exit(0));
`,
		async (script) => {
			const snapshot = await fetchCodexQuotaSnapshot({ command: process.execPath, args: [script], timeoutMs: 2000 });
			assert.equal(snapshot.weekly?.usedPercent, 23);
			assert.equal(snapshot.weekly?.remainingPercent, 77);
			assert.deepEqual(snapshot.credits, { kind: "balance", balance: "12.50" });
		},
	);
});

test("aborting waits for child termination", async () => {
	await withFakeAppServer(
		String.raw`
import { writeFileSync } from "node:fs";
const [ready, terminated] = process.argv.slice(2);
process.on("SIGTERM", () => {
  writeFileSync(terminated, "terminated");
  process.exit(0);
});
process.stdin.resume();
setInterval(() => {}, 1000);
writeFileSync(ready, String(process.pid));
`,
		async (script, directory) => {
			const ready = join(directory, "ready");
			const terminated = join(directory, "terminated");
			const controller = new AbortController();
			const query = fetchCodexQuotaSnapshot({ command: process.execPath, args: [script, ready, terminated], timeoutMs: 5000, signal: controller.signal });
			await waitForFile(ready);
			controller.abort();
			await assert.rejects(query, /aborted/);
			assert.equal(await readFile(terminated, "utf8"), "terminated");
		},
	);
});

test("timeout force-kills a child that ignores SIGTERM", async () => {
	await withFakeAppServer(
		String.raw`
import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], String(process.pid));
process.stdin.resume();
setInterval(() => {}, 1000);
process.on("SIGTERM", () => {});
`,
		async (script, directory) => {
			const pidFile = join(directory, "pid");
			const query = fetchCodexQuotaSnapshot({ command: process.execPath, args: [script, pidFile], timeoutMs: 50 });
			await waitForFile(pidFile);
			const pid = Number(await readFile(pidFile, "utf8"));
			await assert.rejects(query, /timed out/);
			assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
		},
	);
});

test("shortens GPT variants and only prefixes OpenRouter", () => {
	assert.equal(shortModel("gpt-5.6-terra"), "GPT-5.6 Terra");
	assert.equal(shortModel("openai/gpt-5.6-sol"), "GPT-5.6 Sol");
	assert.equal(shortModel("gpt-5.6-luna"), "GPT-5.6 Luna");
	assert.equal(modelLabel("openai-codex", "gpt-5.6-terra"), "GPT-5.6 Terra");
	assert.equal(modelLabel("openrouter", "openai/gpt-5.6-terra"), "OR GPT-5.6 Terra");
	assert.equal(modelLabel("anthropic", "claude-sonnet-4-6"), "Claude Sonnet 4.6");
});
