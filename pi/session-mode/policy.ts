const GUARDED_TOOL_REASONS = new Map<string, string>([
	["edit", "Guarded session: direct file edits are disabled. Switch to /implement after acquiring the worktree lease."],
	["write", "Guarded session: direct file writes are disabled. Switch to /implement after acquiring the worktree lease."],
]);

const READ_ONLY_SUBAGENT_ACTIONS = new Set([
	"list",
	"get",
	"models",
	"children.list",
	"guide",
	"validate",
	"mission.list",
	"mission.show",
	"lane.status",
	"refine.show",
	"inspector.status",
	"project.status",
	"status",
	"debug.run",
	"doctor",
	"watchdog.status",
	"watchdog.check",
	"watchdog.recommend-model",
	"schedule.list",
	"schedule.show",
	"schedule.history",
	"interrupt",
	"stop",
	"dismiss",
]);

const READ_ONLY_SUPERVISOR_ACTIONS = new Set(["list", "pending", "status"]);
const GUARDED_MUTATION_REASON = "Guarded session: obvious source, Git, package, system, or remote Beads mutation blocked. Use /implement first.";
const SUBAGENT_BLOCK_REASON = "Guarded session: this subagent operation may launch or control a writer in the current worktree. Use a verified read-only agent or switch to /implement.";

export interface GuardedToolPolicyOptions {
	readOnlySubagents?: ReadonlySet<string>;
}

const FILE_MUTATION = /\b(?:rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|tee|truncate|dd|shred|patch|rsync)\b/i;
const IN_PLACE_MUTATION = /\b(?:sed\s+(?:-[A-Za-z]*i[A-Za-z]*\b|--in-place\b)|perl\s+-[A-Za-z]*p?i[A-Za-z]*\b|tar\s+[^\n;&|]*-[A-Za-z]*x|unzip\b|vim?\b|nano\b|emacs\b|subl\b|code\s+[^\n;&|]*--wait\b)/i;
const PACKAGE_MUTATION =
	/\b(?:npm\s+(?:install|uninstall|update|ci|link|publish)|yarn\s+(?:add|remove|install|publish)|pnpm\s+(?:add|remove|install|update|publish)|pipx?\s+(?:install|uninstall)|cargo\s+(?:add|remove|install|uninstall|update|publish)|go\s+(?:get|install)|go\s+mod\s+(?:download|edit|init|tidy|vendor)|bundle\s+(?:install|update)|gem\s+(?:install|uninstall|update)|composer\s+(?:install|update|require|remove)|apt(?:-get)?\s+(?:install|remove|purge|update|upgrade)|brew\s+(?:install|uninstall|upgrade))\b/i;
const GIT_MUTATION =
	/\bgit(?:\s+-[A-Za-z]\s+\S+)*\s+(?:add|am|apply|bisect|branch\s+(?!--(?:show-current|list|contains|merged|no-merged)\b)|checkout|cherry-pick|clean|clone|commit|config\s+(?!--get\b|--get-all\b|--list\b)|fetch|gc|init|merge|mv|notes|pull|push|rebase|reflog\s+expire|remote\s+(?:add|remove|rename|set-url|set-head|prune|update)|reset|restore|revert|rm|stash|submodule\s+(?:add|deinit|update)|switch|tag\s+(?!-l\b|--list\b)|update-ref|worktree\s+(?:add|move|remove|prune|repair|lock|unlock))\b/i;
const BEADS_DESTRUCTIVE_OR_REMOTE =
	/\bbd\b[^\n;&|]*(?:\bdelete\b|\bpurge\b|\bmigrate\b|\bcleanup\b|\bdolt\s+(?:push|pull|fetch|reset|checkout|merge|remote)\b)/i;
const SYSTEM_MUTATION =
	/\b(?:sudo|su|kill|pkill|killall|reboot|shutdown)\b|\b(?:systemctl|service)\s+(?:\S+\s+)?(?:start|stop|restart|enable|disable)\b/i;
const DISCARDED_OUTPUT_REDIRECT = /(?:\d+|&)?>>?[ \t]*\/dev\/null(?![\w/.-])/g;
const FILE_DESCRIPTOR_DUPLICATION = /\d*>&(?:\d+|-)(?!\d)/g;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function subagentBlockReason(input: unknown, options: GuardedToolPolicyOptions): string | undefined {
	if (!isRecord(input)) return `${SUBAGENT_BLOCK_REASON} The call input is malformed.`;
	if (typeof input.action === "string") {
		return READ_ONLY_SUBAGENT_ACTIONS.has(input.action) ? undefined : SUBAGENT_BLOCK_REASON;
	}
	if (input.workflowScript !== undefined || input.workflowScriptPath !== undefined) {
		return `${SUBAGENT_BLOCK_REASON} Dynamic workflows require resolved-child policy integration.`;
	}
	if (typeof input.agent !== "string" || !options.readOnlySubagents?.has(input.agent)) {
		return `${SUBAGENT_BLOCK_REASON} Agent '${String(input.agent ?? "unknown")}' is not verified read-only.`;
	}
	if (input.gate !== undefined) return `${SUBAGENT_BLOCK_REASON} Host gate commands are not allowed.`;
	if (typeof input.output === "string" || input.outputMode === "file-only" || input.sessionDir !== undefined) {
		return `${SUBAGENT_BLOCK_REASON} Explicit output paths are not allowed.`;
	}
	if (input.worktree === true || input.isolation === "worktree") {
		return `${SUBAGENT_BLOCK_REASON} Managed worktree creation is not allowed.`;
	}
	if (input.share === true) return `${SUBAGENT_BLOCK_REASON} Remote sharing is not allowed.`;
	return undefined;
}

