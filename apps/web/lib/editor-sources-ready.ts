import type { VideoMetadata } from "@cap/database/types";
import { getEditSourceKey } from "./video-edit-processing";

// The editor reads the raw sources, not the processed share video, and
// processing keeps those raw files for exactly this shape of metadata.
export function editorSourcesUploaded(
	metadata: VideoMetadata | null | undefined,
	uploadPhase: string | null,
) {
	if (
		uploadPhase !== "processing" &&
		uploadPhase !== "generating_thumbnail" &&
		uploadPhase !== "error"
	) {
		return false;
	}
	const sources = metadata?.editorSources;
	if (!sources || sources.version !== 1) return false;
	const { display, camera } = sources;
	return (
		!!display &&
		Number.isSafeInteger(display.size) &&
		(display.size ?? 0) > 0 &&
		(!camera ||
			(Number.isSafeInteger(camera.size) && (camera.size ?? 0) > 0)) &&
		!metadata?.editProcessing
	);
}

export function hasStudioEditorSource(
	ownerId: string,
	videoId: string,
	metadata: VideoMetadata | null | undefined,
	existingEditSourceKey: string | null | undefined,
) {
	if (existingEditSourceKey !== undefined)
		return existingEditSourceKey === getEditSourceKey(ownerId, videoId);
	const sources = metadata?.editorSources;
	return (
		sources == null ||
		(sources.version === 1 &&
			Boolean(sources.display) &&
			Number.isSafeInteger(sources.display.size) &&
			(sources.display.size ?? 0) > 0)
	);
}
