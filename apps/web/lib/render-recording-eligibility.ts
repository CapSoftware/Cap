import type { VideoMetadata } from "@cap/database/types";

/** Renders of this length or longer need Cap Pro, like saves. */
export const PRO_DURATION_SECONDS = 5 * 60;

export type RecordingRenderCandidate = {
	isScreenshot: boolean;
	sourceType: string;
	duration: number | null;
	metadata: VideoMetadata | null;
	ownerIsPro: boolean;
};

/**
 * Whether a finished recording gets rendered with the owner's style: only a
 * browser or extension recording with separate editor sources, nobody has
 * edited or saved yet, within the Save plan limits.
 */
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

/**
 * Where the recording's sources are in finishing. A render waits until the
 * display source is verified and nothing is still uploading.
 */
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
