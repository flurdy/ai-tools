import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeSync } from "node:fs";

type Protocol = "osc99" | "osc777";

export function resolveProtocol(env: NodeJS.ProcessEnv): Protocol | undefined {
	if (env.ORCA_PANE_KEY || env.TERM_PROGRAM?.toLowerCase() === "orca") return;
	if (env.TMUX || env.STY || /^(screen|tmux)(-|$)/.test(env.TERM ?? "") || env.TERM === "dumb") return;

	const configured = env.PI_NOTIFY_PROTOCOL;
	if (configured === "osc99" || configured === "osc777") return configured;
	if (configured && configured !== "auto") return;

	if (env.KITTY_WINDOW_ID || env.TERM === "xterm-kitty") return "osc99";
	if (env.TERM === "xterm-ghostty" || ["ghostty", "wezterm"].includes(env.TERM_PROGRAM?.toLowerCase() ?? "")) {
		return "osc777";
	}
}

export default function registerPiNotify(
	pi: ExtensionAPI,
	terminal = {
		env: process.env,
		isTTY: process.stdout.isTTY === true,
		write: (sequence: string): void => { writeSync(process.stdout.fd, sequence); },
	},
): void {
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui" || !terminal.isTTY || !ctx.isIdle()) return;
		const protocol = resolveProtocol(terminal.env);
		if (!protocol) return;
		try {
			terminal.write(protocol === "osc99"
				? "\x1b]99;;Pi: Ready for input\x1b\\"
				: "\x1b]777;notify;Pi;Ready for input\x07");
		} catch {
			// A closed or unsupported terminal must not break the agent lifecycle.
		}
	});
}
