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
const roleBySession = new Map<string, string>();

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
	if (!root) return { repo: basename(cwd) || DEFAULT_REPO, branch: "", mark: "󰉋" };

	const commonDir = run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
	const repo = commonDir ? basename(dirname(commonDir)) : basename(root);
	return { repo: repo || DEFAULT_REPO, branch, mark: "" };
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

function buildLabel(ctx: ExtensionContext, promptOrEvidence = ""): string {
	const git = getGitInfo(ctx.cwd);
	const repo = process.env.KITTY_TITLE_REPO_ALIAS || git.repo;
	const branchShort = shortBranch(git.branch);
	let label = `${git.mark}-${repo}`;

	if (process.env.SSH_TTY) {
		const host = process.env.KITTY_TITLE_HOST_ALIAS ? `${process.env.KITTY_TITLE_HOST_ALIAS}/` : "";
		label = `🌐${host}·${label}`;
	}

	if (branchShort) {
		label += `/${branchShort}`;
	} else {
		const bead = sessionBead(ctx, git.branch, promptOrEvidence);
		if (bead) label += `/${displayBead(git.repo, bead)}`;
	}

	const role = sessionRole(ctx, promptOrEvidence);
	if (role) label += `·${role}`;
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

function updateTitle(ctx: ExtensionContext, state: string, evidence = ""): void {
	setKittyTabTitle(`${buildLabel(ctx, evidence)}·${state}`);
}

export default function piKittyTabTitle(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => updateTitle(ctx, "🌱"));

	pi.on("input", (event, ctx) => {
		sessionRole(ctx, event.text);
		updateTitle(ctx, "💭", event.text);
	});

	pi.on("agent_start", (_event, ctx) => updateTitle(ctx, "💭"));
	pi.on("tool_execution_start", (event, ctx) => updateTitle(ctx, "⚙️", `${event.toolName}\n${JSON.stringify(event.args ?? {})}`));
	pi.on("tool_execution_end", (_event, ctx) => updateTitle(ctx, "💭"));
	pi.on("session_before_compact", (_event, ctx) => updateTitle(ctx, "🧹"));
	pi.on("session_compact", (_event, ctx) => updateTitle(ctx, "💭"));
	pi.on("agent_end", (_event, ctx) => updateTitle(ctx, "✅"));
	pi.on("session_shutdown", (_event, ctx) => updateTitle(ctx, "✅"));
}
