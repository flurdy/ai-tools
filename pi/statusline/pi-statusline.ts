import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { BeadsCountsCache, fetchBeadsCounts, findBeadsRoot, formatBeadsCounts } from "./beads-status.ts";
import { CLAUDE_QUOTA_STATUS_KEY, claudeQuotaTone, claudeQuotaView, type ClaudeQuotaView } from "./claude-quota.ts";
import { claudeAccountUsage, ClaudeQuotaLookupError, claudeUsageIdentity, fetchClaudeUsageSnapshot, parseClaudeAccountUsage } from "./claude-usage.ts";
import { codexQuotaIdentity, fetchCodexQuotaSnapshot, parseCodexQuotaSnapshot } from "./codex-quota.ts";
import { fetchGitDivergence, findGitWorkspaceRoot, formatGitDivergence, GitDivergenceCache } from "./git-divergence.ts";
import { activeModelLabel, modelLabel } from "./model-label.ts";
import { OpenRouterCostAdvisory, openRouterAdvisoryConfig, sharedOpenRouterAdvisoryState } from "./openrouter-advisory.ts";
import { createOpenRouterCreditsCache, openRouterCreditsApiKey } from "./openrouter-credits.ts";
import { accountQuotaCells, adapterAlertVisible, QUOTA_FITS, type QuotaFit } from "./quota-cells.ts";
import { bar, CODEX_QUOTA_CRIT_PERCENT, CODEX_QUOTA_WARN_PERCENT, CONTEXT_CRIT_PERCENT, CONTEXT_WARN_PERCENT } from "./quota-display.ts";
import { formatSessionGuard } from "./session-guard.ts";
import { quotaCacheDirectory, sharedLoad } from "./shared-snapshot.ts";
import { SnapshotCache } from "./snapshot-cache.ts";

type GitInfo = {
	branch: string | null;
	dirty: boolean;
	untracked: boolean;
	staged: boolean;
	isWorktree: boolean;
	repo: string | null;
};

type Usage = {
	cost: number;
	ctxTokens: number;
	ctxMax: number;
	ctxPct: number;
};

const MAX_QUOTA_BACKOFF_MS = 30 * 60_000;
// Each footer runs its own Claude Code `/usage` lookup; concurrent sessions multiply the volume.
export const CLAUDE_QUOTA_REFRESH_MS = 15 * 60_000;
export const CLAUDE_QUOTA_STALE_MS = 30 * 60_000;
export const CLAUDE_QUOTA_TIMEOUT_MS = 10_000;

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
	let cost = 0;
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type !== "message" || e.message.role !== "assistant") continue;
		const m = e.message as AssistantMessage;
		input += m.usage?.input ?? 0;
		output += m.usage?.output ?? 0;
		cost += m.usage?.cost?.total ?? 0;
	}
	const context = ctx.getContextUsage();
	const ctxTokens = context?.tokens ?? input + output;
	const ctxMax = ctx.model?.contextWindow ?? 0;
	const ctxPct = ctxMax > 0 ? (ctxTokens / ctxMax) * 100 : 0;
	return { cost, ctxTokens, ctxMax, ctxPct };
}

