function titleModelWords(value: string): string {
	return value
		.split(/[-_ ]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

export function shortModel(id: string): string {
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
	const opus = s.match(/opus[-_ ]?(\d+(?:[.-]\d+)?)/);
	if (opus) return `Claude Opus ${opus[1].replace("-", ".")}`;
	const sonnet = s.match(/sonnet[-_ ]?(\d+(?:[.-]\d+)?)/);
	if (sonnet) return `Claude Sonnet ${sonnet[1].replace("-", ".")}`;
	const haiku = s.match(/haiku[-_ ]?(\d+(?:[.-]\d+)?)/);
	if (haiku) return `Claude Haiku ${haiku[1].replace("-", ".")}`;
	const fable = s.match(/fable[-_ ]?(\d+(?:[.-]\d+)?)/);
	if (fable) return `Claude Fable ${fable[1].replace("-", ".")}`;
	if (s.includes("codex")) return "Codex";
	return titleModelWords(raw.replace(/^claude-/, "").replace(/^gpt-/, "GPT-"));
}

export function modelLabel(provider: string | undefined, id: string): string {
	const model = shortModel(id);
	return provider === "openrouter" ? `OR ${model}` : model;
}

export function activeModelLabel(provider: string | undefined, id: string | undefined, thinking: string): string | undefined {
	if (!id) return undefined;
	return `Running: ${modelLabel(provider, id)}${thinking ? ` · thinking ${thinking}` : ""}`;
}
