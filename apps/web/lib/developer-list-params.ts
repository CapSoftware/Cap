const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export function parseDeveloperListParams(
	limit: string | undefined,
	offset: string | undefined,
) {
	return {
		limit: Math.min(
			Math.max(1, Math.trunc(Number(limit)) || DEFAULT_LIMIT),
			MAX_LIMIT,
		),
		offset: Math.min(
			Math.max(0, Math.trunc(Number(offset)) || 0),
			Number.MAX_SAFE_INTEGER,
		),
	};
}
