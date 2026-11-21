import { SHARE_LADDER_OUTPUT_FILES } from "@cap/web-backend/src/S3Buckets/cloudfront-invalidation";

export const SHARE_LADDER_MAX_TIER = "1080p";
export const SHARE_LADDER_MASTER = "master.m3u8";
export const SHARE_LADDER_MIN_DURATION_SECONDS = 60;
export const SHARE_LADDER_TRIGGER_VIEWS = 2;

const HIGH_BITRATE = 6_000_000;
const ABOVE_1080P_BITRATE = 4_000_000;

export type ShareLadderSourceFacts = {
	bytes: number;
	durationSeconds: number | null;
	width: number | null;
	height: number | null;
};

export function shareLadderBitsPerSecond(
	facts: ShareLadderSourceFacts,
): number | null {
	if (!facts.durationSeconds || facts.durationSeconds <= 0) return null;
	if (!(facts.bytes > 0)) return null;
	return (facts.bytes * 8) / facts.durationSeconds;
}

export function isShareLadderEligible(facts: ShareLadderSourceFacts): boolean {
	if (
		!facts.durationSeconds ||
		facts.durationSeconds < SHARE_LADDER_MIN_DURATION_SECONDS
	) {
		return false;
	}
	const bitsPerSecond = shareLadderBitsPerSecond(facts);
	if (bitsPerSecond === null) return false;
	if (bitsPerSecond >= HIGH_BITRATE) return true;
	const shortSide =
		facts.width && facts.height ? Math.min(facts.width, facts.height) : 0;
	return shortSide > 1080 && bitsPerSecond >= ABOVE_1080P_BITRATE;
}

export function shareLadderOutputPrefix(
	ownerId: string,
	videoId: string,
	token: string,
): string {
	return `${ownerId}/${videoId}/.recording/outputs/ladder-${token}/`;
}

export function isShareLadderOutputKey(
	key: string,
	ownerId: string,
	videoId: string,
): boolean {
	return key.startsWith(`${ownerId}/${videoId}/.recording/outputs/ladder-`);
}

export type ShareLadderUpload = { name: string; contentType: string };

export function shareLadderUploads(): ShareLadderUpload[] {
	return SHARE_LADDER_OUTPUT_FILES.map((name) => ({
		name,
		contentType: name.endsWith(".m4s")
			? "video/mp4"
			: "application/vnd.apple.mpegurl",
	}));
}

const PLAYLIST_FILE = /^(master|audio|[0-9]{3,4}p)\.m3u8$/;
const MEDIA_FILE = /^(audio|[0-9]{3,4}p)\.m4s$/;

export function isShareLadderPlaylistFile(file: string): boolean {
	return PLAYLIST_FILE.test(file);
}

export function rewriteShareLadderMaster(
	master: string,
	playlistUrl: (file: string) => string,
): string {
	return master
		.split("\n")
		.map((line) => {
			const trimmed = line.trim();
			if (trimmed.startsWith("#EXT-X-MEDIA")) {
				return line.replace(/URI="([^"]+)"/, (match, uri: string) =>
					PLAYLIST_FILE.test(uri) ? `URI="${playlistUrl(uri)}"` : match,
				);
			}
			if (trimmed.length > 0 && !trimmed.startsWith("#")) {
				if (!PLAYLIST_FILE.test(trimmed)) {
					throw new Error(`Unexpected entry in ladder master: ${trimmed}`);
				}
				return playlistUrl(trimmed);
			}
			return line;
		})
		.join("\n");
}

export function rewriteShareLadderRendition(
	playlist: string,
	mediaUrl: (file: string) => string,
): string {
	const urls = new Map<string, string>();
	const resolve = (file: string) => {
		if (!MEDIA_FILE.test(file)) {
			throw new Error(`Unexpected media in ladder playlist: ${file}`);
		}
		let url = urls.get(file);
		if (!url) {
			url = mediaUrl(file);
			urls.set(file, url);
		}
		return url;
	};
	return playlist
		.split("\n")
		.map((line) => {
			const trimmed = line.trim();
			if (trimmed.startsWith("#EXT-X-MAP")) {
				return line.replace(
					/URI="([^"]+)"/,
					(_match, uri: string) => `URI="${resolve(uri)}"`,
				);
			}
			if (trimmed.length > 0 && !trimmed.startsWith("#")) {
				return resolve(trimmed);
			}
			return line;
		})
		.join("\n");
}

export function shareLadderMediaFiles(playlist: string): string[] {
	const files = new Set<string>();
	for (const line of playlist.split("\n")) {
		const trimmed = line.trim();
		const map = trimmed.startsWith("#EXT-X-MAP")
			? /URI="([^"]+)"/.exec(trimmed)?.[1]
			: undefined;
		if (map) files.add(map);
		else if (trimmed.length > 0 && !trimmed.startsWith("#")) files.add(trimmed);
	}
	return [...files];
}
