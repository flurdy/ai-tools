import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { fetchCodexWeeklyQuota, isCodexQuotaStale, type CodexWeeklyQuota } from "./codex-quota.ts";
import { activeModelLabel, modelLabel } from "./model-label.ts";
import { bar, CODEX_QUOTA_CRIT_PERCENT, CODEX_QUOTA_WARN_PERCENT, codexQuotaTone } from "./quota-display.ts";

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
let k8sContextCache: { at: number; value: string | null } | undefined;

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

function fmtTime(date: Date): string {
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtQuotaReset(timestampMs: number): string {
	return new Date(timestampMs).toLocaleDateString([], { month: "short", day: "numeric" });
}

function envMilliseconds(name: string, fallback: number, minimum: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value >= minimum ? value : fallback;
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

function getK8sContext(): string | null {
	if (process.env.PI_STATUSLINE_K8S_CONTEXT === "0") return null;
	if (k8sContextCache && Date.now() - k8sContextCache.at < 5000) return k8sContextCache.value;
	try {
		const value = execFileSync("kubectl", ["config", "current-context"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 500,
		}).trim();
		k8sContextCache = { at: Date.now(), value: value || null };
	} catch {
		k8sContextCache = { at: Date.now(), value: null };
	}
	return k8sContextCache.value;
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
	let lastPrompt: { text: string; submittedAt: Date } | undefined;
	let activeRun = false;
	let activeModel: { provider?: string; id?: string } | undefined;

	function syncActiveModel(ctx: ExtensionContext): void {
		activeModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
	}

	function setLastPromptWidget(ctx: ExtensionContext, prompt?: string): void {
		if (ctx.mode !== "tui" || process.env.PI_STATUSLINE_LAST_PROMPT === "0") return;
		const text = prompt?.replace(/\s+/g, " ").trim();
		if (text) lastPrompt = { text, submittedAt: new Date() };
		if (!lastPrompt) {
			ctx.ui.setWidget("pi-statusline-last-prompt", undefined);
			return;
		}
		const lastLine = `Last [${fmtTime(lastPrompt.submittedAt)}]: ${lastPrompt.text}`;
		const activeLine = activeRun ? activeModelLabel(activeModel?.provider, activeModel?.id, thinking) : undefined;
		ctx.ui.setWidget("pi-statusline-last-prompt", (_tui, theme) => ({
			render(width: number): string[] {
				return [
					...(activeLine ? [theme.fg("accent", truncateToWidth(activeLine, width, "…"))] : []),
					theme.fg("dim", truncateToWidth(lastLine, width, "…")),
				];
			},
			invalidate() {},
		}));
	}

	pi.on("input", (event, ctx) => {
		if (event.source !== "extension") setLastPromptWidget(ctx, event.text);
	});

	pi.on("thinking_level_select", (event, ctx) => {
		thinking = event.level;
		if (activeRun) setLastPromptWidget(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		if (!activeRun) return;
		activeModel = { provider: event.model.provider, id: event.model.id };
		setLastPromptWidget(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		activeRun = true;
		syncActiveModel(ctx);
		setLastPromptWidget(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		activeRun = false;
		activeModel = undefined;
		setLastPromptWidget(ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		startedAt = Date.now();
		setLastPromptWidget(ctx);
		for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
			if (entry.type === "thinking_level_change") {
				thinking = entry.thinkingLevel;
				break;
			}
		}
		ctx.ui.setFooter((tui, theme, footerData) => {
			const interval = setInterval(() => tui.requestRender(), 1000);
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
			const quotaEnabled = process.env.PI_STATUSLINE_CODEX_QUOTA !== "0";
			const quotaRefreshMs = envMilliseconds("PI_STATUSLINE_CODEX_QUOTA_TTL", 5 * 60_000, 60_000);
			const quotaStaleMs = envMilliseconds("PI_STATUSLINE_CODEX_QUOTA_STALE", 15 * 60_000, 60_000);
			const quotaTimeoutMs = envMilliseconds("PI_STATUSLINE_CODEX_QUOTA_TIMEOUT", 10_000, 1000);
			const quotaAbort = new AbortController();
			let codexQuota: CodexWeeklyQuota | undefined;
			let quotaRefreshing = false;

			async function refreshCodexQuota(): Promise<void> {
				if (!quotaEnabled || quotaRefreshing || quotaAbort.signal.aborted) return;
				quotaRefreshing = true;
				try {
					codexQuota = await fetchCodexWeeklyQuota({
						command: process.env.PI_STATUSLINE_CODEX_BIN?.trim() || "codex",
						timeoutMs: quotaTimeoutMs,
						signal: quotaAbort.signal,
					});
				} catch {
					// Keep the last successful snapshot; missing Codex/auth simply hides the segment.
				} finally {
					quotaRefreshing = false;
					if (!quotaAbort.signal.aborted) tui.requestRender();
				}
			}

			void refreshCodexQuota();
			const quotaInterval = quotaEnabled ? setInterval(() => void refreshCodexQuota(), quotaRefreshMs) : undefined;

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
				const k8sContext = getK8sContext();
				const model = modelLabel(ctx.model?.provider, ctx.model?.id ?? "no-model");
				const sessionName = pi.getSessionName();
				const effort = thinking ? `⚡${thinking === "high" ? "Hi" : thinking === "medium" ? "Md" : thinking.slice(0, 2)}` : "";
				const status = `${git.dirty ? "●" : ""}${git.untracked ? "…" : ""}${git.staged ? "✚" : ""}`;
				const cacheBase = usage.input + usage.cacheRead;
				const cachePct = usage.cacheRead > 0 && cacheBase > 0 ? Math.round((usage.cacheRead / cacheBase) * 100) : null;
				const cache = [cachePct === null ? "" : `cache ${cachePct}%`, usage.cacheWrite > 0 ? `W${fmtNumber(usage.cacheWrite)}` : ""]
					.filter(Boolean)
					.join(" ");
				let quota = "";
				let quotaTable = "";
				if (codexQuota) {
					const used = Math.round(codexQuota.usedPercent);
					const stale = isCodexQuotaStale(codexQuota, Date.now(), quotaStaleMs);
					const tone = codexQuotaTone(used);
					const quotaColors = stale
						? { ok: colors.empty, warn: colors.empty, crit: colors.empty, empty: colors.empty }
						: colors;
					const label = theme.fg(stale ? "dim" : tone, "GPT");
					quota = `${bar(used, 3, CODEX_QUOTA_WARN_PERCENT, CODEX_QUOTA_CRIT_PERCENT, quotaColors)} ${label}`;
					const reset = codexQuota.resetsAtMs === null ? "" : fmtQuotaReset(codexQuota.resetsAtMs);
					quotaTable = `${bar(used, 6, CODEX_QUOTA_WARN_PERCENT, CODEX_QUOTA_CRIT_PERCENT, quotaColors)} ${label}${reset ? theme.fg("dim", ` · ${reset}`) : ""}`;
				}
				return {
					clock: theme.fg("dim", fmtTime(new Date())),
					host: theme.fg("accent", ` ${hostname().split(".")[0]}`),
					k8s: k8sContext ? theme.fg("accent", `☸ ${k8sContext}`) : "",
					agent: theme.fg("success", theme.bold("π")),
					model: theme.fg("success", theme.bold(model)),
					effort: effort ? theme.fg("accent", effort) : "",
					session: sessionName ? theme.fg("accent", `◈ ${truncateToWidth(sessionName, 24, "…")}`) : "",
					bars: `${bar(usage.ctxPct, 3, 34, 67, colors)} ${theme.fg("dim", "ctx")}`,
					ctx: `${bar(usage.ctxPct, 6, 34, 67, colors)} ${theme.fg("dim", "ctx")}`,
					quota,
					quotaTable,
					tokens: theme.fg("dim", `↑${fmtNumber(usage.input)} ↓${fmtNumber(usage.output)}${cache ? ` · ${cache}` : ""}`),
					cost: theme.fg("success", `est $${usage.cost.toFixed(2)}`),
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
				let cells = [s.clock, joinCells([s.agent, s.model, s.effort]), s.bars, s.quota, s.k8s, s.duration, s.path, s.repo, s.branch, s.pr, s.session].filter(Boolean);
				let line = joinCells(cells);
				if (visibleWidth(line) <= width) return [truncateToWidth(line, width)];
				cells = [joinCells([s.agent, s.model, s.effort]), s.bars, s.quota, s.k8s, s.duration, s.repo, s.branch, s.pr, s.session].filter(Boolean);
				line = joinCells(cells);
				if (visibleWidth(line) <= width) return [truncateToWidth(line, width)];
				cells = [s.agent, s.model, s.bars, s.k8s, s.branch, s.session].filter(Boolean);
				return [truncateToWidth(joinCells(cells), width)];
			}

			function table(width: number): string[] {
				const s = segments();
				const border = (text: string) => theme.fg("border", text);
				let row1 = [s.host, s.k8s, s.path, s.repo, s.branch, s.pr, s.session].filter(Boolean);
				const row2 = [s.agent, s.model, s.effort, s.ctx, s.quotaTable, s.tokens, s.cost, s.duration, s.clock].filter(Boolean);

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
					row1 = [s.host, s.k8s, s.repo, s.branch, s.pr, s.session].filter(Boolean);
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
					if (quotaInterval) clearInterval(quotaInterval);
					quotaAbort.abort();
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
