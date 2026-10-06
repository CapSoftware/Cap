import type { TimelineSegment } from "~/utils/tauri";

export function clipVolume(segment: Pick<TimelineSegment, "volume">): number {
	const volume = segment.volume ?? 1;
	return Number.isFinite(volume) ? Math.min(2, Math.max(0, volume)) : 1;
}

export function clipAudioMuted(
	segment: Pick<TimelineSegment, "timescale" | "speedAudioMode" | "audioMuted">,
): boolean {
	if (segment.audioMuted) return true;
	return segment.timescale === 1
		? segment.speedAudioMode === "mute"
		: (segment.speedAudioMode ?? "mute") === "mute";
}
