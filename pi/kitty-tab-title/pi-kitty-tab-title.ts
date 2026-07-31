import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile, execFileSync } from "node:child_process";
import { dirname, basename } from "node:path";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

interface GitInfo {
	repo: string;
	branch: string;
	mark: string;
}

const DEFAULT_REPO = "pi";
const SESSION_NAME_MAX_LENGTH = 24;
const roleBySession = new Map<string, string>();
const stateBySession = new Map<string, string>();

function keepSessionNameCharacter(character: string): boolean {
	const codePoint = character.codePointAt(0) ?? 0;
	if (
		(codePoint >= 0x30 && codePoint <= 0x39) ||
		(codePoint >= 0x41 && codePoint <= 0x5a) ||
		(codePoint >= 0x61 && codePoint <= 0x7a)
	) return true;
	if (codePoint <= 0xbf) return false;
	if (
		codePoint === 0x034f ||
		(codePoint >= 0x0600 && codePoint <= 0x0605) ||
		codePoint === 0x061c ||
		codePoint === 0x06dd ||
		codePoint === 0x070f ||
		(codePoint >= 0x0890 && codePoint <= 0x0891) ||
		codePoint === 0x08e2 ||
		(codePoint >= 0x115f && codePoint <= 0x1160) ||
		(codePoint >= 0x17b4 && codePoint <= 0x17b5) ||
		(codePoint >= 0x180b && codePoint <= 0x180f) ||
		(codePoint >= 0x2000 && codePoint <= 0x206f) ||
		(codePoint >= 0x2190 && codePoint <= 0x303f) ||
		codePoint === 0x3164 ||
		(codePoint >= 0xd800 && codePoint <= 0xdfff) ||
		(codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
		codePoint === 0xfeff ||
		codePoint === 0xffa0 ||
		(codePoint >= 0xfff0 && codePoint <= 0xffff) ||
		codePoint === 0x110bd ||
		codePoint === 0x110cd ||
		(codePoint >= 0x13430 && codePoint <= 0x1343f) ||
		(codePoint >= 0x1bca0 && codePoint <= 0x1bcaf) ||
		(codePoint >= 0x1d173 && codePoint <= 0x1d17a) ||
		(codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
		(codePoint >= 0xe0000 && codePoint <= 0xe0fff) ||
		(codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
		(codePoint & 0xffff) >= 0xfffe
	) return false;
	return true;
}

export function normalizeSessionName(name: string | undefined): string {
	if (!name) return "";
	const parts: string[] = [];
	let separator = false;
	for (const character of name) {
		if (keepSessionNameCharacter(character)) {
			if (separator && parts.length > 0) parts.push("-");
			parts.push(character);
			separator = false;
		} else {
			separator = parts.length > 0;
		}
	}
	return parts.slice(0, SESSION_NAME_MAX_LENGTH).join("").replace(/-+$/g, "");
}

function log(message: string): void {
	const file = process.env.PI_KITTY_TITLE_LOG;
	if (!file) return;
	try {
		appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// Keep title updates silent.
	}
}

function run(command: string, args: string[], cwd?: string): string {
	try {
		return execFileSync(command, args, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 700,
		}).trim();
	} catch {
		return "";
	}
}

function getGitInfo(cwd: string): GitInfo {
	const root = run("git", ["rev-parse", "--show-toplevel"], cwd);
	const branch = run("git", ["branch", "--show-current"], cwd);
	if (!root) return { repo: basename(cwd) || DEFAULT_REPO, branch: "", mark: "π·󰉋" };

	const commonDir = run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
	const repo = commonDir ? basename(dirname(commonDir)) : basename(root);
	return { repo: repo || DEFAULT_REPO, branch, mark: "π·" };
}

function shortBranch(branch: string): string {
	let b = branch
		.replace(/^worktree-/, "")
		.replace(/^feature\//, "")
		.replace(/^fix\//, "")
		.replace(/^bugfix\//, "")
		.replace(/^chore\//, "");
	if (!b || ["main", "master", "trunk"].includes(b)) return "";
	const pr = b.match(/^(pr-\d+)/i);
	if (pr) return pr[1] ?? b;
	const ticket = b.match(/^([A-Za-z]{2,}-\d+)/);
	if (ticket) return ticket[1] ?? b;
	if (b.includes("-")) b = b.split("-")[0] ?? b;
	return b;
}

function safeSessionKey(ctx: ExtensionContext): string {
	return (ctx.sessionManager.getSessionId() || `${ctx.cwd}|${process.pid}`).replace(/[^A-Za-z0-9._-]/g, "");
}

function roleForPrompt(prompt: string): string {
	if (/^(\/|\$)watch-release(\s|$)/.test(prompt)) return "🚢-releases";
	if (/^(\/|\$)watch-prs(\s|$)/.test(prompt)) return "👀-PRs";
	return "";
}

function sessionRole(ctx: ExtensionContext, prompt?: string): string {
	const key = safeSessionKey(ctx);
	const file = `/tmp/kitty-role-pi-${key}`;
	if (prompt !== undefined) {
		const role = roleForPrompt(prompt);
		if (role) {
			roleBySession.set(key, role);
			try {
				writeFileSync(file, role);
			} catch {
				// Ignore.
			}
		}
	}
	const fromMemory = roleBySession.get(key);
	if (fromMemory) return fromMemory.replace(/\s+/g, "-");
	try {
		if (existsSync(file)) return readFileSync(file, "utf8").trim().replace(/\s+/g, "-");
	} catch {
		// Ignore.
	}
	return "";
}

function findBeadsRoot(cwd: string): string {
	let dir = cwd;
	while (dir !== "/") {
		if (existsSync(`${dir}/.beads`)) return dir;
		dir = dirname(dir);
	}
	return "";
}

function displayBead(repo: string, bead: string): string {
	let marker = "";
	let id = bead;
	if (id.startsWith("✓")) {
		marker = "✓";
		id = id.slice(1);
	}
	if (id.startsWith(`${repo}-`)) id = id.slice(repo.length + 1);
	return `${marker}${id}`;
}

function sessionBead(ctx: ExtensionContext, branch: string, evidence = ""): string {
	if (branch && !["main", "master", "trunk"].includes(branch)) return "";
	const root = findBeadsRoot(ctx.cwd);
	if (!root) return "";
	const issuesFile = `${root}/.beads/issues.jsonl`;
	if (!existsSync(issuesFile)) return "";

	const key = safeSessionKey(ctx);
	const stateFile = `/tmp/kitty-bead-session-pi-${key}`;
	const issues = readFileSync(issuesFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line) as { id?: string; status?: string; closed_at?: string; updated_at?: string };
			} catch {
				return undefined;
			}
		})
		.filter((issue): issue is { id?: string; status?: string; closed_at?: string; updated_at?: string } => Boolean(issue?.id));

	const byId = new Map(issues.map((issue) => [issue.id, issue]));
	const candidates = [...new Set(evidence.match(/[A-Za-z][A-Za-z0-9_-]*-[A-Za-z0-9]+(?:[.]\d+)?/g) ?? [])].filter((id) => byId.has(id));
	let candidate = candidates.length === 1 ? candidates[0] : "";

	if (candidate) {
		try { writeFileSync(stateFile, candidate); } catch {}
	} else if (existsSync(stateFile)) {
		candidate = readFileSync(stateFile, "utf8").trim();
	} else {
		const inProgress = issues.filter((issue) => issue.status === "in_progress").map((issue) => issue.id ?? "");
		if (inProgress.length === 1) candidate = inProgress[0] ?? "";
		else if (inProgress.length === 0) {
			candidate = issues
				.filter((issue) => issue.status === "closed")
				.sort((a, b) => String(a.closed_at ?? a.updated_at ?? "").localeCompare(String(b.closed_at ?? b.updated_at ?? "")))
				.at(-1)?.id ?? "";
		}
		if (candidate) try { writeFileSync(stateFile, candidate); } catch {}
	}

	if (!candidate) return "";
	const status = byId.get(candidate)?.status;
	return status === "closed" ? `✓${candidate}` : candidate;
}

export function buildLabel(
	ctx: ExtensionContext,
	promptOrEvidence = "",
	sessionName?: string,
): string {
	const git = getGitInfo(ctx.cwd);
	const repo = process.env.KITTY_TITLE_REPO_ALIAS || git.repo;
	const normalizedSessionName = normalizeSessionName(sessionName);
	const role = sessionRole(ctx, promptOrEvidence);
	let label = `${git.mark}-${repo}`;

	if (process.env.SSH_TTY) {
		const host = process.env.KITTY_TITLE_HOST_ALIAS ? `${process.env.KITTY_TITLE_HOST_ALIAS}/` : "";
		label = `🌐${host}·${label}`;
	}

	if (normalizedSessionName) {
		label += `/${normalizedSessionName}`;
	} else {
		const branchShort = shortBranch(git.branch);
		if (branchShort) {
			label += `/${branchShort}`;
		} else {
			const bead = sessionBead(ctx, git.branch, promptOrEvidence);
			if (bead) label += `/${displayBead(git.repo, bead)}`;
		}

		if (role) label += `·${role}`;
	}
	return label;
}

function setKittyTabTitle(title: string): void {
	log(`title=${title}`);
	if (process.env.SSH_TTY) {
		try {
			const command = JSON.stringify({ cmd: "set-tab-title", version: [0, 26, 0], no_response: true, payload: { title } });
			writeFileSync(process.env.SSH_TTY, `\u001bP@kitty-cmd${command}\u001b\\`);
			return;
		} catch {
			// Fall through to OSC fallback.
		}
	}

	execFile("kitten", ["@", "set-tab-title", title], { timeout: 1000 }, (error) => {
		if (!error) return;
		execFile("kitten", ["@", "--to", "unix:@kitty", "set-tab-title", title], { timeout: 1000 }, () => undefined);
	});

	try {
		writeFileSync(process.env.SSH_TTY || "/dev/tty", `\u001b]30;${title}\u0007\u001b]2;${title}\u0007`);
	} catch {
		// No controlling terminal or not Kitty.
	}
}

const ORCA_CONFLICT_MESSAGE =
	"Pi Kitty tab titles are disabled because ORCA_PANE_KEY enables the competing orca-titlebar-spinner writer. Disable orca-titlebar-spinner.ts, then set PI_KITTY_TITLE_ALLOW_ORCA=1 for this session to use flurdy-kitty-tab-title.ts.";

export function registerPiKittyTabTitle(
	pi: ExtensionAPI,
	writeTitle: (title: string) => void = setKittyTabTitle,
): void {
	if (process.env.ORCA_PANE_KEY && process.env.PI_KITTY_TITLE_ALLOW_ORCA !== "1") {
		pi.on("session_start", (_event, ctx) => {
			log(`disabled=${ORCA_CONFLICT_MESSAGE}`);
			ctx.ui.notify(ORCA_CONFLICT_MESSAGE, "warning");
		});
		return;
	}

	const updateTitle = (
		ctx: ExtensionContext,
		state: string,
		evidence = "",
		sessionName = pi.getSessionName(),
	): void => {
		stateBySession.set(safeSessionKey(ctx), state);
		writeTitle(`${buildLabel(ctx, evidence, sessionName)}·${state}`);
	};

	pi.on("session_start", (_event, ctx) => updateTitle(ctx, "🌱"));
	pi.on("session_info_changed", (event, ctx) => {
		const state = stateBySession.get(safeSessionKey(ctx)) ?? "🌱";
		stateBySession.set(safeSessionKey(ctx), state);
		writeTitle(`${buildLabel(ctx, "", event.name)}·${state}`);
	});

	pi.on("input", (event, ctx) => updateTitle(ctx, "💭", event.text));
	pi.on("agent_start", (_event, ctx) => updateTitle(ctx, "💭"));
	pi.on("tool_execution_start", (event, ctx) =>
		updateTitle(ctx, "⚙️", `${event.toolName}\n${JSON.stringify(event.args ?? {})}`),
	);
	pi.on("tool_execution_end", (_event, ctx) => updateTitle(ctx, "💭"));
	pi.on("session_before_compact", (_event, ctx) => updateTitle(ctx, "🧹"));
	pi.on("session_compact", (_event, ctx) => updateTitle(ctx, "💭"));
	pi.on("agent_end", (_event, ctx) => updateTitle(ctx, "✅"));
	pi.on("session_shutdown", (_event, ctx) => {
		updateTitle(ctx, "✅");
		stateBySession.delete(safeSessionKey(ctx));
	});
}

export default registerPiKittyTabTitle;
