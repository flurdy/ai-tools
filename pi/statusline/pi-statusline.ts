import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { dirname } from "node:path";

type GitInfo = {
	branch: string | null;
	dirty: boolean;
	untracked: boolean;
	staged: boolean;
	isWorktree: boolean;
	repo: string | null;
};

type Usage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	ctxTokens: number;
	ctxMax: number;
	ctxPct: number;
};

const gitCache = new Map<string, { at: number; value: GitInfo }>();
const prCache = new Map<string, { at: number; value: string | null; refreshing: boolean }>();

function stripHome(path: string): string {
	const home = process.env.HOME;
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function abbrevPath(path: string): string {
	const p = stripHome(path);
	const parts = p.split("/");
	return parts
		.map((part, i) => {
			if (i === 0 || i === parts.length - 1) return part;
			if (!part) return part;
			return part.slice(0, 3);
		})
		.join("/");
}

function shortProvider(provider: string | undefined): string {
	switch (provider) {
		case "openai-codex":
			return "Codex";
		case "openai":
			return "OpenAI";
		case "openrouter":
			return "OR";
		case "github-copilot":
			return "Copilot";
		case "anthropic":
			return "Claude";
		case "google":
			return "Google";
		default:
			return provider ?? "no-provider";
	}
}

function titleModelWords(value: string): string {
	return value
		.split(/[-_ ]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

function shortModel(id: string): string {
	const raw = id.split("/").pop() ?? id;
	const s = raw.toLowerCase();
	const gpt = s.match(/^gpt[-_ ]?(\d+(?:\.\d+)?[a-z]?)(?:[-_ ]+(.+))?$/);
	if (gpt) {
		const variantWords = gpt[2]?.split(/[-_ ]+/).filter(Boolean) ?? [];
		const isPro = variantWords.at(-1) === "pro";
		if (isPro) variantWords.pop();
		const variant = titleModelWords(variantWords.join(" "));
		return `GPT-${gpt[1]}${variant ? ` ${variant}` : ""}${isPro ? "+" : ""}`;
	}
	const gemini = s.match(/^gemini[-_ ]?(\d+(?:\.\d+)?)(?:[-_ ]+(.+))?$/);
	if (gemini) {
		const variant = titleModelWords(
			(gemini[2]?.split(/[-_ ]+/).filter((word) => word !== "preview") ?? []).join(" "),
		);
		return `Gemini ${gemini[1]}${variant ? ` ${variant}` : ""}`;
	}
	const anthropicPrefix = id.toLowerCase().startsWith("anthropic/") ? "Claude " : "";
	const opus = s.match(/opus[-_ ]?(\d+(?:[.-]\d+)?)/);
	if (opus) return `${anthropicPrefix}Opus ${opus[1].replace("-", ".")}`;
	const sonnet = s.match(/sonnet[-_ ]?(\d+(?:[.-]\d+)?)/);
	if (sonnet) return `${anthropicPrefix}Sonnet ${sonnet[1].replace("-", ".")}`;
	const haiku = s.match(/haiku[-_ ]?(\d+(?:[.-]\d+)?)/);
	if (haiku) return `${anthropicPrefix}Haiku ${haiku[1].replace("-", ".")}`;
	const fable = s.match(/fable[-_ ]?(\d+(?:[.-]\d+)?)/);
	if (fable) return `${anthropicPrefix}Fable ${fable[1].replace("-", ".")}`;
	if (s.includes("codex")) return "Codex";
	return titleModelWords(raw.replace(/^claude-/, "").replace(/^gpt-/, "GPT-"));
}

function fmtNumber(n: number): string {
	if (!Number.isFinite(n) || n <= 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}

function fmtDuration(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

function runGit(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 500,
		}).trim();
	} catch {
		return null;
	}
}

function getGitInfo(cwd: string, footerBranch: string | null): GitInfo {
	const cached = gitCache.get(cwd);
	if (cached && Date.now() - cached.at < 5000) return cached.value;

	const inside = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (inside !== "true") {
		const value = { branch: footerBranch, dirty: false, untracked: false, staged: false, isWorktree: false, repo: null };
		gitCache.set(cwd, { at: Date.now(), value });
		return value;
	}

	const branch =
		runGit(cwd, ["symbolic-ref", "--short", "HEAD"]) ??
		runGit(cwd, ["describe", "--tags", "--exact-match"]) ??
		runGit(cwd, ["rev-parse", "--short", "HEAD"]) ??
		footerBranch;

	const dirty = runGit(cwd, ["diff", "--quiet"]) === null;
	const staged = runGit(cwd, ["diff", "--cached", "--quiet"]) === null;
	const untracked = Boolean(runGit(cwd, ["ls-files", "--others", "--exclude-standard"]));
	const gitDir = runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]);
	const commonDir = runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const isWorktree = Boolean(gitDir && commonDir && gitDir !== commonDir);
	const repo = isWorktree && commonDir ? dirname(commonDir).split("/").pop() || null : null;
	const value = { branch, dirty, untracked, staged, isWorktree, repo };
	gitCache.set(cwd, { at: Date.now(), value });
	return value;
}

