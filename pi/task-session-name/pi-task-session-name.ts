import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

const ENTRY_TYPE = "flurdy-task-session-name";
const TASK_ID = /^[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)+(?:\.\d+)*$/;
const TASK_ID_MAX_LENGTH = 64;
const ROLES = new Set(["watch-release", "watch-prs"]);
const ROLE_COMMAND = /^\s*(?:\/(?:skill:)?|\$)(watch-release|watch-prs)(?:\s|$)/;
const BD_VALUE_FLAGS = new Set(["-C", "--directory", "--actor", "--db", "--database", "--dolt-auto-commit"]);
const SELECT_VALUE_FLAGS = new Set(["--expect-id", "--type"]);
const OPERATORS = new Set([";", "&", "|", "(", ")", "\n"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface NameState {
	name: string;
	task?: string;
	role?: string;
}

type Entry = { type: string; customType?: string; data?: unknown };

function taskId(value: unknown): string | undefined {
	return typeof value === "string" && value.length <= TASK_ID_MAX_LENGTH && TASK_ID.test(value) ? value : undefined;
}

function role(value: unknown): string | undefined {
	return typeof value === "string" && ROLES.has(value) ? value : undefined;
}

/** Splits a command into simple-command word lists, honouring quotes; not a full shell parser. */
function shellSegments(command: string): string[][] {
	const segments: string[][] = [[]];
	let word = "";
	let inWord = false;
	let quote: string | undefined;
	const endWord = (): void => {
		if (inWord) segments.at(-1)?.push(word);
		word = "";
		inWord = false;
	};
	for (let index = 0; index < command.length; index++) {
		const character = command[index] ?? "";
		const next = command[index + 1];
		if (quote === "'") {
			if (character === "'") quote = undefined;
			else word += character;
		} else if (quote === '"') {
			if (character === '"') quote = undefined;
			else if (character === "\\" && next !== undefined) word += command[++index];
			else word += character;
		} else if (character === "'" || character === '"') {
			quote = character;
			inWord = true;
		} else if (character === "\\" && next === "\n") {
			index++;
		} else if (character === "\\" && next !== undefined) {
			word += command[++index];
			inWord = true;
		} else if (OPERATORS.has(character)) {
			endWord();
			if (segments.at(-1)?.length) segments.push([]);
		} else if (/\s/.test(character)) {
			endWord();
		} else {
			word += character;
			inWord = true;
		}
	}
	endWord();
	return segments.filter((segment) => segment.length > 0);
}

function selectedTask(args: string[]): string | undefined {
	let selector: string | undefined;
	let expected: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg === "--expect-id") expected = args[index + 1];
		if (arg.startsWith("--expect-id=")) expected = arg.slice("--expect-id=".length);
		if (SELECT_VALUE_FLAGS.has(arg)) index++;
		else if (!arg.startsWith("-")) selector ??= arg;
	}
	if (!selector) return;
	return taskId(/^\d+$/.test(selector) ? expected : selector.slice(selector.indexOf(":") + 1));
}

function updatedTask(args: string[]): string | undefined {
	let command = 0;
	while (command < args.length && args[command]?.startsWith("-")) {
		command += BD_VALUE_FLAGS.has(args[command] ?? "") ? 2 : 1;
	}
	if (args[command] !== "update") return;
	const rest = args.slice(command + 1);
	const firstFlag = rest.findIndex((arg) => arg.startsWith("-"));
	const ids = firstFlag < 0 ? rest : rest.slice(0, firstFlag);
	const claims = rest.some((arg, index) =>
		arg === "--claim" ||
		arg === "--status=in_progress" ||
		((arg === "--status" || arg === "-s") && rest[index + 1] === "in_progress"));
	return ids.length === 1 && claims ? taskId(ids[0]) : undefined;
}

/** Returns the single task a shell command claims, preferring the last claim in a chain. */
export function claimedTask(command: string): string | undefined {
	let claimed: string | undefined;
	for (const words of shellSegments(command)) {
		const at = words.findIndex((word) => !ASSIGNMENT.test(word));
		const program = basename(words[at] ?? "");
		const args = words.slice(at + 1);
		const task = program === "next-select" && args[0] === "start"
			? selectedTask(args.slice(1))
			: program === "bd" ? updatedTask(args) : undefined;
		claimed = task ?? claimed;
	}
	return claimed;
}

function restore(entries: readonly Entry[], currentName: string | undefined): { task?: string; role?: string; owned?: string } {
	let infoAt = -1;
	let saved: { at: number; data: Partial<NameState> } | undefined;
	entries.forEach((entry, at) => {
		if (entry.type === "session_info") infoAt = at;
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE && typeof entry.data === "object" && entry.data) {
			saved = { at, data: entry.data as Partial<NameState> };
		}
	});
	if (!saved) return {};
	const task = taskId(saved.data.task);
	const restoredRole = role(saved.data.role);
	const name = [task, restoredRole].filter(Boolean).join(" · ");
	const owned = saved.at > infoAt && name && name === saved.data.name && name === currentName ? name : undefined;
	return { task, role: restoredRole, owned };
}

export default function registerTaskSessionName(pi: ExtensionAPI, env: NodeJS.ProcessEnv = process.env): void {
	if (!env.ORCA_PANE_KEY) return;

	let task: string | undefined;
	let currentRole: string | undefined;
	let ownedName: string | undefined;

	const update = (ctx: ExtensionContext, change: { task?: string; role?: string }): void => {
		if (!ctx.hasUI) return;
		task = change.task ?? task;
		currentRole = change.role ?? currentRole;
		const name = [task, currentRole].filter(Boolean).join(" · ");
		const existing = pi.getSessionName();
		if (!name || name === existing || (existing !== undefined && existing !== ownedName)) return;
		ownedName = name;
		pi.setSessionName(name);
		pi.appendEntry<NameState>(ENTRY_TYPE, { name, task, role: currentRole });
	};

	pi.on("session_start", (_event, ctx) => {
		({ task, role: currentRole, owned: ownedName } = restore(ctx.sessionManager.getEntries(), pi.getSessionName()));
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "bash" || event.isError || typeof event.input.command !== "string") return;
		const claimed = claimedTask(event.input.command);
		if (claimed) update(ctx, { task: claimed });
	});

	pi.on("input", (event, ctx) => {
		const requested = ROLE_COMMAND.exec(event.text)?.[1];
		if (requested) update(ctx, { role: requested });
	});
}
