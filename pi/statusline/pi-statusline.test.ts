import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import piStatusline from "./pi-statusline.ts";

type Handler = (event: any, context: any) => unknown;

function registeredHandlers(): Map<string, Handler> {
	const handlers = new Map<string, Handler>();
	piStatusline({
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		getSessionName() {
			return "layout-test-session";
		},
	} as never);
	return handlers;
}

function model(provider = "openrouter") {
	return {
		provider,
		id: "openai/statusline-integration-test",
		cost: { input: 5 },
	};
}

function context(sessionId: string, tokens: number | null, notifications: string[], activeModel = model()) {
	return {
		model: activeModel,
		getContextUsage: () => ({ tokens, contextWindow: 1_000_000, percent: tokens === null ? null : tokens / 10_000 }),
		sessionManager: { getSessionId: () => sessionId },
		ui: { notify: (message: string) => notifications.push(message) },
	};
}

test("wires manual model selection to a visible OpenRouter warning", () => {
	const notifications: string[] = [];
	const handlers = registeredHandlers();
	const selectedModel = model();

	handlers.get("model_select")?.(
		{ model: selectedModel, previousModel: undefined, source: "set" },
		context("integration-model-select", 200_000, notifications, selectedModel),
	);

	assert.equal(notifications.length, 1);
	assert.match(notifications[0] ?? "", /OpenRouter cost warning/);
});

test("includes a submitted prompt when it crosses the first-request threshold", () => {
	const notifications: string[] = [];
	const handlers = registeredHandlers();

	handlers.get("before_agent_start")?.(
		{ prompt: "four", images: undefined, systemPrompt: "", systemPromptOptions: {} },
		context("integration-prompt", 99_999, notifications),
	);

	assert.equal(notifications.length, 1);
	assert.match(notifications[0] ?? "", /100,000 context tokens/);
});

test("wires continuing turns to threshold crossing without tool-loop spam", () => {
	const notifications: string[] = [];
	const handlers = registeredHandlers();
	const turn = handlers.get("turn_start");

	turn?.({ turnIndex: 0, timestamp: 0 }, context("integration-turn", 99_999, notifications));
	turn?.({ turnIndex: 1, timestamp: 1 }, context("integration-turn", 100_000, notifications));
	turn?.({ turnIndex: 2, timestamp: 2 }, context("integration-turn", 100_000, notifications));

	assert.equal(notifications.length, 1);
});

type Footer = { render(width: number): string[]; dispose(): void };

type FooterControls = { refresh(): Promise<void>; setProvider(provider: string): void };
type FooterOptions = {
	provider?: string; modelId?: string; codexBin?: string; quotaEnabled?: boolean;
	cwd?: string; divergenceEnabled?: boolean; branch?: string | null;
};

