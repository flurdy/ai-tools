import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

const NOT_APPROVAL = "This is not approval for any pending question or any new scope, write access, remote, destructive, package, billing or production action. Preserve all existing permission and confirmation gates.";

export const PRESETS = [
	{
		name: "continue", shortcut: "shift+alt+c",
		description: "Continue already-authorized work (not approval)",
		text: `Continue with the already-authorized steps. ${NOT_APPROVAL} If a decision or approval is pending, restate it and stop.`,
	},
	{
		name: "checkpoint", shortcut: "shift+alt+s",
		description: "Read-only checkpoint: done, verified, left, blockers",
		text: `Give a brief read-only checkpoint: what is done, verified, left, and blocked. Make no changes and take no further action. ${NOT_APPROVAL}`,
	},
	{
		name: "unblock", shortcut: "shift+alt+u",
		description: "List decisions or approvals needed from me",
		text: `Respond read-only: list only the decisions or approvals still needed from me, with a recommendation for each. Do not proceed. ${NOT_APPROVAL}`,
	},
	{
		name: "why", shortcut: "shift+alt+w",
		description: "Explain the last recommendation or decision, read-only",
		text: `Explain your last recommendation or decision briefly: the reason, supporting evidence, and main trade-off. Respond read-only; make no changes and do not proceed. ${NOT_APPROVAL}`,
	},
] as const;

const ACTIONS = [
	...PRESETS.map((preset) => ({ ...preset, kind: "prompt" as const })),
	{ name: "yes", shortcut: "shift+alt+y", kind: "draft", text: "yes", description: "Insert yes for review and manual Enter" },
	{ name: "approved", shortcut: "shift+alt+a", kind: "draft", text: "approved", description: "Insert approved for review and manual Enter" },
	{ name: "plan", shortcut: "shift+alt+p", kind: "mode", description: "Run /plan through normal command dispatch" },
	{ name: "implement", shortcut: "shift+alt+i", kind: "mode", description: "Choose one explicit worktree and run /implement" },
] as const;

const LEGACY_CHORDS = new Map(ACTIONS.map(({ shortcut }) => {
	const letter = shortcut.at(-1)!;
	return [`\x1b${letter.toUpperCase()}`, `\x1b[${letter.charCodeAt(0)};4u`];
}));

export const KEY_PROBE_TIMEOUT_MS = 10_000;
const KEY_PROBE_MAX_BYTES = 32;
// Kitty keyboard protocol release events end in ":3" before the final letter, for example
// the release of the Enter that submitted /quick-keyprobe: "\x1b[13;1:3u".
const KITTY_RELEASE = /;\d+:3[A-Z~u]$/;

