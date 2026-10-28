import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

const ENTRY_TYPE = "flurdy-task-session-name";
const TASK_ID = /^[A-Za-z][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)+(?:\.\d+)*$/;
const TASK_ID_MAX_LENGTH = 64;
const ROLES = new Set(["watch-release", "watch-prs"]);
const ROLE_COMMAND = /^\s*(?:\/(?:skill:)?|\$)(watch-release|watch-prs)(?:\s|$)/;
const BD_VALUE_FLAGS = new Set(["-C", "--directory", "--actor", "--db", "--database", "--dolt-auto-commit"]);
const BD_SWITCHES = new Set(["--sandbox", "--json", "--readonly", "--no-color", "--quiet", "-q", "--verbose", "-v"]);
const UPDATE_VALUE_FLAGS = new Set(["--notes", "--append-notes", "--description", "-d", "--title", "--add-label", "--remove-label", "--set-labels"]);
const SELECT_VALUE_FLAGS = new Set(["--expect-id", "--type"]);
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

/** Accept only one literal simple command: a shell's final status cannot prove earlier claims. */
function shellWords(command: string): string[] | undefined {
	const words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: string | undefined;
	const endWord = (): void => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	for (let index = 0; index < command.length; index++) {
		const character = command[index] ?? "";
		const next = command[index + 1];
		if (quote === "'") {
			if (character === "'") quote = undefined;
			else word += character;
		} else if (character === "$" || character === "`") {
			return;
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
		} else if (/[;&|()<>\n\r]/.test(character) || (character === "#" && !inWord)) {
			return;
		} else if (/\s/.test(character)) {
			endWord();
		} else {
			word += character;
			inWord = true;
		}
	}
	if (quote || command.endsWith("\\")) return;
	endWord();
	return words;
}

function selectedTask(args: string[]): string | undefined {
	let selector: string | undefined;
	let expected: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		const [flag] = arg.split("=", 1);
		if (SELECT_VALUE_FLAGS.has(flag ?? "")) {
			const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++index];
			if (value === undefined) return;
			if (flag === "--expect-id") expected = value;
		} else if (["--avoid-busy", "--allow-other-machine"].includes(arg)) {
			continue;
		} else if (arg.startsWith("-") || selector !== undefined) {
			return;
		} else selector = arg;
	}
	if (!selector) return;
	const selected = taskId(/^\d+$/.test(selector) ? expected : selector.slice(selector.indexOf(":") + 1));
	return expected !== undefined && selected !== expected ? undefined : selected;
}

function updatedTask(args: string[]): string | undefined {
	let at = 0;
	while (args[at]?.startsWith("-")) {
		const arg = args[at] ?? "";
		const flag = arg.split("=", 1)[0] ?? "";
		if (BD_VALUE_FLAGS.has(flag)) at += arg.includes("=") ? 1 : 2;
		else if (BD_SWITCHES.has(arg)) at++;
		else return;
	}
	if (args[at++] !== "update") return;
	const id = taskId(args[at++]);
	if (!id) return;
	let claim = false;
	let status: string | undefined;
	for (; at < args.length; at++) {
		const arg = args[at] ?? "";
		const flag = arg.split("=", 1)[0] ?? "";
		if (arg === "--claim") claim = true;
		else if (flag === "--status" || flag === "-s" || UPDATE_VALUE_FLAGS.has(flag)) {
			const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[++at];
			if (value === undefined) return;
			if (flag === "--status" || flag === "-s") status = value;
		} else if (!BD_SWITCHES.has(arg)) return;
	}
	if (status !== undefined && status !== "in_progress") return;
	return claim || status === "in_progress" ? id : undefined;
}

/** Infer a claim only when the observed tool result covers one supported literal command. */
export function claimedTask(command: string): string | undefined {
	const words = shellWords(command);
	if (!words) return;
	const at = words.findIndex((word) => !ASSIGNMENT.test(word));
	const program = basename(words[at] ?? "");
	const args = words.slice(at + 1);
	return program === "next-select" && args[0] === "start"
		? selectedTask(args.slice(1))
		: program === "bd" ? updatedTask(args) : undefined;
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

	const update = (ctx: ExtensionContext, change: { task?: string; role?: string }): void => {
		if (!ctx.hasUI) return;
		const existing = pi.getSessionName();
		// Pi names are session-global metadata, so use the same full entry order as getSessionName().
		const previous = restore(ctx.sessionManager.getEntries(), existing);
		if (existing !== undefined && existing !== previous.owned) return;
		const task = change.task ?? previous.task;
		const currentRole = change.role ?? previous.role;
		const name = [task, currentRole].filter(Boolean).join(" · ");
		if (!name || name === existing) return;
		pi.setSessionName(name);
		pi.appendEntry<NameState>(ENTRY_TYPE, { name, task, role: currentRole });
	};

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
