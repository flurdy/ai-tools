const GUARDED_TOOL_REASONS = new Map<string, string>([
	["edit", "Guarded session: direct file edits are disabled. Switch to /implement after acquiring the worktree lease."],
	["write", "Guarded session: direct file writes are disabled. Switch to /implement after acquiring the worktree lease."],
	["powershell", "Guarded session: PowerShell commands are disabled. Switch to /implement after acquiring the worktree lease."],
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
const GIT_GLOBAL_OPTION = /(?:-[A-Za-z]\s+\S+|--(?:git-dir|work-tree|namespace|super-prefix|config-env)\s+\S+|--[A-Za-z][\w-]*(?:=\S+)?)/;
const GIT_MUTATION = new RegExp(
	`\\bgit(?:\\s+${GIT_GLOBAL_OPTION.source})*\\s+(?:add|am|apply|bisect|branch\\s+(?!--(?:show-current|list|contains|merged|no-merged)\\b)|checkout|cherry-pick|clean|clone|commit|config\\s+(?!--get\\b|--get-all\\b|--list\\b)|fetch|gc|init|merge|mv|notes|pull|push|rebase|reflog\\s+expire|remote\\s+(?:add|remove|rename|set-url|set-head|prune|update)|reset|restore|revert|rm|stash|submodule\\s+(?:add|deinit|update)|switch|tag\\s+(?!-l\\b|--list\\b)|update-ref|worktree\\s+(?:add|move|remove|prune|repair|lock|unlock))\\b`,
	"i",
);
const BEADS_DESTRUCTIVE_OR_REMOTE =
	/\bbd\b[^\n;&|]*(?:\bdelete\b|\bpurge\b|\bmigrate\b|\bcleanup\b|\bdolt\s+(?:push|pull|fetch|reset|checkout|merge|remote)\b)/i;
const SYSTEM_MUTATION =
	/\b(?:sudo|su|kill|pkill|killall|reboot|shutdown)\b|\b(?:systemctl|service)\s+(?:\S+\s+)?(?:start|stop|restart|enable|disable)\b/i;
const MAX_PARALLEL_DEPTH = 4;
const MAX_INSPECTION_DEPTH = 4;
const SAFE_PARALLEL_TOOL_NAMES = new Set([
	"read",
	"web_search",
	"source_check",
	"fetch_content",
	"get_search_content",
	"jira_issue",
	"confluence_page",
	"story_context",
	"figma_context",
	"figma_parse_url",
	"figma_auth_status",
	"figma_get_design_context",
	"figma_get_node_summary",
	"figma_get_implementation_context",
	"figma_extract_text",
	"figma_find_nodes_by_name",
	"figma_find_nodes_by_text",
	"figma_extract_assets",
	"figma_get_styles",
	"figma_get_variables",
	"figma_get_components",
	"figma_get_component_sets",
	"figma_get_comments",
	"figma_search_components",
	"figma_get_image_fills",
	"figma_get_file_raw",
	"figma_get_nodes_raw",
	"ask_user_question",
	"bash",
	"subagent",
	"subagent_supervisor",
	"multi_tool_use.parallel",
]);
const DISCARDED_OUTPUT_REDIRECT = /(?:\d+|&)?>>?[ \t]*\/dev\/null(?=$|[\s;&|()<>])/g;
const FILE_DESCRIPTOR_DUPLICATION = /\d*>&(?:\d+|-)(?=$|[\s;&|()<>])/g;

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
	if (input.cwd !== undefined) return `${SUBAGENT_BLOCK_REASON} Alternate cwd is not allowed.`;
	if (input.agentScope !== undefined) return `${SUBAGENT_BLOCK_REASON} Alternate agent scope is not allowed.`;
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
	if (!isRecord(input) || !Array.isArray(input.tool_uses) || input.tool_uses.length === 0 || depth >= MAX_PARALLEL_DEPTH) {
		return "Guarded session: malformed or excessively nested parallel tool call blocked.";
	}
	for (const [index, nested] of input.tool_uses.entries()) {
		if (!isRecord(nested) || typeof nested.recipient_name !== "string" || !isRecord(nested.parameters)) {
			return `Guarded session: malformed nested call ${index + 1} blocked.`;
		}
		const toolName = normalizedNestedToolName(nested.recipient_name);
		if (!SAFE_PARALLEL_TOOL_NAMES.has(toolName)) return `Guarded session: unknown nested tool '${toolName}' blocked.`;
		const reason = guardedToolBlockReason(toolName, nested.parameters, options, depth + 1);
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

function unquoteGitGlobalOptionValues(command: string): string {
	return command.replace(
		/(--(?:git-dir|work-tree|namespace|super-prefix|config-env))(=|\s+)(["'])([^"']*)\3/g,
		"$1$2$4",
	);
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

function shellOptionValueCount(executable: string, option: string): number {
	if (/^--(?:rcfile|init-file)=/.test(option)) return 0;
	if (option === "--rcfile" || option === "--init-file") return 1;
	if ((executable === "bash" || executable === "zsh") && (option === "-o" || option === "+o" || option === "-O" || option === "+O")) return 1;
	if (executable === "fish" && (option === "-C" || option === "--init-command")) return 1;
	return 0;
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
			if (!option?.startsWith("-") || option === "-" || option === "--") break;
			if (/^-[A-Za-z]*c[A-Za-z]*$/.test(option)) {
				const payload = words[optionIndex + 1];
				if (payload !== undefined) payloads.push(payload);
				break;
			}
			optionIndex += shellOptionValueCount(executable, option);
		}
	}
	return payloads;
}

function isObviousMutationAtDepth(command: string, depth: number): boolean {
	const payloads = constantShellPayloads(command);
	if (payloads.length > 0 && depth >= MAX_INSPECTION_DEPTH) return true;
	if (payloads.some((payload) => isObviousMutationAtDepth(payload, depth + 1))) return true;
	const inspectable = withoutQuotedText(unquoteGitGlobalOptionValues(command))
		.replace(DISCARDED_OUTPUT_REDIRECT, " ")
		.replace(FILE_DESCRIPTOR_DUPLICATION, " ");
	return (
		/(^|[^<])>>?/.test(inspectable) ||
		/\d*<>/.test(inspectable) ||
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
