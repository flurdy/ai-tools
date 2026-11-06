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

export const KEY_PROBE_TIMEOUT_MS = 10_000;
const KEY_PROBE_MAX_BYTES = 32;
// Kitty keyboard protocol release events end in ":3" before the final letter, for example
// the release of the Enter that submitted /quick-keyprobe: "\x1b[13;1:3u".
const KITTY_RELEASE = /;\d+:3[A-Z~u]$/;

/** Describes one raw terminal input for the key probe without echoing ordinary text. */
export function describeKeyProbeInput(data: string): string {
	const bytes = Buffer.from(data, "utf8");
	if (bytes.length === 0 || bytes[0]! >= 0x20 || bytes.length > KEY_PROBE_MAX_BYTES) {
		return `Key probe received ${bytes.length} byte(s) of ordinary text, not shown.`;
	}
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
	const readable = data.replace(/[\x00-\x1f\x7f]/g, (char) => (char === "\x1b" ? "ESC" : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`));
	return `Key probe received escape sequence: ${hex} (${readable}). Nothing was sent.`;
}

export default function registerPromptShortcuts(pi: ExtensionAPI, options: { probeTimeoutMs?: number } = {}): void {
	// sendUserMessage is fire-and-forget; preflight can await before isIdle becomes false.
	let submitted = false;
	let stopProbe: (() => void) | undefined;
	pi.on("session_start", () => { submitted = false; });
	pi.on("agent_settled", () => { submitted = false; });
	pi.on("session_shutdown", () => { stopProbe?.(); });

	function busy(ctx: ExtensionContext, name: string): boolean {
		if (!ctx.isIdle() || ctx.hasPendingMessages()) {
			ctx.ui.notify(`${name} not sent: agent is busy or messages are queued.`, "info");
			return true;
		}
		return false;
	}

	function send(ctx: ExtensionContext, preset: (typeof PRESETS)[number], checkDraft: boolean): void {
		if (ctx.mode !== "tui") return;
		if (busy(ctx, preset.name)) return;
		if (submitted) {
			ctx.ui.notify("A shortcut submission is still pending. If it failed before starting, resolve the error and /reload before retrying.", "warning");
			return;
		}
		if (checkDraft) {
			try {
				if (ctx.ui.getEditorText() !== "") {
					ctx.ui.notify(`${preset.name} not sent: editor contains a draft.`, "info");
					return;
				}
			} catch {
				ctx.ui.notify(`${preset.name} not sent: cannot check the editor.`, "warning");
				return;
			}
		}
		submitted = true;
		try {
			pi.sendUserMessage(preset.text);
		} catch {
			ctx.ui.notify("Shortcut submission failed. Resolve the error and /reload before retrying.", "error");
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

	for (const preset of PRESETS) {
		pi.registerShortcut(preset.shortcut, {
			description: preset.description,
			handler: (ctx) => send(ctx, preset, true),
		});
		pi.registerCommand(`quick-${preset.name}`, {
			description: preset.description,
			handler: async (args, ctx) => {
				if (args.trim()) {
					ctx.ui.notify("Quick prompts do not accept arguments. Type a normal message for custom instructions.", "warning");
					return;
				}
				send(ctx, preset, false);
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
