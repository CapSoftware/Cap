import type { InfraLocalUpload } from "./infra-video-view";

export type InfraTranscriptStatus =
	| "uploading"
	| "queued"
	| "processing"
	| "complete"
	| "error";

export type InfraTranscriptDisplayState = InfraTranscriptStatus | "unfinished";

export const INFRA_TRANSCRIPT_LABELS: Record<
	InfraTranscriptDisplayState,
	string
> = {
	uploading: "Uploading",
	unfinished: "Upload not finished",
	queued: "Queued",
	processing: "Transcribing",
	complete: "Complete",
	error: "Failed",
};

export function infraTranscriptDisplayState(
	status: InfraTranscriptStatus,
	local: InfraLocalUpload,
): InfraTranscriptDisplayState {
	if (status !== "uploading") return status;
	if (local === "sending") return "uploading";
	return local === "sent" ? "queued" : "unfinished";
}
