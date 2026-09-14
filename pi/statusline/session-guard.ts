export const SESSION_GUARD_EMOJI = {
	acquiring: "⏳",
	implement: "✅",
	plan: "🔍",
	conflict: "⛔",
	lost: "💥",
	unguarded: "🚨",
} as const;

export type SessionGuardLabel = keyof typeof SESSION_GUARD_EMOJI;

const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function sessionGuardLabel(status: string): SessionGuardLabel | undefined {
	const label = status.replace(ANSI_SEQUENCE, "").trim();
	return Object.hasOwn(SESSION_GUARD_EMOJI, label) ? label as SessionGuardLabel : undefined;
}

export function formatSessionGuard(status: string, emojiEnabled = true, leaseScopes = ""): string {
	const label = sessionGuardLabel(status);
	if (label === "implement") {
		const plain = leaseScopes.replace(ANSI_SEQUENCE, "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
		const match = /^leases:([0-9]|[12][0-9]|3[0-2])(?:\s+.*)?$/.exec(plain);
		const count = match ? Number(match[1]) : 0;
		if (count > 0) {
			const suffix = count > 1 ? String(count) : "";
			return emojiEnabled ? `🔒${suffix}` : `${status}${suffix ? ` ${suffix}` : ""}`;
		}
	}
	return emojiEnabled && label ? SESSION_GUARD_EMOJI[label] : status;
}
