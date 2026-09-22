import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resources = [
	["extensions/flurdy-statusline", "pi/statusline"],
	["extensions/flurdy-kitty-tab-title.ts", "pi/kitty-tab-title/pi-kitty-tab-title.ts"],
	["extensions/flurdy-notify.ts", "pi/notify/pi-notify.ts"],
	["themes/flurdy-dark.json", "pi/theme/flurdy-dark.json"],
];

function fixture(run) {
	const artifacts = join(root, ".artifacts");
	mkdirSync(artifacts, { recursive: true });
	const dir = mkdtempSync(join(artifacts, "pi-apply-"));
	try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function make(dir, target) {
	return spawnSync("make", ["--no-print-directory", target, `PI_AGENT_DIR=${dir}`, `PI_EXTENSIONS_DIR=${dir}/extensions`, `PI_THEMES_DIR=${dir}/themes`], {
		cwd: root, encoding: "utf8", timeout: 15_000,
	});
}

function succeeded(result) {
	assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
}

test("apply and verify-apply install all managed links idempotently without touching user files", () => fixture((dir) => {
	mkdirSync(join(dir, "extensions"));
	writeFileSync(join(dir, "settings.json"), '{"theme":"personal"}\n');
	writeFileSync(join(dir, "extensions/unrelated.ts"), "// unrelated extension\n");
	succeeded(make(dir, "apply"));
	succeeded(make(dir, "apply"));
	for (const [destination, source] of resources) {
		assert.equal(readlinkSync(join(dir, destination)), join(root, source));
		assert.ok(existsSync(join(dir, destination)));
	}
	succeeded(make(dir, "verify-apply"));
	assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), '{"theme":"personal"}\n');
	assert.equal(readFileSync(join(dir, "extensions/unrelated.ts"), "utf8"), "// unrelated extension\n");
	rmSync(join(dir, "extensions/flurdy-notify.ts"));
	assert.notEqual(make(dir, "verify-apply").status, 0, "missing notifier must fail verification");
}));

for (const [destination] of resources) {
	for (const kind of ["file", "directory", "symlink"]) {
		test(`apply refuses ${kind} collision at ${destination} before installing any links`, () => fixture((dir) => {
			const path = join(dir, destination);
			mkdirSync(dirname(path), { recursive: true });
			if (kind === "file") writeFileSync(path, "preserve me");
			if (kind === "directory") mkdirSync(path);
			if (kind === "symlink") symlinkSync(join(dir, "missing-unrelated-target"), path);
			const result = make(dir, "apply");
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /Refusing to replace/);
			if (kind === "file") assert.equal(readFileSync(path, "utf8"), "preserve me");
			if (kind === "symlink") assert.equal(readlinkSync(path), join(dir, "missing-unrelated-target"));
			for (const [other] of resources) {
				if (other !== destination) assert.equal(existsSync(join(dir, other)), false);
			}
		}));
	}
}
