// The init segment and each media segment (one keyframe interval, 2 s or
// longer) of a Save rendering in the owner's browser, uploaded as they're made
// so viewers can start watching.
export const BROWSER_SAVE_CHUNK_FILE = /^(init\.mp4|segment-\d{1,5}\.m4s)$/;

// Enough to cover the first seconds of playback before it starts.
const PLAYABLE_BROWSER_SAVE_SECONDS = 4;

/// Whether the chunks uploaded so far cover the start of playback: 4 s of
/// video, or two chunks however short. Chunk durations come from frame
/// timestamps, so two 2 s chunks can add up to a hair under 4 s.
export function browserSavePlayable(durations: readonly number[]) {
	const seconds = durations.reduce((total, duration) => total + duration, 0);
	return durations.length >= 2 || seconds >= PLAYABLE_BROWSER_SAVE_SECONDS;
}

export function browserSaveChunkPrefix(ownerId: string, videoId: string) {
	return `${ownerId}/${videoId}/.recording/browser-save/`;
}

export function browserSaveChunkKey(
	ownerId: string,
	videoId: string,
	saveId: string,
	file: string,
) {
	return `${browserSaveChunkPrefix(ownerId, videoId)}${saveId}/${file}`;
}

const browserSaveUrl = (videoId: string) =>
	`/api/videos/${encodeURIComponent(videoId)}/browser-save`;

export function browserSavePlaylistUrl(videoId: string) {
	return `${browserSaveUrl(videoId)}/playlist`;
}

/// What the share page loads: a multivariant playlist naming the Save's one
/// media playlist. hls.js handles a media playlist loaded as the top-level URL
/// twice when it arrives, so its first reload comes two segments later and
/// playback of 5 s chunks stalled at 5 s waiting for it; as a variant, the
/// media playlist reloads one segment after it arrives.
export function browserSaveMultivariantPlaylist(videoId: string) {
	return [
		"#EXTM3U",
		"#EXT-X-VERSION:7",
		"#EXT-X-STREAM-INF:BANDWIDTH=8000000",
		`${browserSavePlaylistUrl(videoId)}?media`,
		"",
	].join("\n");
}

export function browserSavePlaylist(
	videoId: string,
	saveId: string,
	durations: number[],
	ended: boolean,
) {
	const chunkUrl = (file: string) =>
		`${browserSaveUrl(videoId)}/${saveId}/${file}`;
	const target = Math.max(4, Math.ceil(Math.max(0, ...durations)));
	return [
		"#EXTM3U",
		"#EXT-X-VERSION:7",
		`#EXT-X-TARGETDURATION:${target}`,
		"#EXT-X-PLAYLIST-TYPE:EVENT",
		`#EXT-X-MAP:URI="${chunkUrl("init.mp4")}"`,
		...durations.flatMap((duration, index) => [
			`#EXTINF:${duration.toFixed(3)},`,
			chunkUrl(`segment-${index + 1}.m4s`),
		]),
		...(ended ? ["#EXT-X-ENDLIST"] : []),
		"",
	].join("\n");
}
