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
	["extensions/flurdy-prompt-shortcuts.ts", "pi/prompt-shortcuts/pi-prompt-shortcuts.ts"],
	["extensions/flurdy-skill-spotlight.ts", "pi/skill-spotlight/pi-skill-spotlight.ts"],
	["themes/flurdy-dark.json", "pi/theme/flurdy-dark.json"],
	["bin/codex-quota", "pi/quota/codex-quota.ts"],
	["bin/claude-quota", "pi/quota/claude-quota.ts"],
];

function fixture(run) {
	const artifacts = join(root, ".artifacts");
	mkdirSync(artifacts, { recursive: true });
	const dir = mkdtempSync(join(artifacts, "pi-apply-"));
	try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function make(dir, target, variables = {}) {
	const env = { ...process.env, HOME: dir };
	delete env.BIN_DIR;
	return spawnSync("make", [
		"--no-print-directory", target, `HOME=${dir}`, `PI_AGENT_DIR=${dir}`,
		`PI_EXTENSIONS_DIR=${dir}/extensions`, `PI_THEMES_DIR=${dir}/themes`,
		...Object.entries(variables).map(([key, value]) => `${key}=${value}`),
	], {
		cwd: root, env, encoding: "utf8", timeout: 15_000,
	});
}

function succeeded(result) {
	assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
}

test("apply and verify-apply install all managed links idempotently without touching user files", () => fixture((dir) => {
	mkdirSync(join(dir, "extensions"));
	mkdirSync(join(dir, "bin"));
	writeFileSync(join(dir, "bin/unrelated"), "preserve this command\n");
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
	assert.equal(readFileSync(join(dir, "bin/unrelated"), "utf8"), "preserve this command\n");
	for (const helper of ["codex-quota", "claude-quota"]) {
		const help = spawnSync(helper, ["--help"], {
			cwd: dir, env: { ...process.env, HOME: dir, PATH: `${dir}/bin:${process.env.PATH}` },
			encoding: "utf8", timeout: 5000,
		});
		succeeded(help);
		assert.match(help.stdout, new RegExp(`usage: ${helper}`));
		rmSync(join(dir, "bin", helper));
		assert.notEqual(make(dir, "verify-apply").status, 0, `missing ${helper} must fail verification`);
		symlinkSync(join(root, "pi/quota", `${helper}.ts`), join(dir, "bin", helper));
	}
	rmSync(join(dir, "extensions/flurdy-notify.ts"));
	assert.notEqual(make(dir, "verify-apply").status, 0, "missing notifier must fail verification");
	symlinkSync(join(root, "pi/notify/pi-notify.ts"), join(dir, "extensions/flurdy-notify.ts"));
	rmSync(join(dir, "extensions/flurdy-prompt-shortcuts.ts"));
	assert.notEqual(make(dir, "verify-apply").status, 0, "missing quick prompts must fail verification");
}));

test("apply honours an absolute BIN_DIR override with spaces", () => fixture((dir) => {
	const bin = join(dir, "shared commands");
	const variables = { BIN_DIR: bin };
	succeeded(make(dir, "apply", variables));
	succeeded(make(dir, "apply", variables));
	assert.equal(readlinkSync(join(bin, "codex-quota")), join(root, "pi/quota/codex-quota.ts"));
	assert.equal(readlinkSync(join(bin, "claude-quota")), join(root, "pi/quota/claude-quota.ts"));
	assert.equal(existsSync(join(dir, "bin")), false, "override must not also install into default bin");
	succeeded(make(dir, "verify-apply", variables));
	rmSync(join(bin, "codex-quota"));
	symlinkSync(join(dir, "missing-target"), join(bin, "codex-quota"));
	assert.notEqual(make(dir, "verify-apply", variables).status, 0, "wrong helper target must fail verification");
}));

for (const bin of ["", "relative/bin", "/"]) {
	test(`apply rejects unsafe BIN_DIR ${JSON.stringify(bin)} before creating links`, () => fixture((dir) => {
		const result = make(dir, "apply", { BIN_DIR: bin });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /BIN_DIR/);
		for (const [destination] of resources) assert.equal(existsSync(join(dir, destination)), false);
	}));
}

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
