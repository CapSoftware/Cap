export const MAX_DEVELOPER_API_OFFSET = 1_000_000_000;
export const DEFAULT_DEVELOPER_API_LIMIT = 50;
export const MAX_DEVELOPER_API_LIMIT = 100;

export function parseDeveloperVideosPagination(
	rawLimit: string | undefined,
	rawOffset: string | undefined,
): { limit: number; offset: number } {
	const parsedLimit = Number(rawLimit);
	const limit =
		Number.isFinite(parsedLimit) && parsedLimit >= 1
			? Math.min(Math.floor(parsedLimit), MAX_DEVELOPER_API_LIMIT)
			: DEFAULT_DEVELOPER_API_LIMIT;

	const parsedOffset = Number(rawOffset);
	const offset =
		Number.isFinite(parsedOffset) && parsedOffset >= 0
			? Math.min(Math.floor(parsedOffset), MAX_DEVELOPER_API_OFFSET)
			: 0;

	return { limit, offset };
}
