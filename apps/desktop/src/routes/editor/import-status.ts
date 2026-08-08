/**
 * Which screen the editor should show while a recording's metadata loads.
 *
 * Extracted from `Editor.tsx` so the state machine can be tested without a
 * running editor. The case that matters is `error`: `getRecordingMetaByPath`
 * returns `Result<RecordingMeta, String>` and fails whenever
 * `recording-meta.json` is missing or unparseable. A failed query has no
 * `data`, so treating "no data" as "still loading" leaves the editor on the
 * loading skeleton indefinitely (#1812).
 */
export type EditorImportStatus = "loading" | "importing" | "ready" | "error";

export function deriveRawImportStatus(query: {
	data: unknown;
	isError: boolean;
}): EditorImportStatus {
	if (query.isError) return "error";
	if (!query.data) return "loading";

	const meta = query.data as { status?: unknown };
	if (
		"status" in meta &&
		meta.status &&
		typeof meta.status === "object" &&
		"status" in meta.status &&
		(meta.status as { status?: unknown }).status === "InProgress"
	) {
		return "importing";
	}

	return "ready";
}

/**
 * `lockedToImporting` latches once an import starts, so the UI doesn't flicker
 * between screens as the metadata is re-read. An error has to outrank that
 * latch: if the metadata stops being readable mid-import there is nothing left
 * to wait for, and without this the editor would stay on the import screen for
 * the same reason it used to stay on the skeleton.
 */
export function deriveImportStatus(
	rawStatus: EditorImportStatus,
	lockedToImporting: boolean,
): EditorImportStatus {
	if (rawStatus === "error") return "error";
	if (lockedToImporting) return "importing";
	return rawStatus;
}
