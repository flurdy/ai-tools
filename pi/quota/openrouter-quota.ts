#!/usr/bin/env node
import { runOpenRouterQuota } from "./openrouter-quota-report.ts";

runOpenRouterQuota(process.argv.slice(2), {
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
}).then((code) => {
	process.exitCode = code;
});