async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for footer refresh");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function withFooter(
	run: (footer: Footer, statuses: Map<string, string>, controls: FooterControls) => void | Promise<void>,
	options: FooterOptions = {},
) {
	let footerFactory: any;
	let component: Footer | undefined;
	const statuses = new Map<string, string>();
	const environment = [
		"PI_STATUSLINE_K8S_CONTEXT",
		"PI_STATUSLINE_CODEX_QUOTA",
		"PI_STATUSLINE_OPENROUTER_CREDITS",
		"PI_STATUSLINE_BEADS",
		"PI_STATUSLINE_GIT_DIVERGENCE",
		"PI_STATUSLINE_PR",
		"PI_STATUSLINE_GUARD_EMOJI",
		"PI_STATUSLINE",
		"PI_STATUSLINE_CODEX_BIN",
		"PI_STATUSLINE_CODEX_QUOTA_TTL",
		"PI_STATUSLINE_CODEX_QUOTA_STALE",
		"PI_STATUSLINE_CODEX_QUOTA_TIMEOUT",
	] as const;
	const previous = new Map(environment.map((name) => [name, process.env[name]]));
	for (const name of environment.slice(0, 6)) process.env[name] = "0";
	process.env.PI_STATUSLINE_GUARD_EMOJI = "1";
	process.env.PI_STATUSLINE_CODEX_QUOTA_TTL = "300000";
	process.env.PI_STATUSLINE_CODEX_QUOTA_STALE = "900000";
	process.env.PI_STATUSLINE_CODEX_QUOTA_TIMEOUT = "2000";
	if (options.codexBin) process.env.PI_STATUSLINE_CODEX_BIN = options.codexBin;
	if (options.quotaEnabled) process.env.PI_STATUSLINE_CODEX_QUOTA = "1";
	if (options.divergenceEnabled) process.env.PI_STATUSLINE_GIT_DIVERGENCE = "1";
	let renders = 0;
	const handlers = registeredHandlers();
	try {
		const ctx = {
			cwd: options.cwd ?? "/tmp",
			mode: "tui",
			model: { provider: options.provider ?? "test", id: options.modelId ?? "model", contextWindow: 1000 },
			getContextUsage: () => ({ tokens: 0 }),
			sessionManager: { getBranch: () => [], getSessionId: () => "footer-test" },
			ui: {
				setWidget() {},
				setFooter(factory: any) { footerFactory = factory; },
			},
		};
		await handlers.get("session_start")?.({}, ctx);
		assert.ok(footerFactory);
		component = footerFactory(
			{ requestRender() { renders++; } },
			{
				fg: (tone: string, text: string) => `\x1b[${tone === "dim" ? "2" : "32"}m${text}\x1b[0m`,
				bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
			},
			{
				getGitBranch: () => options.branch === undefined ? "feature/statusline-layout-test" : options.branch,
				getExtensionStatuses: () => statuses,
				onBranchChange: () => () => undefined,
			},
		);
		assert.ok(component);
		if (options.quotaEnabled && ctx.model.provider === "openai-codex") await waitFor(() => renders > 0);
		await run(component, statuses, {
			setProvider(provider) { ctx.model.provider = provider; },
			async refresh() {
				const before = renders;
				handlers.get("model_select")?.({ model: ctx.model, source: "restore" }, ctx);
				await waitFor(() => renders >= before + 2);
			},
		});
	} finally {
		component?.dispose();
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

test("renders cached per-repository divergence in both layouts without a root branch", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-workspace-footer-"));
	const previousPath = process.env.PATH;
	try {
		for (const name of [".git", ".beads", "repos", "infrastructure"]) await mkdir(join(directory, name));
		for (const name of ["workspace.json", "README.md", "AGENTS.md", "Makefile"]) await writeFile(join(directory, name), "");
		const payload = {
			version: 1,
			repositories: [{ repository: "workspace", path: ".", ahead: 1, behind: 0 }, { repository: "member", path: "repos/member", ahead: 4, behind: 2 }],
			successfulSources: 2, unavailableSources: 1, diagnostics: ["unavailable"],
		};
		await writeFile(join(directory, "project-workspace"), `#!/usr/bin/env node\nif (process.argv[2] !== 'git-counts') process.exit(2);\nsetTimeout(()=>console.log(${JSON.stringify(JSON.stringify(payload))}), 600);\n`, { mode: 0o700 });
		process.env.PATH = `${directory}:${previousPath ?? ""}`;
		await withFooter(async (footer) => {
			const first = stripVTControlCharacters(footer.render(240).join("\n"));
			assert.doesNotMatch(first, /⇡1 ⇡4/);
			await waitFor(() => stripVTControlCharacters(footer.render(240).join("\n")).includes("⇡1 ⇡4 ⇣2 ⚠1"));
			for (const layout of ["compact", "table"]) {
				process.env.PI_STATUSLINE = layout;
				for (const width of [1, 30, 80, 240]) {
					const lines = footer.render(width);
					assert.ok(lines.every(line => visibleWidth(line) <= width));
					const plain = stripVTControlCharacters(lines.join("\n"));
					if (width === 240) assert.match(plain, /⇡1 ⇡4 ⇣2 ⚠1/);
					assert.doesNotMatch(plain, /⇡5|repos\/member|/);
				}
			}
		}, { cwd: directory, branch: null, divergenceEnabled: true });
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		await rm(directory, { recursive: true, force: true });
	}
});

function verifyLayouts(footer: Footer, expectedGuard: string) {
	for (const layout of ["compact", "table"]) {
		process.env.PI_STATUSLINE = layout;
		for (const width of [1, 8, 20, 30, 80, 120, 180]) {
			const lines = footer.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `${layout} at ${width}`);
			if (layout === "table" && width === 180) {
				assert.equal(lines.length, 5);
				assert.equal(new Set(lines.map(visibleWidth)).size, 1);
			}
			if (layout === "compact" || width === 30) assert.equal(lines.length, 1);
			const plain = stripVTControlCharacters(lines.join("\n"));
			assert.doesNotMatch(plain, /leases:|api, web|🔒cwd|\x00|\x9b/);
			if (width >= 30) {
				const cells = plain.split(/[│\n]/).map((cell) => cell.trim());
				assert.equal(cells.filter((cell) => cell === expectedGuard).length, 1, `${layout} at ${width}: ${plain}`);
			}
		}
	}
}

