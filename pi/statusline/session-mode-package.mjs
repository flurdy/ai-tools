import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const [mode, suppliedPackage, suppliedConsumer] = process.argv.slice(2);
const consumer = resolve(suppliedConsumer ?? dirname(fileURLToPath(import.meta.url)));
const selected = suppliedPackage || process.env.SESSION_MODE_PACKAGE || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "extensions", "flurdy-session-mode");
const dependency = join(consumer, "node_modules", "@flurdy", "pi-session-mode");

try {
	if (mode !== "link" && mode !== "verify") throw new Error("Expected link or verify");
	const packageRoot = realpathSync(selected);
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	if (manifest.name !== "@flurdy/pi-session-mode") throw new Error("Selected package is not @flurdy/pi-session-mode");
	if (manifest.exports?.["./lease-observer"] !== "./lease-observer.ts") throw new Error("Selected package does not export ./lease-observer.ts");
	const observer = realpathSync(join(packageRoot, "lease-observer.ts"));
	if (!observer.startsWith(`${packageRoot}${sep}`) || !statSync(observer).isFile()) throw new Error("Observer export is outside its package or not a file");
	let existing;
	try { existing = lstatSync(dependency); }
	catch (error) { if (error.code !== "ENOENT") throw error; }
	if (mode === "link") {
		if (existing && !existing.isSymbolicLink()) throw new Error("Refusing to overwrite an unmanaged dependency directory");
		if (existing) {
			let target;
			try { target = realpathSync(dependency); }
			catch (error) { if (error.code !== "ENOENT") throw error; }
			if (target !== packageRoot) { unlinkSync(dependency); existing = undefined; }
		}
		if (!existing) {
			mkdirSync(dirname(dependency), { recursive: true });
			symlinkSync(packageRoot, dependency, "dir");
		}
	}
	if (!lstatSync(dependency).isSymbolicLink() || realpathSync(dependency) !== packageRoot) throw new Error("Observer dependency does not match the selected package");
	const require = createRequire(join(consumer, "package.json"));
	if (realpathSync(require.resolve("@flurdy/pi-session-mode/lease-observer")) !== observer) throw new Error("Observer export resolves to a different source");
	console.log(`Session-mode observer dependency: PASS (${packageRoot})`);
} catch (error) {
	console.error(`${error.message}\nRun make prepare-statusline SESSION_MODE_PACKAGE=/path/to/reviewed/pi-session-mode from the ai-tools root.`);
	process.exitCode = 1;
}
