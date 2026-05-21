type RecordingCompletePhase =
	| "uploading"
	| "processing"
	| "generating_thumbnail"
	| "complete"
	| "error";

export const RECORDING_COMPLETE_UNCLAIMABLE_PHASES = [
	"processing",
	"generating_thumbnail",
	"complete",
] satisfies RecordingCompletePhase[];

export type RecordingCompleteIdempotentResult =
	| {
			success: true;
			alreadyProcessing: true;
			phase: "processing" | "generating_thumbnail";
	  }
	| {
			success: true;
			alreadyComplete: true;
			phase: "complete";
	  };

export function isSegmentedRecordingSource(
	source: { type: string } | null | undefined,
) {
	return source?.type === "desktopSegments";
}

export function isMaterializedDesktopRecordingSource(
	source: { type: string } | null | undefined,
) {
	return source?.type === "desktopMP4";
}

export function getRecordingCompleteIdempotentResult(
	upload: { phase: RecordingCompletePhase } | null | undefined,
): RecordingCompleteIdempotentResult | null {
	switch (upload?.phase) {
		case "processing":
		case "generating_thumbnail":
			return {
				success: true,
				alreadyProcessing: true,
				phase: upload.phase,
			};
		case "complete":
			return {
				success: true,
				alreadyComplete: true,
				phase: upload.phase,
			};
		default:
			return null;
	}
}
