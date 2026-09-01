const GUARDED_TOOL_REASONS = new Map<string, string>([
	["edit", "Guarded session: direct file edits are disabled. Switch to /implement after acquiring the worktree lease."],
	["write", "Guarded session: direct file writes are disabled. Switch to /implement after acquiring the worktree lease."],
	[
		"subagent",
		"Guarded session: subagent launches are disabled because a child may write this worktree. Use an isolated worktree for writer children.",
	],
	[
		"multi_tool_use.parallel",
		"Guarded session: composite tool launches are disabled because nested writes cannot be inspected independently.",
	],
]);

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
const DISCARDED_STDERR_REDIRECT = /(?<![\w<>&])2>[ \t]*\/dev\/null(?![\w/.-])/g;

export function guardedToolBlockReason(toolName: string): string | undefined {
	return GUARDED_TOOL_REASONS.get(toolName);
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

export function isObviousMutation(command: string): boolean {
	const inspectable = withoutQuotedText(command).replace(DISCARDED_STDERR_REDIRECT, " ");
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
