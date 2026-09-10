import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	buildLabel,
	normalizeSessionName,
	registerPiKittyTabTitle,
} from "./pi-kitty-tab-title.ts";

const cases = JSON.parse(
	readFileSync(new URL("../../shared/kitty/session-name-cases.json", import.meta.url), "utf8"),
) as Array<{ name: string; input: string; expected: string }>;

function withEnvironment(values: Record<string, string | undefined>, run: () => void): void {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(values)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		run();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function registerOutsideOrca(pi: Parameters<typeof registerPiKittyTabTitle>[0], writeTitle: (title: string) => void): void {
	withEnvironment({ ORCA_PANE_KEY: undefined, PI_KITTY_TITLE_ALLOW_ORCA: undefined }, () => {
		registerPiKittyTabTitle(pi, writeTitle);
	});
}

function git(command: string[], cwd: string): void {
	execFileSync("git", command, { cwd, stdio: "ignore" });
}

function context(cwd: string, sessionId = `test-${Date.now()}-${Math.random()}`): any {
	return {
		cwd,
		sessionManager: { getSessionId: () => sessionId },
		ui: { notify: () => undefined },
	};
}

test("normalizes session names with the shared Kitty contract", () => {
	for (const fixture of cases) {
		assert.equal(normalizeSessionName(fixture.input), fixture.expected, fixture.name);
	}
});

test("named sessions replace branch and watcher context while preserving the repo alias", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-kitty-title-"));
	try {
		git(["init", "-q", "-b", "main"], root);
		git(["checkout", "-q", "-b", "feature/AB-123-example"], root);
		withEnvironment({ KITTY_TITLE_REPO_ALIAS: "workspace", SSH_TTY: undefined }, () => {
			const ctx = context(root);
			assert.equal(buildLabel(ctx, "/watch-prs", " Foreman design "), "π·-workspace/Foreman-design");
			assert.equal(buildLabel(ctx, "/watch-prs", "   "), "π·-workspace/AB-123·👀-PRs");
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("unnamed main sessions retain Beads and closed-marker fallbacks", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-kitty-title-beads-"));
	const sessionId = `beads-${Date.now()}-${Math.random()}`;
	try {
		git(["init", "-q", "-b", "main"], root);
		const repo = root.split("/").at(-1) ?? "repo";
		const bead = `${repo}-abc`;
		mkdirSync(join(root, ".beads"));
		writeFileSync(join(root, ".beads", "issues.jsonl"), `${JSON.stringify({ id: bead, status: "in_progress" })}\n`);
		const ctx = context(root, sessionId);
		assert.equal(buildLabel(ctx), `π·-${repo}/abc`);
		writeFileSync(join(root, ".beads", "issues.jsonl"), `${JSON.stringify({ id: bead, status: "closed", closed_at: "2026-07-31" })}\n`);
		assert.equal(buildLabel(ctx), `π·-${repo}/✓abc`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("structured question state overrides lifecycle and survives session rename", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-kitty-title-question-"));
	try {
		git(["init", "-q", "-b", "main"], root);
		git(["checkout", "-q", "-b", "fix/AB-42-title"], root);
		const handlers = new Map<string, (event: any, ctx: any) => void>();
		const customHandlers = new Map<string, (payload: unknown) => void>();
		let sessionName: string | undefined;
		const titles: string[] = [];
		const pi = {
			on: (event: string, handler: (payload: any, ctx: any) => void) => handlers.set(event, handler),
			events: {
				on: (event: string, handler: (payload: unknown) => void) => {
					customHandlers.set(event, handler);
					return () => customHandlers.delete(event);
				},
			},
			getSessionName: () => sessionName,
		};
		registerOutsideOrca(pi as any, (title) => titles.push(title));
		const ctx = context(root);

		handlers.get("tool_execution_start")?.(
			{ type: "tool_execution_start", toolName: "ask_user_question", args: {} },
			ctx,
		);
		customHandlers.get("rpiv:ask-user:blocked")?.({ active: true });
		sessionName = "Question pending";
		handlers.get("session_info_changed")?.(
			{ type: "session_info_changed", name: sessionName },
			ctx,
		);
		customHandlers.get("rpiv:ask-user:blocked")?.({ active: false });
		handlers.get("tool_execution_end")?.(
			{ type: "tool_execution_end", toolName: "ask_user_question" },
			ctx,
		);

		assert.match(titles[0] ?? "", /\/AB-42·⚙️$/);
		assert.match(titles[1] ?? "", /\/AB-42·❓$/);
		assert.match(titles[2] ?? "", /\/Question-pending·❓$/);
		assert.match(titles[3] ?? "", /\/Question-pending·⚙️$/);
		assert.match(titles[4] ?? "", /\/Question-pending·💭$/);

		customHandlers.get("rpiv:ask-user:blocked")?.({ active: true });
		handlers.get("tool_execution_end")?.(
			{ type: "tool_execution_end", toolName: "ask_user_question" },
			ctx,
		);
		assert.match(titles[5] ?? "", /\/Question-pending·❓$/);
		assert.match(titles[6] ?? "", /\/Question-pending·💭$/);

		customHandlers.get("rpiv:ask-user:blocked")?.({ active: true });
		handlers.get("agent_end")?.({ type: "agent_end" }, ctx);
		assert.match(titles[7] ?? "", /\/Question-pending·❓$/);
		assert.match(titles[8] ?? "", /\/Question-pending·✅$/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("session_info_changed refreshes immediately and clearing restores fallback state", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-kitty-title-events-"));
	try {
		git(["init", "-q", "-b", "main"], root);
		git(["checkout", "-q", "-b", "fix/AB-42-title"], root);
		const handlers = new Map<string, (event: any, ctx: any) => void>();
		let sessionName: string | undefined;
		const titles: string[] = [];
		const pi = {
			on: (event: string, handler: (payload: any, ctx: any) => void) => handlers.set(event, handler),
			events: { on: () => () => undefined },
			getSessionName: () => sessionName,
		};
		registerOutsideOrca(pi as any, (title) => titles.push(title));
		const ctx = context(root);
		handlers.get("session_start")?.({ type: "session_start" }, ctx);
		handlers.get("agent_end")?.({ type: "agent_end" }, ctx);
		sessionName = "Title work";
		handlers.get("session_info_changed")?.({ type: "session_info_changed", name: sessionName }, ctx);
		sessionName = undefined;
		handlers.get("session_info_changed")?.({ type: "session_info_changed", name: undefined }, ctx);
		assert.match(titles[0] ?? "", /\/AB-42·🌱$/);
		assert.match(titles[1] ?? "", /\/AB-42·✅$/);
		assert.match(titles[2] ?? "", /\/Title-work·✅$/);
		assert.match(titles[3] ?? "", /\/AB-42·✅$/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Orca-managed panes silently disable this competing title writer", () => {
	withEnvironment({ ORCA_PANE_KEY: "pane-1", PI_KITTY_TITLE_ALLOW_ORCA: undefined }, () => {
		const handlers = new Map<string, (event: any, ctx: any) => void>();
		const titles: string[] = [];
		registerPiKittyTabTitle(
			{ on: (event: string, handler: (payload: any, ctx: any) => void) => handlers.set(event, handler) } as any,
			(title) => titles.push(title),
		);
		assert.deepEqual([...handlers.keys()], []);
		assert.deepEqual(titles, []);
	});
});

test("Orca override enables this writer only after explicit conflict resolution", () => {
	withEnvironment({ ORCA_PANE_KEY: "pane-1", PI_KITTY_TITLE_ALLOW_ORCA: "1" }, () => {
		const handlers = new Map<string, (event: any, ctx: any) => void>();
		const titles: string[] = [];
		registerPiKittyTabTitle(
			{
				on: (event: string, handler: (payload: any, ctx: any) => void) => handlers.set(event, handler),
				events: { on: () => () => undefined },
				getSessionName: () => "Orca resolved",
			} as any,
			(title) => titles.push(title),
		);
		assert.ok(handlers.has("session_info_changed"));
		handlers.get("session_start")?.(
			{ type: "session_start" },
			{ cwd: "/tmp", sessionManager: { getSessionId: () => "orca-override" }, ui: { notify: () => undefined } },
		);
		assert.match(titles[0] ?? "", /\/Orca-resolved·🌱$/);
	});
});
