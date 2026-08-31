import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";

test("persisted session-mode entries are inert when the extension is absent", () => {
	const manager = SessionManager.inMemory("/tmp/session-mode-rollback");
	manager.appendCustomEntry("session-mode", { version: 1, mode: "plan" });
	const context = manager.buildSessionContext();
	assert.deepEqual(context.messages, []);
});
