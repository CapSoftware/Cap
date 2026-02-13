import type {
	AudioConfiguration,
	TimelineSegment,
} from "../types/project-config";

const MIN_DB = -30;

function dbToGain(db: number): number {
	if (!Number.isFinite(db) || db <= MIN_DB) return 0;
	return 10 ** (db / 20);
}

export function getAudioPlaybackGain(audio: AudioConfiguration): number {
	if (audio.mute) return 0;
	return dbToGain(audio.volumeDb);
}

export function getSegmentAudioGain(
	audio: AudioConfiguration,
	segment: TimelineSegment,
): number {
	if (segment.muted) return 0;
	return getAudioPlaybackGain(audio);
}
