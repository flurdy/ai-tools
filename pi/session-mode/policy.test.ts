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

test("permits discard-only error redirects in read-only diagnostics", () => {
	for (const command of [
		"git worktree list --porcelain 2>/dev/null",
		"bd -C /tmp/repo show ai-tools-1 2> /dev/null",
		"find /tmp -type f 2>/dev/null | sort",
		"ls -ld /run/user/1000/pi-session-guard-1000/*.lock 2>/dev/null",
		"2>/dev/null rg session-mode pi",
	]) {
		assert.equal(isObviousMutation(command), false, command);
	}
});

test("continues to block non-stderr and non-discard redirects", () => {
	for (const command of [
		"printf done >/dev/null",
		"printf done 1>/dev/null",
		"printf done &>/dev/null",
		"printf done 2>>/dev/null",
		"printf done 3>/dev/null",
		"printf done 2>/dev/null.bak",
		"printf done 2>/tmp/errors.log",
		"cat input 2>/dev/null > output.txt",
	]) {
		assert.equal(isObviousMutation(command), true, command);
	}
});

test("leaves unknown commands outside the bounded policy", () => {
	assert.equal(isObviousMutation("custom-generator --apply"), false);
});
