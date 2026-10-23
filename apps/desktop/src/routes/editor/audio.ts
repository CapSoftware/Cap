export type AudioTrackSegment = {
	start: number;
	end: number;
	track: number;
	path: string;
	name: string | null;
	enabled: boolean;
	trimStart: number;
	volumeDb: number;
	fadeIn: number;
	fadeOut: number;
	duration: number | null;
};

export const AUDIO_IMPORT_EXTENSIONS = [
	"mp3",
	"wav",
	"m4a",
	"ogg",
	"flac",
	"aac",
] as const;

export const MIN_AUDIO_SEGMENT_DURATION = 0.5;
export const MIN_VOLUME_DB = -30;
export const MAX_VOLUME_DB = 12;

export const AUDIO_TRACK_BG_CLASS = "bg-[var(--track-audio)]";

export const createAudioTrackSegment = (params: {
	start: number;
	end: number;
	track: number;
	path: string;
	name: string | null;
	duration: number | null;
}): AudioTrackSegment => ({
	start: params.start,
	end: params.end,
	track: params.track,
	path: params.path,
	name: params.name,
	enabled: true,
	trimStart: 0,
	volumeDb: 0,
	fadeIn: 0,
	fadeOut: 0,
	duration: params.duration,
});
