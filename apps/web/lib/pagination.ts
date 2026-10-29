export function parsePageParam(
	page: string | string[] | undefined,
	defaultValue = 1,
): number {
	const value = Array.isArray(page) ? page[0] : page;
	const parsed = Number(value);

	if (!Number.isInteger(parsed) || parsed < 1) return defaultValue;

	return parsed;
}

export function parseLimitParam(
	limit: string | string[] | undefined,
	defaultValue = 15,
	maxLimit = 100,
): number {
	const value = Array.isArray(limit) ? limit[0] : limit;
	const parsed = Number(value);

	if (!Number.isInteger(parsed) || parsed < 1) return defaultValue;

	return Math.min(parsed, maxLimit);
}
