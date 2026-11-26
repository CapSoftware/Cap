export const parseAmount = (text: string, max: number) => {
	const cleaned = text.replace(/[^\d.]/g, "");
	const [whole = "", ...rest] = cleaned.split(".");
	const draft =
		rest.length > 0 ? `${whole}.${rest.join("").slice(0, 2)}` : whole;
	const parsed = Number(draft);
	if (!Number.isFinite(parsed)) return { draft, value: 0 };
	if (parsed > max) return { draft: String(max), value: max };
	return { draft, value: parsed };
};