/** Describes one raw terminal input for the key probe without echoing ordinary text. */
export function describeKeyProbeInput(data: string): string {
	const bytes = Buffer.from(data, "utf8");
	const keySequence = /^[\x00-\x1f\x7f]$|^\x1b[A-Za-z0-9]$|^\x1b\[[0-9:;]+[uA-D~]$/;
	if (bytes.length > KEY_PROBE_MAX_BYTES || !keySequence.test(data)) {
		return `Key probe received ${bytes.length} byte(s) of ordinary text, not shown.`;
	}
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
	const readable = data.replace(/[\x00-\x1f\x7f]/g, (char) => (char === "\x1b" ? "ESC" : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`));
	return `Key probe received escape sequence: ${hex} (${readable}). Nothing was sent.`;
}

export default function registerPromptShortcuts(pi: ExtensionAPI, options: {
	probeTimeoutMs?: number;
	runtimeVersion?: () => Promise<string>;
} = {}): void {
	// sendUserMessage is fire-and-forget; preflight can await before isIdle becomes false.
	let submitted = false;
	let epoch = 0;
	let selectingScope: symbol | undefined;
	let stopProbe: (() => void) | undefined;
	let stopCompatibility: (() => void) | undefined;
	let runtimeVersion: Promise<string> | undefined;
	const commandOptions: NonNullable<Parameters<ExtensionAPI["sendUserMessage"]>[1]> & { expandPromptTemplates: true } = { expandPromptTemplates: true };
	pi.on("session_start", (_event, ctx) => {
		epoch++;
		submitted = false;
		selectingScope = undefined;
		stopProbe?.();
		stopCompatibility?.();
		stopCompatibility = undefined;
		if (ctx.mode === "tui") {
			stopCompatibility = ctx.ui.onTerminalInput((data) => {
				if (stopProbe) return undefined;
				const translated = LEGACY_CHORDS.get(data);
				return translated ? { data: translated } : undefined;
			});
		}
	});
	pi.on("agent_settled", () => { submitted = false; });
	pi.on("session_shutdown", () => {
		epoch++;
		selectingScope = undefined;
		stopProbe?.();
		stopCompatibility?.();
		stopCompatibility = undefined;
	});

	function busy(ctx: ExtensionContext, name: string): boolean {
		if (!ctx.isIdle() || ctx.hasPendingMessages()) {
			ctx.ui.notify(`${name} not sent: agent is busy or messages are queued.`, "info");
			return true;
		}
		return false;
	}

	function ready(ctx: ExtensionContext, name: string, checkDraft: boolean, ownSelection?: symbol): boolean {
		if (ctx.mode !== "tui" || busy(ctx, name)) return false;
		if (selectingScope && selectingScope !== ownSelection) {
			ctx.ui.notify("A worktree scope selection is already open.", "info");
			return false;
		}
		if (submitted) {
			ctx.ui.notify("A shortcut submission is still pending. If it failed before starting, resolve the error and /reload before retrying.", "warning");
			return false;
		}
		if (checkDraft) {
			try {
				if (ctx.ui.getEditorText() !== "") {
					ctx.ui.notify(`${name} not sent: editor contains a draft.`, "info");
					return false;
				}
			} catch {
				ctx.ui.notify(`${name} not sent: cannot check the editor.`, "warning");
				return false;
			}
		}
		return true;
	}

	function hasModeCommand(ctx: ExtensionContext, name: string): boolean {
		const matches = pi.getCommands().filter((command) => command.name === name);
		if (matches.length === 1 && matches[0]!.source === "extension") return true;
		ctx.ui.notify(`/${name} is not an unambiguous registered extension command; nothing was sent.`, "warning");
		return false;
	}

	async function run(ctx: ExtensionContext, action: (typeof ACTIONS)[number], checkDraft: boolean): Promise<void> {
		if (!ready(ctx, action.name, checkDraft || action.kind !== "prompt")) return;
		try {
			if (action.kind === "prompt") {
				submitted = true;
				pi.sendUserMessage(action.text);
			} else if (action.kind === "draft") {
				ctx.ui.setEditorText(action.text);
			} else {
				const runtimeTicket = epoch;
				runtimeVersion ??= options.runtimeVersion ? options.runtimeVersion() : import("@earendil-works/pi-coding-agent").then((module) => module.VERSION);
				const version = await runtimeVersion;
				if (runtimeTicket !== epoch) return;
				const match = /^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/.exec(version);
				if (!match || (Number(match[1]) < 1 || (Number(match[1]) === 1 && Number(match[2]) < 4))) {
					ctx.ui.notify("Mode shortcuts require Pi 1.4.0 or newer for real command dispatch; use the native command directly.", "warning");
					return;
				}
				if (!ready(ctx, action.name, true) || !hasModeCommand(ctx, action.name)) return;
				let command = `/${action.name}`;
				if (action.name === "implement") {
					const ticket = epoch;
					const selection = Symbol();
					selectingScope = selection;
					try {
						const answer = await ctx.ui.input("Implement: choose one worktree", "Absolute worktree path, without surrounding quotes; no default");
						if (ticket !== epoch) return;
						if (!answer?.trim()) {
							ctx.ui.notify("Implement cancelled: no worktree selected.", "info");
							return;
						}
						if (answer.length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(answer) || !isAbsolute(answer.trim())) {
							ctx.ui.notify("Implement needs one literal absolute worktree path without control characters.", "warning");
							return;
						}
						if (!ready(ctx, action.name, true, selection) || !hasModeCommand(ctx, action.name)) return;
						command += ` ${JSON.stringify(answer.trim())}`;
					} finally {
						if (selectingScope === selection) selectingScope = undefined;
					}
				}
				// Commands have no completion signal or agent_settled event. Their native owner handles overlapping requests.
				pi.sendUserMessage(command, commandOptions);
			}
		} catch {
			ctx.ui.notify(action.kind === "prompt"
				? "Shortcut submission failed. Resolve the error and /reload before retrying."
				: `${action.name} action failed; no automatic retry.`, "error");
		}
	}

	/** Reports the next key sequence that reaches Pi once, consuming it so no shortcut or model turn starts. */
	function probe(ctx: ExtensionCommandContext): void {
		if (ctx.mode !== "tui") return;
		if (busy(ctx, "keyprobe")) return;
		if (stopProbe) {
			ctx.ui.notify("Key probe is already waiting for a key.", "info");
			return;
		}
		const timeoutMs = options.probeTimeoutMs ?? KEY_PROBE_TIMEOUT_MS;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let unsubscribe: (() => void) | undefined;
		const stop = () => {
			if (timer) clearTimeout(timer);
			unsubscribe?.();
			stopProbe = undefined;
		};
		stopProbe = stop;
		timer = setTimeout(() => {
			stop();
			ctx.ui.notify(`Key probe: no key sequence reached Pi within ${Math.round(timeoutMs / 1000)}s. Either nothing was pressed or the terminal or another listener consumed it.`, "warning");
		}, timeoutMs);
		unsubscribe = ctx.ui.onTerminalInput((data) => {
			if (KITTY_RELEASE.test(data)) return undefined;
			stop();
			ctx.ui.notify(describeKeyProbeInput(data), "info");
			return { consume: true };
		});
		ctx.ui.notify(`Key probe armed for ${Math.round(timeoutMs / 1000)}s: press one quick-prompt chord. Its bytes are reported, not sent.`, "info");
	}

	for (const action of ACTIONS) {
		pi.registerShortcut(action.shortcut, {
			description: action.description,
			handler: (ctx) => run(ctx, action, true),
		});
		pi.registerCommand(`quick-${action.name}`, {
			description: action.description,
			handler: async (args, ctx) => {
				if (args.trim()) {
					ctx.ui.notify("Quick actions do not accept arguments. Type a normal message or command for custom instructions.", "warning");
					return;
				}
				await run(ctx, action, false);
			},
		});
	}

	pi.registerCommand("quick-keyprobe", {
		description: "Report the next key sequence's raw bytes once, without sending anything",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Key probe does not accept arguments.", "warning");
				return;
			}
			probe(ctx);
		},
	});
}
