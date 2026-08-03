import { Video } from "@cap/web-domain";

/**
 * Helpers for turning a desktop instant-mode recording's uploaded audio
 * segments (fMP4 init + .m4s fragments) into a single audio file the
 * transcription pipeline can consume, without waiting for the media server
 * to mux `result.mp4`.
 */

export interface NormalizedSegmentEntry {
	index: number;
	duration: number;
}

export type SegmentsAudioPlan =
	| { status: "unavailable"; reason: string }
	| { status: "no-audio" }
	| {
			status: "ok";
			entries: NormalizedSegmentEntry[];
			totalDurationMs: number;
	  };

/**
 * Decide whether a segment manifest can back an audio extraction. The manifest
 * must be finalized (`is_complete`) so we never transcribe a partial
 * recording; a complete manifest without audio segments means the recording
 * genuinely has no audio track.
 */
export function planSegmentsAudioExtraction(
	manifest: Video.SegmentManifestType,
	options: { requireComplete?: boolean } = {},
): SegmentsAudioPlan {
	const requireComplete = options.requireComplete ?? true;

	if (requireComplete && !manifest.is_complete) {
		return { status: "unavailable", reason: "manifest is not complete" };
	}

	if (!manifest.audio_init_uploaded || manifest.audio_segments.length === 0) {
		return { status: "no-audio" };
	}

	const byIndex = new Map<number, NormalizedSegmentEntry>();
	for (const raw of manifest.audio_segments) {
		const entry = Video.normalizeSegmentEntry(raw);
		if (
			!Number.isFinite(entry.index) ||
			entry.index < 0 ||
			!Number.isFinite(entry.duration) ||
			entry.duration < 0
		) {
			return {
				status: "unavailable",
				reason: `invalid audio segment entry (index=${entry.index})`,
			};
		}
		if (!byIndex.has(entry.index)) {
			byIndex.set(entry.index, entry);
		}
	}

	const entries = [...byIndex.values()].sort((a, b) => a.index - b.index);
	const totalDurationMs = Math.round(
		entries.reduce((sum, entry) => sum + entry.duration, 0) * 1000,
	);

	return { status: "ok", entries, totalDurationMs };
}
