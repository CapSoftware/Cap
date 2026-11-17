export type LoomImportState = "queued" | "importing" | "done" | "failed";

export const LOOM_IMPORT_STATES: readonly LoomImportState[] = [
	"queued",
	"importing",
	"done",
	"failed",
];

// A Loom import keeps a video_uploads row until processing finishes; the
// workflow deletes it on success. "uploading" is the queued state written when
// the import is accepted, before the worker starts downloading.
export function loomImportState(
	uploadPhase: string | null | undefined,
): LoomImportState {
	switch (uploadPhase) {
		case null:
		case undefined:
		case "complete":
			return "done";
		case "uploading":
			return "queued";
		case "error":
			return "failed";
		default:
			return "importing";
	}
}

export type LoomImportCounts = Record<LoomImportState, number> & {
	total: number;
};

export function emptyLoomImportCounts(): LoomImportCounts {
	return { queued: 0, importing: 0, done: 0, failed: 0, total: 0 };
}

export function addLoomImportCounts(
	into: LoomImportCounts,
	from: Partial<Record<LoomImportState, number>>,
): LoomImportCounts {
	for (const state of LOOM_IMPORT_STATES) {
		const value = from[state] ?? 0;
		into[state] += value;
		into.total += value;
	}
	return into;
}