for (const emojiEnabled of [true, false]) {
	for (const count of [1, 2, 32]) {
		test(`unifies ${count} worktree leases in emoji=${emojiEnabled} layouts`, () => withFooter((footer, statuses) => {
			process.env.PI_STATUSLINE_GUARD_EMOJI = emojiEnabled ? "1" : "0";
			statuses.set("session-mode", "\x1b[32mimplement\x1b[0m");
			statuses.set("session-mode-leases", `\x1b[32mleases:${count} api, web\x00\x9b\x1b[0m`);
			const suffix = count > 1 ? String(count) : "";
			verifyLayouts(footer, emojiEnabled ? `🔒${suffix}` : `implement${suffix ? ` ${suffix}` : ""}`);
		}));
	}
}

test("renders the Nerd Font Kubernetes glyph with spacing in both layouts", () => withFooter(async (footer) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-statusline-k8s-"));
	const previousPath = process.env.PATH;
	try {
		await writeFile(join(directory, "kubectl"), '#!/bin/sh\nprintf "fixture-context\\n"\n', { mode: 0o700 });
		process.env.PATH = `${directory}:${previousPath ?? ""}`;
		process.env.PI_STATUSLINE_K8S_CONTEXT = "1";
		for (const layout of ["compact", "table"]) {
			process.env.PI_STATUSLINE = layout;
			for (const width of [1, 30, 80, 120, 180, 240]) {
				const lines = footer.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width), `${layout} at ${width}`);
				const plain = stripVTControlCharacters(lines.join("\n"));
				assert.doesNotMatch(plain, /\u2638|\uFE0E/);
				if (width === 240) {
					assert.ok(plain.includes("\u{F10FE} fixture-context"));
					assert.equal(lines.length, layout === "table" ? 5 : 1);
					if (layout === "table") assert.equal(new Set(lines.map(visibleWidth)).size, 1);
				}
			}
		}
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		await rm(directory, { recursive: true, force: true });
	}
}));

test("keeps non-implement states distinct without persistent lease or occupancy cells", () => withFooter((footer, statuses) => {
	statuses.set("session-mode-leases", "leases:32 api, web");
	for (const [state, emoji] of [["acquiring", "⏳"], ["lazy", "💤"], ["plan", "🔍"], ["conflict", "⛔"], ["lost", "💥"], ["unguarded", "🚨"]]) {
		statuses.set("session-mode", `\x1b[31m${state}\x1b[0m`);
		process.env.PI_STATUSLINE_GUARD_EMOJI = "1";
		verifyLayouts(footer, emoji!);
		process.env.PI_STATUSLINE_GUARD_EMOJI = "0";
		verifyLayouts(footer, state!);
	}
}));

test("updates the unified cell as scopes change and disappear", () => withFooter((footer, statuses) => {
	statuses.set("session-mode", "implement");
	for (const [scopes, guard] of [["leases:2 api, web", "🔒2"], ["leases:1 child", "🔒"], ["leases:0", "✅"], ["invalid", "✅"], ["", "✅"]]) {
		statuses.set("session-mode-leases", scopes!);
		verifyLayouts(footer, guard!);
	}
	statuses.delete("session-mode");
	statuses.delete("session-mode-leases");
	assert.doesNotMatch(footer.render(180).join("\n"), /🔒|✅|leases:/);
}));