function normalizedNestedToolName(recipientName: string): string {
	return recipientName.startsWith("functions.") ? recipientName.slice("functions.".length) : recipientName;
}

function parallelBlockReason(input: unknown, options: GuardedToolPolicyOptions, depth: number): string | undefined {
	if (!isRecord(input) || !Array.isArray(input.tool_uses) || input.tool_uses.length === 0 || depth >= 4) {
		return "Guarded session: malformed or excessively nested parallel tool call blocked.";
	}
	for (const [index, nested] of input.tool_uses.entries()) {
		if (!isRecord(nested) || typeof nested.recipient_name !== "string" || !isRecord(nested.parameters)) {
			return `Guarded session: malformed nested call ${index + 1} blocked.`;
		}
		const reason = guardedToolBlockReason(normalizedNestedToolName(nested.recipient_name), nested.parameters, options, depth + 1);
		if (reason) return `Guarded session: nested call ${index + 1} blocked. ${reason}`;
	}
	return undefined;
}

export function guardedToolBlockReason(
	toolName: string,
	input?: unknown,
	options: GuardedToolPolicyOptions = {},
	depth = 0,
): string | undefined {
	const directReason = GUARDED_TOOL_REASONS.get(toolName);
	if (directReason) return directReason;
	if (toolName === "bash") {
		const command = isRecord(input) ? input.command : undefined;
		return typeof command === "string" && isObviousMutation(command) ? GUARDED_MUTATION_REASON : undefined;
	}
	if (toolName === "subagent") return subagentBlockReason(input, options);
	if (toolName === "subagent_supervisor") {
		const action = isRecord(input) ? input.action : undefined;
		return typeof action === "string" && READ_ONLY_SUPERVISOR_ACTIONS.has(action) ? undefined : SUBAGENT_BLOCK_REASON;
	}
	if (toolName === "multi_tool_use.parallel") return parallelBlockReason(input, options, depth);
	return undefined;
}

function withoutQuotedText(command: string): string {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let result = "";
	for (const character of command) {
		if (escaped) {
			result += quote ? " " : character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			result += quote ? " " : character;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			result += " ";
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			result += " ";
			continue;
		}
		result += character;
	}
	return result;
}

function shellWords(command: string): string[] {
	const words: string[] = [];
	let word = "";
	let started = false;
	let quote: "'" | '"' | undefined;
	let escaped = false;
	const push = () => {
		if (started) words.push(word);
		word = "";
		started = false;
	};
	for (const character of command) {
		if (escaped) {
			word += character;
			started = true;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			started = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else word += character;
			started = true;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			started = true;
			continue;
		}
		if (/\s/.test(character) || /[;&|()]/.test(character)) {
			push();
			continue;
		}
		word += character;
		started = true;
	}
	push();
	return words;
}

function constantShellPayloads(command: string): string[] {
	const shells = new Set(["bash", "sh", "zsh", "dash", "fish"]);
	const words = shellWords(command);
	const payloads: string[] = [];
	for (let index = 0; index < words.length; index += 1) {
		const executable = words[index]?.split("/").at(-1);
		if (!executable || !shells.has(executable)) continue;
		for (let optionIndex = index + 1; optionIndex < words.length; optionIndex += 1) {
			const option = words[optionIndex];
			if (!option?.startsWith("-") || option === "-") break;
			if (/^-[A-Za-z]*c[A-Za-z]*$/.test(option)) {
				const payload = words[optionIndex + 1];
				if (payload !== undefined) payloads.push(payload);
				break;
			}
		}
	}
	return payloads;
}

function isObviousMutationAtDepth(command: string, depth: number): boolean {
	if (depth < 4 && constantShellPayloads(command).some((payload) => isObviousMutationAtDepth(payload, depth + 1))) return true;
	const inspectable = withoutQuotedText(command)
		.replace(DISCARDED_OUTPUT_REDIRECT, " ")
		.replace(FILE_DESCRIPTOR_DUPLICATION, " ");
	return (
		/(^|[^<])>>?/.test(inspectable) ||
		FILE_MUTATION.test(inspectable) ||
		IN_PLACE_MUTATION.test(inspectable) ||
		PACKAGE_MUTATION.test(inspectable) ||
		GIT_MUTATION.test(inspectable) ||
		BEADS_DESTRUCTIVE_OR_REMOTE.test(inspectable) ||
		SYSTEM_MUTATION.test(inspectable)
	);
}

export function isObviousMutation(command: string): boolean {
	return isObviousMutationAtDepth(command, 0);
}
