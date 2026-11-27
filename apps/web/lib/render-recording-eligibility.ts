import type { VideoMetadata } from "@cap/database/types";

export const PRO_DURATION_SECONDS = 5 * 60;

export type RecordingRenderCandidate = {
	isScreenshot: boolean;
	sourceType: string;
	duration: number | null;
	metadata: VideoMetadata | null;
	ownerIsPro: boolean;
};

export function recordingRenderEligible(candidate: RecordingRenderCandidate) {
	const metadata = candidate.metadata;
	return (
		!candidate.isScreenshot &&
		candidate.sourceType === "webMP4" &&
		metadata?.editorSources?.version === 1 &&
		!!metadata.editorSources.display &&
		!metadata.renderFarmSave &&
		!metadata.webEditorProject &&
		!metadata.editProcessing &&
		(candidate.ownerIsPro || (candidate.duration ?? 0) < PRO_DURATION_SECONDS)
	);
}

export function recordingRenderSourcesReady(
	metadata: VideoMetadata | null,
	duration: number | null,
	uploadPhase: string | null,
) {
	const display = metadata?.editorSources?.display;
	return (
		!!display?.size && !!duration && duration > 0 && uploadPhase !== "uploading"
	);
}
