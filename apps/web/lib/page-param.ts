export function parsePageParam(
	value: string | string[] | null | undefined,
	fallback = 1,
): number {
	const parsed = Number(Array.isArray(value) ? value[0] : value);
	return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback;
}
