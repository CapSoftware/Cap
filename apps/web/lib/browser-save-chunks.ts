// The init segment and each ~2 s media segment of a Save rendering in the
// owner's browser, uploaded as they're made so viewers can start watching.
export const BROWSER_SAVE_CHUNK_FILE = /^(init\.mp4|segment-\d{1,5}\.m4s)$/;

// Enough to cover the first seconds of playback before it starts.
export const PLAYABLE_BROWSER_SAVE_CHUNKS = 2;

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

/** An HLS event playlist of the chunks uploaded so far, closed once the Save ends. */
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
