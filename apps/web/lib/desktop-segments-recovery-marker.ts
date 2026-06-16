import { createHash } from "node:crypto";
import { Video } from "@cap/web-domain";

export const DESKTOP_SEGMENTS_RECOVERY_MARKER_PREFIX =
	"desktop-segments-recovery:v1:";

export type DesktopSegmentsRecoveryMarker = {
	observedAtMs: number;
	signature: string;
};

export function getDesktopSegmentsManifestSignature(
	manifest: Video.SegmentManifestType,
) {
	const normalize = (segments: Video.SegmentManifestType["video_segments"]) =>
		segments
			.map(Video.normalizeSegmentEntry)
			.toSorted((a, b) => a.index - b.index);

	return createHash("sha256")
		.update(
			JSON.stringify({
				videoInitUploaded: manifest.video_init_uploaded,
				audioInitUploaded: manifest.audio_init_uploaded,
				videoSegments: normalize(manifest.video_segments),
				audioSegments: normalize(manifest.audio_segments),
				isComplete: manifest.is_complete,
			}),
		)
		.digest("hex")
		.slice(0, 32);
}

export function buildDesktopSegmentsRecoveryMarker(
	signature: string,
	observedAtMs = Date.now(),
) {
	return `${DESKTOP_SEGMENTS_RECOVERY_MARKER_PREFIX}${observedAtMs}:${signature}`;
}

export function parseDesktopSegmentsRecoveryMarker(
	message: string | null | undefined,
): DesktopSegmentsRecoveryMarker | null {
	if (!message?.startsWith(DESKTOP_SEGMENTS_RECOVERY_MARKER_PREFIX)) {
		return null;
	}

	const payload = message.slice(DESKTOP_SEGMENTS_RECOVERY_MARKER_PREFIX.length);
	const [observedAtRaw, signature] = payload.split(":");
	const observedAtMs = Number(observedAtRaw);

	if (!Number.isSafeInteger(observedAtMs) || !signature) {
		return null;
	}

	return { observedAtMs, signature };
}
