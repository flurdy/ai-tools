import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
assert.ok(packageJson.keywords.includes("pi-package"), "package is missing the pi-package discovery keyword");
assert.deepEqual(packageJson.pi, { extensions: ["./pi/model-tier-router/index.ts"] });

const allowedRouterFiles = [
	"pi/model-tier-router/README.md",
	"pi/model-tier-router/config.ts",
	"pi/model-tier-router/index.ts",
	"pi/model-tier-router/model-tier-router.example.json",
	"pi/model-tier-router/model-tier-router.opinionated.example.json",
	"pi/model-tier-router/routing.ts",
	"pi/model-tier-router/usage-ledger.ts",
	"pi/model-tier-router/usage.ts",
];
assert.deepEqual([...packageJson.files].sort(), allowedRouterFiles, "package files must remain an exact allowlist");

const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
	cwd: repositoryRoot,
	encoding: "utf8",
});
const report = JSON.parse(output);
assert.equal(report.length, 1, "expected one npm pack report");

const files = new Set(report[0].files.map((entry) => entry.path));
const required = ["LICENSE", "package.json", ...allowedRouterFiles];
for (const path of required) assert.ok(files.has(path), `package is missing ${path}`);

const allowedRouterFileSet = new Set(allowedRouterFiles);
for (const path of files) {
	if (path.startsWith("pi/model-tier-router/")) {
		assert.ok(allowedRouterFileSet.has(path), `unexpected router package file: ${path}`);
	}
	assert.ok(!path.endsWith(".test.ts"), `test file leaked into package: ${path}`);
	assert.ok(!path.includes("usage/v1/"), `usage data leaked into package: ${path}`);
	assert.notEqual(path, "pi/model-tier-router/model-tier-router.json", "local configuration leaked into package");
}

console.log(`Package allowlist verified (${files.size} files).`);
