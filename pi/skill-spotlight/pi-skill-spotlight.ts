import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";

const WIDGET = "flurdy-skill-spotlight";
type SkillTip = { command: string; description: string };

export function cleanDescription(description: string): string {
	const plain = stripVTControlCharacters(description.replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, ""))
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
		.replace(/\s+/g, " ").trim();
	const points = Array.from(plain);
	return points.length > 140 ? `${points.slice(0, 139).join("")}…` : plain;
}

export function chooseSkill(commands: readonly unknown[], random = Math.random): SkillTip | undefined {
	const skills = new Map<string, SkillTip>();
	for (const candidate of commands) {
		if (!candidate || typeof candidate !== "object") continue;
		const { source, name, description } = candidate as Record<string, unknown>;
		if (source !== "skill" || typeof name !== "string" || typeof description !== "string") continue;
		const match = /^skill:([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(name);
		if (!match || match[1].length > 64 || description.length > 4096 || skills.has(name)) continue;
		const cleaned = cleanDescription(description);
		if (cleaned) skills.set(name, { command: `/${name}`, description: cleaned });
	}
	if (skills.size === 0) return;
	const choice = random();
	if (!Number.isFinite(choice) || choice < 0 || choice >= 1) return;
	return [...skills.values()][Math.floor(choice * skills.size)];
}

export default function registerSkillSpotlight(
	pi: ExtensionAPI,
	runtime = { env: process.env, isTTY: process.stdout.isTTY === true, fileExists: existsSync, random: Math.random },
): void {
	let shown = false;
	let visible = false;
	pi.on("session_start", (event, ctx) => {
		if (shown || runtime.env.PI_SKILL_SPOTLIGHT !== "1" || !runtime.isTTY || !ctx.hasUI) return;
		if (!("mode" in ctx) || ctx.mode !== "tui") return;
		if (!("reason" in event) || (event.reason !== "startup" && event.reason !== "new")) return;
		try {
			const file = ctx.sessionManager.getSessionFile();
			if (file && runtime.fileExists(file)) return;
			if (ctx.sessionManager.getHeader()?.parentSession) return;
			if (ctx.sessionManager.getEntries().some((entry) => entry.type === "compaction"
				|| (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant")))) return;
			const tip = chooseSkill(pi.getCommands(), runtime.random);
			if (!tip) return;
			ctx.ui.setWidget(WIDGET, [`Skill spotlight · ${tip.command}`, tip.description], { placement: "aboveEditor" });
			shown = true;
			visible = true;
		} catch {
			// An optional tip must not interrupt startup on an incompatible or unavailable host.
		}
	});
	const clear = (_event: unknown, ctx: { ui: { setWidget(key: string, content: undefined): void } }) => {
		if (!visible) return;
		visible = false;
		try { ctx.ui.setWidget(WIDGET, undefined); } catch { /* UI may already be shutting down. */ }
	};
	pi.on("before_agent_start", clear);
	pi.on("session_shutdown", clear);
}