for (const [provider, modelId, label] of [
	["openai-codex", "gpt-6.1-sol", "Sol 6.1"],
	["openrouter", "openai/gpt-6.1-sol-pro", "OR Sol 6.1+"],
	["anthropic", "claude-sonnet-5-5", "Sonnet 5.5"],
	["anthropic", "claude-opus-5.5", "Opus 5.5"],
	["anthropic", "claude-fable-5-1", "Fable 5.1"],
	["anthropic", "claude-haiku-4-5", "Haiku 4.5"],
]) {
	test(`renders ${label} in compact and table footers without overflow`, () => withFooter((footer) => {
		for (const layout of ["compact", "table"]) {
			process.env.PI_STATUSLINE = layout;
			for (const width of [1, 8, 20, 30, 80, 120, 180, 240]) {
				const lines = footer.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width), `${layout} at ${width}`);
				if (width === 240) {
					assert.equal(lines.length, layout === "table" ? 5 : 1);
					const cells = stripVTControlCharacters(lines.join("\n")).split(/[│\n]/).map((cell) => cell.trim());
					assert.equal(cells.filter((cell) => cell === label).length, 1);
				}
			}
		}
	}, { provider, modelId }));
}

function rateLimits(credits: unknown, weekly = true, resetsAt = Math.floor(Date.now() / 1000) + 3600) {
	return { result: { rateLimits: {
		primary: weekly ? { usedPercent: 40, windowDurationMins: 10080, resetsAt } : null,
		secondary: null,
		credits,
	} } };
}

