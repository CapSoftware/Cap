/** Thousandths of the whole job: tracking takes about 70% of it. */
export function cursorProgress(line: string) {
	try {
		const { stage, progress } = JSON.parse(line) as {
			stage?: unknown;
			progress?: unknown;
		};
		if (typeof progress !== "number" || !Number.isFinite(progress)) return null;
		const fraction = Math.min(1, Math.max(0, progress));
		if (stage === "tracking") return Math.floor(fraction * 700);
		if (stage === "repairing") return 700 + Math.floor(fraction * 290);
		if (stage === "complete") return 990;
		return null;
	} catch {
		return null;
	}
}