function refreshPr(cwd: string, branch: string, key: string): void {
	const cached = prCache.get(key);
	if (cached?.refreshing || process.env.PI_STATUSLINE_PR === "0") return;
	if (["main", "master", "develop", "trunk"].includes(branch)) return;
	prCache.set(key, { at: cached?.at ?? 0, value: cached?.value ?? null, refreshing: true });
	void import("node:child_process").then(({ execFile }) => {
		execFile(
			"gh",
			["pr", "view", branch, "--json", "number,state,isDraft", "--jq", '"#\(.number)"'],
			{ cwd, timeout: 3000 },
			(error, stdout) => {
				prCache.set(key, { at: Date.now(), value: error ? null : stdout.trim() || null, refreshing: false });
			},
		);
	});
}

function getPr(cwd: string, branch: string | null): string | null {
	if (!branch) return null;
	const key = `${cwd}:${branch}`;
	const cached = prCache.get(key);
	if (!cached || Date.now() - cached.at > Number(process.env.PI_STATUSLINE_PR_TTL ?? 120_000)) refreshPr(cwd, branch, key);
	return cached?.value ?? null;
}

function bar(pct: number, width: number, warn = 60, crit = 80, colors: { ok: (s: string) => string; warn: (s: string) => string; crit: (s: string) => string; empty: (s: string) => string }): string {
	const p = Math.max(0, Math.min(100, Math.round(pct)));
	const filled = Math.max(0, Math.min(width, Math.ceil((p / 100) * width)));
	const fill = "▮".repeat(filled);
	const empty = "▯".repeat(width - filled);
	const color = p >= crit ? colors.crit : p >= warn ? colors.warn : colors.ok;
	return color(fill) + colors.empty(empty);
}

function padAnsi(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function dividerPositions(widths: number[]): number[] {
	const positions: number[] = [];
	let pos = 1;
	for (let i = 0; i < widths.length - 1; i++) {
		pos += widths[i] ?? 0;
		positions.push(pos);
		pos += 1;
	}
	return positions;
}

function borderLine(widths: number[], chars: { left: string; join: string; right: string }, color: (s: string) => string): string {
	return color(chars.left + widths.map((w) => "─".repeat(w)).join(chars.join) + chars.right);
}

function mixedBorderLine(totalWidth: number, upperWidths: number[], lowerWidths: number[], color: (s: string) => string): string {
	const joins = new Map<number, string>();
	for (const pos of dividerPositions(upperWidths)) joins.set(pos, "┴");
	for (const pos of dividerPositions(lowerWidths)) joins.set(pos, joins.has(pos) ? "┼" : "┬");
	let line = "├";
	for (let pos = 1; pos < totalWidth - 1; pos++) line += joins.get(pos) ?? "─";
	line += "┤";
	return color(line);
}

function renderCellRow(cells: string[], widths: number[], color: (s: string) => string): string {
	return color("│") + cells.map((cell, i) => padAnsi(` ${cell} `, widths[i] ?? 0)).join(color("│")) + color("│");
}

function getUsage(ctx: ExtensionContext): Usage {
	let input = 0;
	let output = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let cost = 0;
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type !== "message" || e.message.role !== "assistant") continue;
		const m = e.message as AssistantMessage;
		input += m.usage?.input ?? 0;
		output += m.usage?.output ?? 0;
		cacheRead += m.usage?.cacheRead ?? 0;
		cacheWrite += m.usage?.cacheWrite ?? 0;
		cost += m.usage?.cost?.total ?? 0;
	}
	const context = ctx.getContextUsage();
	const ctxTokens = context?.tokens ?? input + output;
	const ctxMax = ctx.model?.contextWindow ?? 0;
	const ctxPct = ctxMax > 0 ? (ctxTokens / ctxMax) * 100 : 0;
	return { input, output, cacheRead, cacheWrite, cost, ctxTokens, ctxMax, ctxPct };
}

