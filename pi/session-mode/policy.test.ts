import assert from "node:assert/strict";
import test from "node:test";
import { guardedToolBlockReason, isObviousMutation } from "./policy.ts";

test("blocks direct writes while leaving reads available", () => {
	assert.match(guardedToolBlockReason("edit") ?? "", /guarded session/i);
	assert.match(guardedToolBlockReason("write") ?? "", /guarded session/i);
	assert.equal(guardedToolBlockReason("read"), undefined);
	assert.equal(guardedToolBlockReason("jira_issue"), undefined);
});

test("permits read-only subagent management and cancellation", () => {
	for (const action of [
		"list",
		"get",
		"models",
		"children.list",
		"guide",
		"validate",
		"status",
		"debug.run",
		"doctor",
		"interrupt",
		"stop",
		"dismiss",
	]) {
		assert.equal(guardedToolBlockReason("subagent", { action }), undefined, action);
	}
});

test("permits only verified direct read-only subagents", () => {
	const options = { readOnlySubagents: new Set(["reviewer", "claude-code"]) };
	assert.equal(guardedToolBlockReason("subagent", { agent: "reviewer", task: "Review" }, options), undefined);
	assert.equal(guardedToolBlockReason("subagent", { agent: "claude-code", task: "Challenge" }, options), undefined);
	assert.match(guardedToolBlockReason("subagent", { agent: "worker", task: "Review" }, options) ?? "", /not verified read-only/i);
	assert.match(guardedToolBlockReason("subagent", { agent: "reviewer", gate: "git status" }, options) ?? "", /host gate/i);
	assert.match(guardedToolBlockReason("subagent", { agent: "reviewer", output: "report.md" }, options) ?? "", /output path/i);
	assert.match(guardedToolBlockReason("subagent", { agent: "reviewer", worktree: true }, options) ?? "", /worktree/i);
	assert.match(guardedToolBlockReason("subagent", { agent: "reviewer", share: true }, options) ?? "", /remote sharing/i);
});

test("permits read-only supervisor inspection but blocks messages to children", () => {
	assert.equal(guardedToolBlockReason("subagent_supervisor", { action: "status" }), undefined);
	assert.match(guardedToolBlockReason("subagent_supervisor", { action: "reply", to: "worker", message: "continue" }) ?? "", /guarded session/i);
});

test("blocks writable subagent controls and dynamic workflows", () => {
	for (const input of [
		{ action: "create", agent: "reviewer" },
		{ action: "resume", id: "run-1", message: "continue" },
		{ action: "steer", id: "run-1", message: "edit it" },
		{ workflowScript: "return runs.run('review', { agent: 'reviewer', task: 'Review' })" },
		{ workflowScriptPath: "review.js" },
	]) {
		assert.match(guardedToolBlockReason("subagent", input, { readOnlySubagents: new Set(["reviewer"]) }) ?? "", /guarded session/i);
	}
});

test("permits parallel composites only when every nested call is safe", () => {
	const options = { readOnlySubagents: new Set(["reviewer"]) };
	const safe = {
		tool_uses: [
			{ recipient_name: "functions.read", parameters: { path: "README.md" } },
			{ recipient_name: "functions.web_search", parameters: { query: "Pi extensions" } },
			{ recipient_name: "functions.subagent", parameters: { action: "status", id: "run-1" } },
		],
	};
	assert.equal(guardedToolBlockReason("multi_tool_use.parallel", safe, options), undefined);

	const blocked = {
		tool_uses: [
			...safe.tool_uses,
			{ recipient_name: "functions.subagent", parameters: { agent: "worker", task: "Review" } },
		],
	};
	assert.match(guardedToolBlockReason("multi_tool_use.parallel", blocked, options) ?? "", /nested call 4/i);
	assert.match(guardedToolBlockReason("multi_tool_use.parallel", { tool_uses: "invalid" }, options) ?? "", /malformed/i);
});

test("blocks obvious file, package, Git, and remote Beads mutations", () => {
	for (const command of [
		"rm -f result.txt",
		"printf done > result.txt",
		"cat input >> result.txt",
		"npm install lodash",
		"cargo add serde",
		"sed -i 's/old/new/' file.ts",
		"perl -pi -e 's/old/new/' file.ts",
		"git commit -m done",
		"git switch main",
		"git remote set-url origin elsewhere",
		"bash -c 'printf owned > tracked.txt'",
		"sh -c \"git commit -m nope\"",
		"bash -lc 'rm -f tracked.txt'",
		"env bash -c 'npm install lodash'",
		"bd delete ai-tools-1",
		"bd dolt push",
		"bd dolt pull",
	]) {
		assert.equal(isObviousMutation(command), true, command);
	}
});

test("permits reads and ordinary local Beads triage", () => {
	for (const command of [
		"git status --short",
		"git diff --check",
		"rg session-mode pi",
		"bd -C /tmp/repo show ai-tools-1 --json --readonly",
		"bd -C /tmp/repo create 'Clarify guard' --type task",
		"bd -C /tmp/repo update ai-tools-1 --append-notes note",
		"bd -C /tmp/repo close ai-tools-1",
	]) {
		assert.equal(isObviousMutation(command), false, command);
	}
});

test("does not mistake comparison operators, quoted prose, or read-only shell payloads for mutations", () => {
	for (const command of [
		"test 3 -gt 2",
		"printf '%s\\n' 'render width > 80'",
		"printf '%s\\n' 'bash -c \"rm file\"'",
		"rg 'value >> 2' docs",
		"bash -c 'git status --short'",
	]) {
		assert.equal(isObviousMutation(command), false, command);
	}
});

test("permits exact discard and file-descriptor redirects in read-only diagnostics", () => {
	for (const command of [
		"git worktree list --porcelain 2>/dev/null",
		"bd -C /tmp/repo show ai-tools-1 2> /dev/null",
		"find /tmp -type f 2>/dev/null | sort",
		"ls -ld /run/user/1000/pi-session-guard-1000/*.lock 2>/dev/null",
		"2>/dev/null rg session-mode pi",
		"command -v lslocks >/dev/null && lslocks",
		"printf done 1>/dev/null",
		"printf done &>/dev/null",
		"printf done 2>>/dev/null",
		"printf done 3>/dev/null",
		"printf done >/dev/null 2>&1",
		"printf done 2>&1",
	]) {
		assert.equal(isObviousMutation(command), false, command);
	}
});

test("continues to block real and dynamic redirect targets", () => {
	for (const command of [
		"printf done 2>/dev/null.bak",
		"printf done 2>/tmp/errors.log",
		"printf done &>output.log",
		"printf done 2>&$TARGET",
		"cat input 2>/dev/null > output.txt",
	]) {
		assert.equal(isObviousMutation(command), true, command);
	}
});

test("leaves unknown commands outside the bounded policy", () => {
	assert.equal(isObviousMutation("custom-generator --apply"), false);
});