export default function piStatusline(pi: ExtensionAPI): void {
	const openRouterAdvisory = new OpenRouterCostAdvisory(openRouterAdvisoryConfig(), sharedOpenRouterAdvisoryState());
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
		const warning = openRouterAdvisory.warningForModelSelect(
			ctx.sessionManager.getSessionId(),
			event.model,
			ctx.getContextUsage()?.tokens ?? null,
			event.source,
		);
		if (warning) ctx.ui.notify(warning, "warning");
		if (!activeRun) return;
		activeModel = { provider: event.model.provider, id: event.model.id };
		setLastPromptWidget(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!ctx.model) return;
		const warning = openRouterAdvisory.warningForPrompt(
			ctx.sessionManager.getSessionId(),
			ctx.model,
			ctx.getContextUsage()?.tokens ?? null,
			event.prompt,
			event.images?.length ?? 0,
		);
		if (warning) ctx.ui.notify(warning, "warning");
	});

	pi.on("turn_start", (_event, ctx) => {
		if (!ctx.model) return;
		const warning = openRouterAdvisory.warningForTurn(
			ctx.sessionManager.getSessionId(),
			ctx.model,
			ctx.getContextUsage()?.tokens ?? null,
		);
		if (warning) ctx.ui.notify(warning, "warning");
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
			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
			const codexRefreshMs = envMilliseconds("PI_STATUSLINE_CODEX_QUOTA_TTL", 5 * 60_000, 60_000);
			const codexStaleMs = envMilliseconds("PI_STATUSLINE_CODEX_QUOTA_STALE", 15 * 60_000, 60_000);
			const codexTimeoutMs = envMilliseconds("PI_STATUSLINE_CODEX_QUOTA_TIMEOUT", 10_000, 1000);
			const codexCommand = process.env.PI_STATUSLINE_CODEX_BIN?.trim() || "codex";
			const quotaCacheDir = quotaCacheDirectory();
			const codexCache = process.env.PI_STATUSLINE_CODEX_QUOTA === "0"
				? undefined
				: new SnapshotCache({
					load: sharedLoad({
						directory: quotaCacheDir,
						source: "codex",
						identity: () => codexQuotaIdentity(codexCommand),
						refreshMs: codexRefreshMs,
						timeoutMs: codexTimeoutMs,
						load: (signal) => fetchCodexQuotaSnapshot({ command: codexCommand, timeoutMs: codexTimeoutMs, signal }),
						parse: parseCodexQuotaSnapshot,
						error: (message) => new Error(message),
					}),
					refreshMs: codexRefreshMs,
					maxBackoffMs: Math.max(codexRefreshMs, MAX_QUOTA_BACKOFF_MS),
					onChange: () => tui.requestRender(),
				});
			const claudeRefreshMs = envMilliseconds("PI_STATUSLINE_CLAUDE_QUOTA_TTL", CLAUDE_QUOTA_REFRESH_MS, 60_000);
			const claudeStaleMs = envMilliseconds("PI_STATUSLINE_CLAUDE_QUOTA_STALE", CLAUDE_QUOTA_STALE_MS, 60_000);
			const claudeTimeoutMs = envMilliseconds("PI_STATUSLINE_CLAUDE_QUOTA_TIMEOUT", CLAUDE_QUOTA_TIMEOUT_MS, 1000);
			const claudeCache = process.env.PI_STATUSLINE_CLAUDE_QUOTA === "0"
				? undefined
				: new SnapshotCache({
					load: sharedLoad({
						directory: quotaCacheDir,
						source: "claude",
						identity: () => claudeUsageIdentity(),
						refreshMs: claudeRefreshMs,
						timeoutMs: claudeTimeoutMs,
						load: async (signal) => claudeAccountUsage(await fetchClaudeUsageSnapshot({ timeoutMs: claudeTimeoutMs, signal })),
						parse: parseClaudeAccountUsage,
						error: (message) => new ClaudeQuotaLookupError("lookup-failed", message),
						// Another session's missing CLI says nothing about this one's PATH.
						shareFailure: (error) => !(error instanceof ClaudeQuotaLookupError && error.kind === "claude-cli-missing"),
					}),
					refreshMs: claudeRefreshMs,
					maxBackoffMs: Math.max(claudeRefreshMs, MAX_QUOTA_BACKOFF_MS),
					// A missing CLI cannot recover, and a reported model turn or cost must never be repeated.
					isPermanentFailure: (error) => error instanceof ClaudeQuotaLookupError
						&& (error.kind === "claude-cli-missing" || error.kind === "unexpected-response"),
					onChange: () => tui.requestRender(),
				});
			const refreshAccountQuotas = () => {
				void codexCache?.refreshIfDue();
				void claudeCache?.refreshIfDue();
			};
			refreshAccountQuotas();
			const interval = setInterval(() => {
				refreshAccountQuotas();
				tui.requestRender();
			}, 1000);
			const openRouterRefreshMs = envMilliseconds("PI_STATUSLINE_OPENROUTER_CREDITS_TTL", 5 * 60_000, 60_000);
			const openRouterStaleMs = envMilliseconds("PI_STATUSLINE_OPENROUTER_CREDITS_STALE", 15 * 60_000, 60_000);
			const openRouterTimeoutMs = envMilliseconds("PI_STATUSLINE_OPENROUTER_CREDITS_TIMEOUT", 5000, 250);
			const openRouterCreditsCache = createOpenRouterCreditsCache({
				apiKey: openRouterCreditsApiKey(),
				timeoutMs: openRouterTimeoutMs,
				staleAfterMs: openRouterStaleMs,
				onChange: () => tui.requestRender(),
			});
			const beadsRoot = process.env.PI_STATUSLINE_BEADS === "0" ? undefined : findBeadsRoot(ctx.cwd);
			const beadsRefreshMs = envMilliseconds("PI_STATUSLINE_BEADS_TTL", 30_000, 5000);
			const beadsTimeoutMs = envMilliseconds("PI_STATUSLINE_BEADS_TIMEOUT", 2000, 250);
			const beadsCache = beadsRoot
				? new BeadsCountsCache({
					load: (signal) => fetchBeadsCounts(beadsRoot, { timeoutMs: beadsTimeoutMs, signal }),
					ttlMs: beadsRefreshMs,
					onChange: () => tui.requestRender(),
				})
				: undefined;
			const gitDivergenceRefreshMs = envMilliseconds("PI_STATUSLINE_GIT_DIVERGENCE_TTL", 30_000, 1000);
			const gitWorkspaceRoot = findGitWorkspaceRoot(ctx.cwd);
			const gitDivergenceTimeoutMs = envMilliseconds("PI_STATUSLINE_GIT_DIVERGENCE_TIMEOUT", gitWorkspaceRoot ? 2000 : 500, 100);
			const gitDivergenceCache = process.env.PI_STATUSLINE_GIT_DIVERGENCE === "0"
				? undefined
				: new GitDivergenceCache({
					workspace: Boolean(gitWorkspaceRoot),
					load: (branch, signal) => fetchGitDivergence(ctx.cwd, branch, { timeoutMs: gitDivergenceTimeoutMs, signal }),
					ttlMs: gitDivergenceRefreshMs,
					onChange: () => tui.requestRender(),
				});

			void openRouterCreditsCache?.refresh();
			void beadsCache?.refresh();
			const openRouterInterval = openRouterCreditsCache
				? setInterval(() => void openRouterCreditsCache.refresh(), openRouterRefreshMs)
				: undefined;
			const beadsInterval = beadsCache ? setInterval(() => void beadsCache.refresh(), beadsRefreshMs) : undefined;

			const colors = {
				ok: (s: string) => theme.fg("success", s),
				warn: (s: string) => theme.fg("warning", s),
				crit: (s: string) => theme.fg("error", s),
				empty: (s: string) => theme.fg("dim", s),
			};

			/** The binding window from the latest pi-claude-cli turn, labelled apart from the account snapshot. */
			function claudeTurnCell(view: ClaudeQuotaView, gaugeWidth: 3 | 5): string {
				const tone = claudeQuotaTone(view);
				const fill = (s: string) => theme.fg(tone, s);
				const barColors = { ok: fill, warn: fill, crit: fill, empty: colors.empty };
				const gauge = view.usedPercent === null ? "" : ` ${bar(view.usedPercent, gaugeWidth, CODEX_QUOTA_WARN_PERCENT, CODEX_QUOTA_CRIT_PERCENT, barColors)}`;
				const label = theme.fg(tone, `Claude turn ${view.window}`);
				const flagText = `${view.over ? " >100%" : ""}${view.state === "rejected" ? " limit" : ""}`;
				const flags = flagText ? theme.fg(tone, flagText) : "";
				const extra = view.extraUsage ? theme.fg("warning", " · extra") : "";
				return `${label}${gauge}${flags}${extra}`;
			}

			function segments(fit: QuotaFit = QUOTA_FITS[0]) {
				const git = getGitInfo(ctx.cwd, footerData.getGitBranch());
				void gitDivergenceCache?.refresh(git.branch);
				const divergence = formatGitDivergence(gitDivergenceCache?.divergenceFor(git.branch));
				const pr = getPr(ctx.cwd, git.branch);
				const usage = getUsage(ctx);
				const k8sContext = getK8sContext();
				const model = modelLabel(ctx.model?.provider, ctx.model?.id ?? "no-model");
				const statuses = footerData.getExtensionStatuses();
				const sessionMode = statuses.get("session-mode") ?? "";
				const leaseScopes = statuses.get("session-mode-leases") ?? "";
				const sessionName = pi.getSessionName();
				const beadsCounts = beadsCache?.counts;
				const effort = thinking ? `⚡${thinking === "high" ? "Hi" : thinking === "medium" ? "Md" : thinking.slice(0, 2)}` : "";
				const status = `${git.dirty ? "●" : ""}${git.untracked ? "…" : ""}${git.staged ? "✚" : ""}`;
				const nowMs = Date.now();
				const account = accountQuotaCells({
					nowMs,
					...fit,
					codex: codexCache && { value: codexCache.value, failed: codexCache.failed, staleAfterMs: codexStaleMs },
					claude: claudeCache && { value: claudeCache.value, failed: claudeCache.failed, staleAfterMs: claudeStaleMs },
				}, (tone, text) => theme.fg(tone, text));
				const claudeSnapshot = claudeCache?.value;
				const claudeSnapshotFresh = Boolean(claudeSnapshot && nowMs - claudeSnapshot.fetchedAtMs <= claudeStaleMs);
				const claudeTurn = claudeQuotaView(ctx.model?.provider, statuses.get(CLAUDE_QUOTA_STATUS_KEY), nowMs);
				const turn = claudeTurn && adapterAlertVisible(claudeTurn, claudeSnapshotFresh) ? claudeTurnCell(claudeTurn, fit.gaugeWidth) : "";
				const openRouterCredits = openRouterCreditsCache?.credits;
				const openRouterBalance = openRouterCredits
					? theme.fg(openRouterCreditsCache.isStale() ? "dim" : "success", `OR $${Math.round(openRouterCredits.remainingCredits)}`)
					: "";
				return {
					host: theme.fg("accent", ` ${hostname().split(".")[0]}`),
					k8s: k8sContext ? theme.fg("accent", `󱃾 ${k8sContext}`) : "",
					agent: theme.fg("success", theme.bold("π")),
					guard: formatSessionGuard(sessionMode, process.env.PI_STATUSLINE_GUARD_EMOJI !== "0", leaseScopes),
					model: theme.fg("success", theme.bold(model)),
					effort: effort ? theme.fg("accent", effort) : "",
					session: sessionName ? theme.fg("accent", `◈ ${truncateToWidth(sessionName, 24, "…")}`) : "",
					ctx: `${bar(usage.ctxPct, fit.gaugeWidth, CONTEXT_WARN_PERCENT, CONTEXT_CRIT_PERCENT, colors)} ${theme.fg("dim", "ctx")}`,
					gpt: account.gpt ?? "",
					claude: account.claude ?? "",
					claudeTurn: turn,
					openRouterBalance,
					cost: theme.fg("success", `est $${Math.round(usage.cost)}`),
					duration: theme.fg("dim", fmtDuration(Date.now() - startedAt)),
					path: theme.fg("muted", ` ${abbrevPath(ctx.cwd)}`),
					repo: git.isWorktree ? theme.fg("success", `🌳 ${git.repo ?? "worktree"}`) : "",
					branch: git.branch ? theme.fg(status ? "warning" : "success", ` ${git.branch}${status ? ` ${status}` : ""}`) : "",
					divergence: divergence ? theme.fg("warning", divergence) : "",
					pr: pr ? theme.fg("success", ` ${pr}`) : "",
					beads: beadsCounts
						? theme.fg(beadsCounts.blocked > 0 || beadsCounts.unavailableSources > 0 ? "warning" : "accent", formatBeadsCounts(beadsCounts))
						: "",
				};
			}

			function joinCells(cells: string[]): string {
				return cells.filter(Boolean).join(theme.fg("border", " │ "));
			}

			type Segments = ReturnType<typeof segments>;

			/** The first quota fit that `fits` accepts, otherwise the smallest. */
			function fittedSegments(fits: (s: Segments) => boolean): Segments {
				let s = segments(QUOTA_FITS[0]);
				for (const fit of QUOTA_FITS.slice(1)) {
					if (fits(s)) break;
					s = segments(fit);
				}
				return s;
			}

			function compact(width: number): string[] {
				const fullLine = (c: Segments) => joinCells([c.agent, c.guard, c.model, c.effort, c.ctx, c.gpt, c.claude, c.claudeTurn, c.openRouterBalance, c.k8s, c.duration, c.path, c.repo, c.branch, c.divergence, c.pr, c.session]);
				const s = fittedSegments((c) => visibleWidth(fullLine(c)) <= width);
				let line = fullLine(s);
				if (visibleWidth(line) <= width) return [line];
				const quotas = [s.gpt, s.claude, s.claudeTurn, s.openRouterBalance];
				let cells = [joinCells([s.agent, s.guard, s.model, s.effort]), s.ctx, ...quotas, s.k8s, s.duration, s.repo, s.branch, s.divergence, s.pr, s.session].filter(Boolean);
				line = joinCells(cells);
				if (visibleWidth(line) <= width) return [truncateToWidth(line, width)];
				cells = [joinCells([s.agent, s.guard, s.model, s.effort]), s.ctx, ...quotas, s.k8s, s.branch].filter(Boolean);
				line = joinCells(cells);
				if (visibleWidth(line) <= width) return [truncateToWidth(line, width)];
				cells = [s.agent, s.guard, s.model, s.ctx, s.k8s, s.branch, s.divergence, s.session].filter(Boolean);
				if (visibleWidth(joinCells(cells)) > width && s.divergence) cells = cells.filter((cell) => cell !== s.divergence);
				return [truncateToWidth(joinCells(cells), width)];
			}

			function table(width: number): string[] {
				const border = (text: string) => theme.fg("border", text);
				const locationCells = (c: Segments) => [c.host, c.k8s, c.path, c.repo, c.branch, c.divergence, c.pr, c.beads, c.session].filter(Boolean);
				const usageCells = (c: Segments) => [c.agent, c.guard, c.model, c.effort, c.ctx, c.gpt, c.claude, c.claudeTurn, c.openRouterBalance, c.cost, c.duration].filter(Boolean);

				function widthsFor(cells: string[]): number[] {
					return cells.map((cell) => visibleWidth(cell) + 2);
				}
				function totalWidth(widths: number[]): number {
					return widths.reduce((sum, w) => sum + w, 0) + widths.length + 1;
				}
				function normalize(widths: number[], target: number, growIndex = widths.length - 1): number[] {
					const out = [...widths];
					if (out.length > 0) out[Math.max(0, Math.min(growIndex, out.length - 1))] += Math.max(0, target - totalWidth(out));
					return out;
				}

				const tableWidth = (c: Segments) => Math.max(totalWidth(widthsFor(locationCells(c))), totalWidth(widthsFor(usageCells(c))));
				const s = fittedSegments((c) => tableWidth(c) <= width);
				let row1 = locationCells(s);
				const row2 = usageCells(s);
				let row1Widths = widthsFor(row1);
				let row2Widths = widthsFor(row2);
				let target = Math.max(totalWidth(row1Widths), totalWidth(row2Widths));

				// If the on-disk path still makes the table too wide, drop that cell;
				// the worktree repo + branch usually carry the more useful context.
				if (target > width && s.path) {
					row1 = [s.host, s.k8s, s.repo, s.branch, s.divergence, s.pr, s.beads, s.session].filter(Boolean);
					row1Widths = widthsFor(row1);
					target = Math.max(totalWidth(row1Widths), totalWidth(row2Widths));
				}
				if (target > width || target < 70) return compact(width);

				const pathIndex = row1.indexOf(s.path);
				const sessionIndex = row1.indexOf(s.session);
				const growIndex = pathIndex >= 0 ? pathIndex : Math.max(0, sessionIndex);
				row1Widths = normalize(row1Widths, target, growIndex);
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
					if (openRouterInterval) clearInterval(openRouterInterval);
					if (beadsInterval) clearInterval(beadsInterval);
					codexCache?.dispose();
					claudeCache?.dispose();
					openRouterCreditsCache?.dispose();
					beadsCache?.dispose();
					gitDivergenceCache?.dispose();
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