export default function piStatusline(pi: ExtensionAPI): void {
	let thinking = process.env.PI_STATUSLINE_THINKING ?? "";
	let startedAt = Date.now();

	pi.on("thinking_level_select", (event) => {
		thinking = event.level;
	});

	pi.on("session_start", (_event, ctx) => {
		startedAt = Date.now();
		for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
			if (entry.type === "thinking_level_change") {
				thinking = entry.thinkingLevel;
				break;
			}
		}
		ctx.ui.setFooter((tui, theme, footerData) => {
			const interval = setInterval(() => tui.requestRender(), 1000);
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

			const colors = {
				ok: (s: string) => theme.fg("success", s),
				warn: (s: string) => theme.fg("warning", s),
				crit: (s: string) => theme.fg("error", s),
				empty: (s: string) => theme.fg("dim", s),
			};

			function segments() {
				const git = getGitInfo(ctx.cwd, footerData.getGitBranch());
				const pr = getPr(ctx.cwd, git.branch);
				const usage = getUsage(ctx);
				const provider = shortProvider(ctx.model?.provider);
				const model = shortModel(ctx.model?.id ?? "no-model");
				const sessionName = pi.getSessionName();
				const effort = thinking ? `⚡${thinking === "high" ? "Hi" : thinking === "medium" ? "Md" : thinking.slice(0, 2)}` : "";
				const status = `${git.dirty ? "●" : ""}${git.untracked ? "…" : ""}${git.staged ? "✚" : ""}`;
				const contextPct = Math.max(0, Math.min(100, Math.round(usage.ctxPct)));
				const cacheBase = usage.input + usage.cacheRead;
				const cachePct = usage.cacheRead > 0 && cacheBase > 0 ? Math.round((usage.cacheRead / cacheBase) * 100) : null;
				const cache = [cachePct === null ? "" : `cache ${cachePct}%`, usage.cacheWrite > 0 ? `W${fmtNumber(usage.cacheWrite)}` : ""]
					.filter(Boolean)
					.join(" ");
				return {
					clock: theme.fg("dim", new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
					host: theme.fg("accent", `▣ ${hostname().split(".")[0]}`),
					agent: theme.fg("success", theme.bold("π")),
					model: theme.fg("success", theme.bold(`${provider} ${model}`)),
					effort: effort ? theme.fg("accent", effort) : "",
					session: sessionName ? theme.fg("accent", `◈ ${truncateToWidth(sessionName, 24, "…")}`) : "",
					bars: `${bar(usage.ctxPct, 3, 34, 67, colors)} ${theme.fg("dim", `ctx ${contextPct}%`)}`,
					ctx: `${bar(usage.ctxPct, 6, 34, 67, colors)} ${theme.fg("dim", `ctx ${contextPct}%`)}`,
					tokens: theme.fg("dim", `↑${fmtNumber(usage.input)} ↓${fmtNumber(usage.output)}${cache ? ` · ${cache}` : ""}`),
					cost: theme.fg("success", `$${usage.cost.toFixed(2)}`),
					duration: theme.fg("dim", fmtDuration(Date.now() - startedAt)),
					path: theme.fg("muted", ` ${abbrevPath(ctx.cwd)}`),
					repo: git.isWorktree ? theme.fg("success", `🌳 ${git.repo ?? "worktree"}`) : "",
					branch: git.branch ? theme.fg(status ? "warning" : "success", ` ${git.branch}${status ? ` ${status}` : ""}`) : "",
					pr: pr ? theme.fg("success", ` ${pr}`) : "",
				};
			}

			function joinCells(cells: string[]): string {
				return cells.filter(Boolean).join(theme.fg("border", " │ "));
			}

			function compact(width: number): string[] {
				const s = segments();
				let cells = [s.clock, joinCells([s.agent, s.model, s.effort]), s.bars, s.duration, s.path, s.repo, s.branch, s.pr, s.session].filter(Boolean);
				let line = joinCells(cells);
				if (visibleWidth(line) <= width) return [truncateToWidth(line, width)];
				cells = [joinCells([s.agent, s.model, s.effort]), s.bars, s.duration, s.repo, s.branch, s.pr, s.session].filter(Boolean);
				line = joinCells(cells);
				if (visibleWidth(line) <= width) return [truncateToWidth(line, width)];
				cells = [s.agent, s.model, s.bars, s.branch, s.session].filter(Boolean);
				return [truncateToWidth(joinCells(cells), width)];
			}

			function table(width: number): string[] {
				const s = segments();
				const border = (text: string) => theme.fg("border", text);
				let row1 = [s.host, s.path, s.repo, s.branch, s.pr, s.session].filter(Boolean);
				const row2 = [s.agent, s.model, s.effort, s.ctx, s.tokens, s.cost, s.duration, s.clock].filter(Boolean);

				function widthsFor(cells: string[]): number[] {
					return cells.map((cell) => visibleWidth(cell) + 2);
				}
				function totalWidth(widths: number[]): number {
					return widths.reduce((sum, w) => sum + w, 0) + widths.length + 1;
				}
				function normalize(widths: number[], target: number): number[] {
					const out = [...widths];
					if (out.length > 0) out[out.length - 1] += Math.max(0, target - totalWidth(out));
					return out;
				}

				let row1Widths = widthsFor(row1);
				let row2Widths = widthsFor(row2);
				let target = Math.max(totalWidth(row1Widths), totalWidth(row2Widths));

				// If the on-disk path makes the table too wide, drop only that cell first;
				// the worktree repo + branch usually carry the more useful context.
				if (target > width && s.path) {
					row1 = [s.host, s.repo, s.branch, s.pr, s.session].filter(Boolean);
					row1Widths = widthsFor(row1);
					target = Math.max(totalWidth(row1Widths), totalWidth(row2Widths));
				}
				if (target > width || target < 70) return compact(width);

				row1Widths = normalize(row1Widths, target);
				row2Widths = normalize(row2Widths, target);
				return [
					borderLine(row1Widths, { left: "┌", join: "┬", right: "┐" }, border),
					renderCellRow(row1, row1Widths, border),
					mixedBorderLine(target, row1Widths, row2Widths, border),
					renderCellRow(row2, row2Widths, border),
					borderLine(row2Widths, { left: "└", join: "┴", right: "┘" }, border),
				];
			}

			return {
				dispose() {
					clearInterval(interval);
					unsubBranch();
				},
				invalidate() {},
				render(width: number): string[] {
					const mode = process.env.PI_STATUSLINE ?? "auto";
					if (mode === "compact") return compact(width);
					if (mode === "table") return table(width);
					const rows = process.stdout.rows ?? Number(process.env.LINES ?? 24);
					return rows >= Number(process.env.PI_STATUSLINE_MIN_ROWS ?? 45) && width >= 100 ? table(width) : compact(width);
				},
			};
		});
	});
}
