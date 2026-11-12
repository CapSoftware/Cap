export const parseAmount = (text: string, max: number) => {
	const cleaned = text.replace(/[^\d.]/g, "");
	const [whole = "", ...rest] = cleaned.split(".");
	const draft =
		rest.length > 0 ? `${whole}.${rest.join("").slice(0, 2)}` : whole;
	const parsed = Number(draft);
	return {
		draft,
		value: Number.isFinite(parsed) ? Math.min(max, parsed) : 0,
	};
};
