#!/usr/bin/env node
import { runClaudeQuota } from "./claude-quota-report.ts";

runClaudeQuota(process.argv.slice(2), {
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
}).then((code) => {
	process.exitCode = code;
});
