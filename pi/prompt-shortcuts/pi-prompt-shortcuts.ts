import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

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

export default function registerPromptShortcuts(pi: ExtensionAPI): void {
	// sendUserMessage is fire-and-forget; preflight can await before isIdle becomes false.
	let submitted = false;
	pi.on("session_start", () => { submitted = false; });
	pi.on("agent_settled", () => { submitted = false; });

	function send(ctx: ExtensionContext, preset: (typeof PRESETS)[number], checkDraft: boolean): void {
		if (ctx.mode !== "tui") return;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) {
			ctx.ui.notify(`${preset.name} not sent: agent is busy or messages are queued.`, "info");
			return;
		}
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
}