async function withCodexServer(
	response: unknown,
	run: (binary: string, reply: (value: unknown) => Promise<void>, methods: () => Promise<string[]>) => Promise<void>,
) {
	const directory = await mkdtemp(join(tmpdir(), "pi-footer-credits-"));
	const binary = join(directory, "codex");
	const responseFile = join(directory, "response.json");
	const log = join(directory, "requests");
	try {
		await writeFile(log, "");
		const reply = (value: unknown) => writeFile(responseFile, JSON.stringify(value));
		await reply(response);
		await writeFile(binary, `#!/usr/bin/env node
const { readFileSync, appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(${JSON.stringify(log)}, request.method + "\\n");
  if (request.method === "initialize") {
    console.log(JSON.stringify({ id: request.id, result: {} }));
  } else if (request.method === "account/rateLimits/read") {
    console.log(JSON.stringify({ id: request.id, ...JSON.parse(readFileSync(${JSON.stringify(responseFile)}, "utf8")) }));
  }
});
`, { mode: 0o700 });
		await run(binary, reply, async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

function verifyCreditLayouts(footer: Footer, creditText: string, dim = false) {
	for (const layout of ["compact", "table"]) {
		process.env.PI_STATUSLINE = layout;
		const lines = footer.render(240);
		assert.equal(lines.length, layout === "table" ? 5 : 1);
		const rendered = lines.join("\n");
		const plain = stripVTControlCharacters(rendered);
		assert.ok(plain.includes("GPT ·") && plain.includes(creditText), plain);
		const tone = `\x1b[${dim ? "2" : "32"}m`;
		assert.ok(rendered.includes(`${tone} · ${creditText}\x1b[0m`) || rendered.includes(`${tone}GPT · ${creditText}\x1b[0m`), rendered);
		assert.doesNotMatch(plain, /Codex credits|Codex \$/);
		for (const width of [1, 20, 80, 120, 180, 240]) {
			assert.ok(footer.render(width).every((line) => visibleWidth(line) <= width), `${layout} at ${width}`);
		}
	}
}

test("renders Codex credits in both layouts using the single cached quota response", async () => {
	await withCodexServer(rateLimits({ hasCredits: true, unlimited: false, balance: "12.500" }), async (binary, reply, methods) => {
		await withFooter(async (footer, _statuses, controls) => {
			verifyCreditLayouts(footer, "13 cr");
			assert.match(stripVTControlCharacters(footer.render(240).join("\n")), /Sol 6\.1/);
			assert.deepEqual(await methods(), ["initialize", "initialized", "account/rateLimits/read"]);

			await reply({ error: { code: -1, message: "offline" } });
			await controls.refresh();
			verifyCreditLayouts(footer, "13 cr");
			assert.equal((await methods()).filter((method) => method === "account/rateLimits/read").length, 2);

			await reply(rateLimits(null));
			await controls.refresh();
			assert.doesNotMatch(footer.render(240).join("\n"), /\bcr\b|∞/);
			assert.match(stripVTControlCharacters(footer.render(240).join("\n")), /GPT/);
		}, { provider: "openai-codex", modelId: "gpt-6.1-sol", codexBin: binary, quotaEnabled: true });
	});
});

test("renders unlimited and zero credits without requiring a weekly window", async () => {
	await withCodexServer(rateLimits({ hasCredits: false, unlimited: true, balance: null }, false), async (binary, reply) => {
		await withFooter(async (footer, _statuses, controls) => {
			verifyCreditLayouts(footer, "∞ cr");
			await reply(rateLimits({ hasCredits: true, unlimited: false, balance: "0.00" }, false));
			await controls.refresh();
			verifyCreditLayouts(footer, "0 cr");
			await reply(rateLimits(null, false));
			await controls.refresh();
			assert.doesNotMatch(footer.render(240).join("\n"), /\bcr\b|∞|GPT/);
		}, { provider: "openai-codex", codexBin: binary, quotaEnabled: true });
	});
});

test("dims credits with the weekly snapshot and hides malformed data on a successful refresh", async () => {
	await withCodexServer(rateLimits({ hasCredits: true, unlimited: false, balance: "8" }, true, 1), async (binary, reply) => {
		await withFooter(async (footer, _statuses, controls) => {
			verifyCreditLayouts(footer, "8 cr", true);
			assert.match(footer.render(240).join("\n"), /\x1b\[2mGPT\x1b\[0m/);
			await reply(rateLimits({ hasCredits: true, unlimited: false, balance: "NaN" }));
			await controls.refresh();
			assert.doesNotMatch(footer.render(240).join("\n"), /\bcr\b|∞|NaN/);
			assert.match(stripVTControlCharacters(footer.render(240).join("\n")), /GPT/);
		}, { provider: "openai-codex", codexBin: binary, quotaEnabled: true });
	});
});

test("hides credits on initial failure without changing the weekly unavailable indicator", async () => {
	await withCodexServer({ error: { code: -1, message: "offline" } }, async (binary) => {
		await withFooter((footer) => {
			assert.match(stripVTControlCharacters(footer.render(240).join("\n")), /GPT \?/);
			assert.doesNotMatch(footer.render(240).join("\n"), /\bcr\b|∞/);
		}, { provider: "openai-codex", codexBin: binary, quotaEnabled: true });
	});
});

test("scopes Codex credits and lookups to enabled openai-codex models", async () => {
	await withCodexServer(rateLimits({ hasCredits: true, unlimited: false, balance: "8" }), async (binary, _reply, methods) => {
		for (const provider of ["anthropic", "openrouter", "openai"]) {
			await withFooter((footer) => {
				assert.doesNotMatch(footer.render(240).join("\n"), /\bcr\b|∞|GPT/);
			}, { provider, codexBin: binary, quotaEnabled: true });
		}
		await withFooter((footer) => {
			assert.doesNotMatch(footer.render(240).join("\n"), /\bcr\b|∞|GPT/);
		}, { provider: "openai-codex", codexBin: binary, quotaEnabled: false });
		assert.deepEqual(await methods(), []);
		await withFooter((footer, _statuses, controls) => {
			verifyCreditLayouts(footer, "8 cr");
			controls.setProvider("openrouter");
			assert.doesNotMatch(footer.render(240).join("\n"), /\bcr\b|∞|GPT/);
		}, { provider: "openai-codex", codexBin: binary, quotaEnabled: true });
		assert.deepEqual(await methods(), ["initialize", "initialized", "account/rateLimits/read"]);
	});
});

function claudeStatus(fields: Record<string, unknown> = {}): string {
	return JSON.stringify({
		status: "allowed_warning",
		resetsAt: Math.floor(Date.now() / 1000) + 3600,
		rateLimitType: "five_hour",
		isUsingOverage: false,
		utilization: 0.62,
		observedAt: Math.floor(Date.now() / 1000),
		...fields,
	});
}

function claudeCells(footer: Footer, layout: string): string[] {
	process.env.PI_STATUSLINE = layout;
	for (const width of [1, 20, 80, 120, 180, 240]) {
		assert.ok(footer.render(width).every((line) => visibleWidth(line) <= width), `${layout} at ${width}`);
	}
	const lines = footer.render(240);
	assert.equal(lines.length, layout === "table" ? 5 : 1);
	return stripVTControlCharacters(lines.join("\n")).split(/[│\n]/).map((cell) => cell.trim());
}

const CLAUDE_QUOTA_CELL = /(?:^|\s)(?:5h|Wk|Extra)(?:\s|$)|▮|>100%|· extra/;

test("renders the reported Claude window with its bar in both layouts", () => withFooter((footer, statuses) => {
	statuses.set("claude-rate-limit", claudeStatus());
	const compact = claudeCells(footer, "compact");
	assert.ok(compact.includes("▮▯▯ 5h"), compact.join(" | "));
	const table = claudeCells(footer, "table");
	assert.ok(table.some((cell) => /^▮▮▮▯▯▯ 5h · \d/.test(cell)), table.join(" | "));
	assert.doesNotMatch(table.join(" "), /\bWk\b|GPT/);
}, { provider: "pi-claude-cli", modelId: "claude-opus-5-5" }));

test("marks overage, extra usage and rejection, and shows a label without unknown utilization", () => withFooter((footer, statuses) => {
	statuses.set("claude-rate-limit", claudeStatus({ rateLimitType: "overage", utilization: 1.01, isUsingOverage: true }));
	assert.ok(claudeCells(footer, "compact").includes("▮▮▮ Extra >100% · extra"));

	statuses.set("claude-rate-limit", claudeStatus({ status: "rejected", rateLimitType: "seven_day", utilization: null }));
	const rejected = claudeCells(footer, "compact");
	assert.ok(rejected.includes("Wk limit"), rejected.join(" | "));
	assert.doesNotMatch(rejected.filter((cell) => !cell.endsWith("ctx")).join(" "), /▮|▯/);

	statuses.set("claude-rate-limit", claudeStatus({ status: "allowed", utilization: 0 }));
	assert.ok(claudeCells(footer, "compact").includes("▯▯▯ 5h"));
}, { provider: "pi-claude-cli", modelId: "claude-opus-5-5" }));

test("hides the Claude cell when quiet, malformed, expired, cleared or for another provider", () => withFooter((footer, statuses, controls) => {
	const hidden = () => {
		for (const layout of ["compact", "table"]) {
			const cells = claudeCells(footer, layout).filter((cell) => !/ctx$/.test(cell));
			assert.doesNotMatch(cells.join(" | "), CLAUDE_QUOTA_CELL, layout);
		}
	};
	for (const text of [
		claudeStatus({ status: "allowed", utilization: null }),
		"{not json",
		claudeStatus({ status: "mystery" }),
		claudeStatus({ resetsAt: Math.floor(Date.now() / 1000) - 1 }),
	]) {
		statuses.set("claude-rate-limit", text);
		hidden();
	}
	statuses.delete("claude-rate-limit");
	hidden();

	statuses.set("claude-rate-limit", claudeStatus());
	assert.ok(claudeCells(footer, "compact").includes("▮▯▯ 5h"));
	for (const provider of ["anthropic", "github-copilot", "openrouter", "openai-codex"]) {
		controls.setProvider(provider);
		hidden();
	}
}, { provider: "pi-claude-cli", modelId: "claude-opus-5-5" }));
