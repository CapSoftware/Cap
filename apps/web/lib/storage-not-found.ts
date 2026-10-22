// A transient HEAD failure (5xx, SlowDown, network) must not read as "missing":
// save-edits would then copy the edited result over the preserved original.
export function isStorageObjectNotFound(error: unknown): boolean {
	const visited = new Set<unknown>();
	let value: unknown = error;
	for (let depth = 0; depth < 16; depth++) {
		if (typeof value !== "object" || value === null || visited.has(value))
			return false;
		visited.add(value);
		const record = value as Record<string, unknown>;
		if (record.name === "NoSuchKey" || record.name === "NotFound") return true;
		if (record.name === "GoogleDriveRequestError" && record.status === 404)
			return true;
		const metadata = record.$metadata;
		if (
			typeof metadata === "object" &&
			metadata !== null &&
			"httpStatusCode" in metadata &&
			metadata.httpStatusCode === 404
		)
			return true;
		value = record.cause;
	}
	return false;
}
