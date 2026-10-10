/**
 * Names the file a share link plays. Every Save publishes to a new storage
 * key, so a page compares this with the server's to tell that it's showing an
 * older version. Hashed so the status endpoint doesn't hand out storage keys.
 */
export function shareVideoRevision(source: unknown): string | null {
	if (
		typeof source !== "object" ||
		source === null ||
		!("type" in source) ||
		typeof source.type !== "string"
	)
		return null;
	const outputKey =
		"outputKey" in source && typeof source.outputKey === "string"
			? source.outputKey
			: "";
	return hash53(`${source.type}:${outputKey}`);
}

function hash53(value: string) {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		h1 = Math.imul(h1 ^ code, 2654435761);
		h2 = Math.imul(h2 ^ code, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
