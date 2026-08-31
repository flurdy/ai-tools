import assert from "node:assert/strict";
import test from "node:test";
import { guardedToolBlockReason, isObviousMutation } from "./policy.ts";

test("blocks direct writes and known same-worktree child launch surfaces", () => {
	assert.match(guardedToolBlockReason("edit") ?? "", /guarded session/i);
	assert.match(guardedToolBlockReason("write") ?? "", /guarded session/i);
	assert.match(guardedToolBlockReason("subagent") ?? "", /isolated worktree/i);
	assert.equal(guardedToolBlockReason("read"), undefined);
	assert.equal(guardedToolBlockReason("jira_issue"), undefined);
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

test("does not mistake comparison operators or quoted prose for redirects", () => {
	for (const command of [
		"test 3 -gt 2",
		"printf '%s\\n' 'render width > 80'",
		"rg 'value >> 2' docs",
	]) {
		assert.equal(isObviousMutation(command), false, command);
	}
});

test("leaves unknown commands outside the bounded policy", () => {
	assert.equal(isObviousMutation("custom-generator --apply"), false);
});
