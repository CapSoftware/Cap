export const MAX_ARCHIVE_ITEMS = 500;

export function chunkIds<T>(ids: readonly T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < ids.length; i += size)
		chunks.push(ids.slice(i, i + size));
	return chunks;
}
