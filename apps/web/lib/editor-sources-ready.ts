import type { VideoMetadata } from "@cap/database/types";

/**
 * Whether the editor can open a recording that is still processing. The
 * editor reads the raw sources, not the processed share video, so it only
 * needs the display (and camera, when there is one) fully uploaded. Processing
 * keeps those raw files for exactly this shape of metadata.
 */
export function editorSourcesUploaded(
	metadata: VideoMetadata | null | undefined,
	uploadPhase: string | null,
) {
	if (uploadPhase !== "processing" && uploadPhase !== "generating_thumbnail") {
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
