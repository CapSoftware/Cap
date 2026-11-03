import { Video } from "@cap/web-domain";
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

type SegmentEntry = { index: number; duration: number };

// Uploads finish out of order, so a progress manifest can list segment 12
// while 11 is still in flight. A playlist that skipped 11 would play the wrong
// media at that time, then have to insert 11 mid-list, which HLS players
// cannot follow.
export function contiguousSegmentPrefix(
	entries: Video.SegmentManifestType["video_segments"],
): SegmentEntry[] {
	const sorted = entries
		.map(Video.normalizeSegmentEntry)
		.sort((a, b) => a.index - b.index);
	const prefix: SegmentEntry[] = [];
	for (const entry of sorted) {
		if (entry.index !== prefix.length + 1) break;
		prefix.push(entry);
	}
	return prefix;
}

// Audio only proves it exists once it starts uploading, so a manifest without
// any audio yet waits: its recording may still have audio on the way.
export function getEarlySegmentTracks(
	manifest: Video.SegmentManifestType,
): { video: SegmentEntry[]; audio: SegmentEntry[] } | null {
	if (manifest.is_complete || !manifest.video_init_uploaded) return null;
	if (!manifest.audio_init_uploaded) return null;
	const video = contiguousSegmentPrefix(manifest.video_segments);
	const audio = contiguousSegmentPrefix(manifest.audio_segments);
	if (video.length === 0 || audio.length === 0) return null;
	return { video, audio };
}

export function totalSegmentDuration(
	entries: readonly { duration: number }[],
): number {
	return entries.reduce((total, entry) => total + entry.duration, 0);
}

const MAX_RECORDED_LENGTH_SECONDS = 24 * 60 * 60;

export function readRecordedLength(
	content: string,
	readyDuration: number,
): number | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const { version, duration, video_segments } = parsed as Record<
		string,
		unknown
	>;
	if (
		version !== 1 ||
		typeof duration !== "number" ||
		!Number.isFinite(duration) ||
		duration <= 0 ||
		duration > MAX_RECORDED_LENGTH_SECONDS ||
		typeof video_segments !== "number" ||
		!Number.isInteger(video_segments) ||
		video_segments < 1 ||
		duration + 0.5 < readyDuration
	) {
		return null;
	}
	return duration;
}
