/**
 * Playback/thumbnail URL for a media comment's object. /api/storage/object
 * enforces the video's view policy and asserts the key sits under the video's
 * prefix, then 302s to a signed URL (S3) or byte-proxies (Drive).
 */
export const commentMediaUrl = (videoId: string, key: string) =>
	`/api/storage/object?videoId=${encodeURIComponent(videoId)}&key=${encodeURIComponent(key)}`;

// Extensions derive from an allowlisted content type, never from a client
// filename (the signed-upload route's extension inference maps .webm to
// audio/webm, which would mislabel webm video — comment media bypasses it).
const AUDIO_EXTENSIONS: Record<string, string> = {
	"audio/webm": "webm",
	"audio/mp4": "m4a",
	"audio/mpeg": "mp3",
	"audio/aac": "aac",
	"audio/ogg": "ogg",
};
const VIDEO_EXTENSIONS: Record<string, string> = {
	"video/mp4": "mp4",
	"video/webm": "webm",
};

/** `audio/webm;codecs=opus` (MediaRecorder style) -> `audio/webm`. */
export const baseContentType = (contentType: string) =>
	contentType.split(";")[0]?.trim().toLowerCase() ?? "";

export const commentMediaExtension = (
	kind: "video" | "audio",
	contentType: string,
) =>
	(kind === "audio" ? AUDIO_EXTENSIONS : VIDEO_EXTENSIONS)[contentType] ?? null;

/**
 * Object keys for a media comment, always under the parent video's prefix so
 * serving, lifecycle, and deletion inherit from the video. Returns null for
 * content types outside the allowlist.
 */
export const commentMediaKeys = (input: {
	ownerId: string;
	videoId: string;
	commentId: string;
	kind: "video" | "audio";
	contentType: string;
	withThumbnail?: boolean;
}) => {
	const contentType = baseContentType(input.contentType);
	const ext = commentMediaExtension(input.kind, contentType);
	if (!ext) return null;
	const prefix = `${input.ownerId}/${input.videoId}/comments/${input.commentId}`;
	return {
		contentType,
		key: `${prefix}/media.${ext}`,
		thumbnailKey:
			input.kind === "video" && input.withThumbnail
				? `${prefix}/thumbnail.jpg`
				: null,
	};
};

export const MAX_WAVEFORM_PEAKS = 256;

/** Clamp a client-supplied waveform so it can't bloat the JSON column. */
export const sanitizeWaveform = (waveform: number[] | undefined) => {
	if (!waveform?.length) return undefined;
	return waveform
		.slice(0, MAX_WAVEFORM_PEAKS)
		.map((peak) =>
			Number.isFinite(peak) ? Math.min(1, Math.max(0, peak)) : 0,
		);
};
