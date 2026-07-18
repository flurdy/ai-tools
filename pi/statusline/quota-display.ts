export const CODEX_QUOTA_WARN_PERCENT = 60;
export const CODEX_QUOTA_CRIT_PERCENT = 75;

type BarColors = {
	ok: (s: string) => string;
	warn: (s: string) => string;
	crit: (s: string) => string;
	empty: (s: string) => string;
};

export function bar(pct: number, width: number, warn = 60, crit = 80, colors: BarColors): string {
	const p = Math.max(0, Math.min(100, Math.round(pct)));
	const filled = Math.max(0, Math.min(width, Math.floor((p / 100) * width)));
	const fill = "▮".repeat(filled);
	const empty = "▯".repeat(width - filled);
	const color = p >= crit ? colors.crit : p >= warn ? colors.warn : colors.ok;
	return color(fill) + colors.empty(empty);
}

export function codexQuotaTone(usedPercent: number): "success" | "warning" | "error" {
	return usedPercent >= CODEX_QUOTA_CRIT_PERCENT ? "error" : usedPercent >= CODEX_QUOTA_WARN_PERCENT ? "warning" : "success";
}
