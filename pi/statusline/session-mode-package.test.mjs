import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync, existsSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./session-mode-package.mjs", import.meta.url));
function fixture(run) {
	const root = mkdtempSync(join(tmpdir(), "pi-observer-dependency-"));
	const consumer = join(root, "consumer");
	const source = join(root, "source");
	mkdirSync(consumer);
	mkdirSync(source);
	const manifest = { name: "@flurdy/pi-session-mode", type: "module", exports: { "./lease-observer": "./lease-observer.ts" } };
	writeFileSync(join(source, "package.json"), JSON.stringify(manifest));
	writeFileSync(join(source, "lease-observer.ts"), "export const DEFAULT_LEASE_OCCUPANCY_TIMEOUT_MS = 2000;\n");
	const call = (mode, target = source) => spawnSync(process.execPath, [script, mode, target, consumer], { encoding: "utf8" });
	const link = join(consumer, "node_modules", "@flurdy", "pi-session-mode");
	try { run({ consumer, source, manifest, call, link, root }); }
	finally { rmSync(root, { recursive: true, force: true }); }
}

test("links a selected package, resolves its export and verifies idempotently", () => fixture(({ source, call, link }) => {
	assert.equal(call("link").status, 0);
	assert.equal(realpathSync(link), realpathSync(source));
	assert.equal(call("verify").status, 0);
	assert.equal(call("link").status, 0);
}));

test("missing or pruned dependency fails with recovery guidance without creating files", () => fixture(({ call, link }) => {
	const missing = call("verify");
	assert.notEqual(missing.status, 0);
	assert.match(missing.stderr, /prepare-statusline/);
	assert.equal(existsSync(link), false);
	assert.equal(call("link").status, 0);
	unlinkSync(link);
	assert.notEqual(call("verify").status, 0);
}));

test("rejects wrong package identity and missing or redirected exports before linking", () => fixture(({ source, manifest, call, link }) => {
	for (const bad of [{ ...manifest, name: "unrelated" }, { ...manifest, exports: {} }, { ...manifest, exports: { "./lease-observer": "../outside.ts" } }]) {
		writeFileSync(join(source, "package.json"), JSON.stringify(bad));
		assert.notEqual(call("link").status, 0);
		assert.equal(existsSync(link), false);
	}
	writeFileSync(join(source, "package.json"), JSON.stringify(manifest));
	rmSync(join(source, "lease-observer.ts"));
	assert.notEqual(call("link").status, 0);
	assert.equal(existsSync(link), false);
}));

test("canonicalizes package aliases and rejects mismatched links", () => fixture(({ source, call, link, root }) => {
	const alias = join(root, "alias");
	symlinkSync(source, alias);
	assert.equal(call("link", alias).status, 0);
	assert.equal(call("verify", source).status, 0);
	unlinkSync(link);
	symlinkSync(root, link);
	assert.notEqual(call("verify").status, 0);
}));

test("does not overwrite an unmanaged directory", () => fixture(({ call, link }) => {
	mkdirSync(link, { recursive: true });
	writeFileSync(join(link, "keep"), "owned elsewhere");
	assert.notEqual(call("link").status, 0);
	assert.equal(existsSync(join(link, "keep")), true);
}));
