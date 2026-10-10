#!/usr/bin/env node
import { runCodexQuota } from "./codex-quota-report.ts";

runCodexQuota(process.argv.slice(2), {
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
}).then((code) => {
	process.exitCode = code;
});
