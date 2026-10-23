import type { Video } from "@cap/web-domain";
import { readCompletedRecordingManifest } from "./desktop-recording-verification";

export function getSegmentPlaybackState(
	manifest: Video.SegmentManifestType,
): "ready" | "uploading" | "incomplete" {
	if (!manifest.is_complete) return "uploading";
	try {
		readCompletedRecordingManifest(JSON.stringify(manifest));
		return "ready";
	} catch {
		return "incomplete";
	}
}
