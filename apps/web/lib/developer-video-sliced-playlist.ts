// The slice planner and the playlist joiner below mirror planHlsLadderSlices
// and stitchHlsLadderSlices in apps/media-server/src/lib/hls-ladder.ts. The
// media server image is built from its own folder and cannot import a shared
// package, so the code is kept here as a copy and a test compares the two.

export const HLS_SEGMENT_SECONDS = 4;
export const HLS_AUDIO_BITRATE = 128_000;
export const HLS_AUDIO_NAME = "audio";

const AUDIO_GROUP = "aud";
const AUDIO_CODEC = "mp4a.40.2";

export interface HlsSliceRange {
	startSeconds: number;
	durationSeconds?: number;
}

export function planHlsLadderSlices(
	durationSeconds: number,
	workers: number,
	minSliceSeconds = 20,
): HlsSliceRange[] {
	if (!(durationSeconds > 0)) return [{ startSeconds: 0 }];
	const count = Math.max(
		1,
		Math.min(
			Math.floor(workers),
			Math.floor(durationSeconds / minSliceSeconds),
		),
	);
	const sliceSeconds =
		Math.ceil(durationSeconds / count / HLS_SEGMENT_SECONDS) *
		HLS_SEGMENT_SECONDS;
	const slices: HlsSliceRange[] = [];
	for (let index = 0; index < count; index++) {
		const startSeconds = index * sliceSeconds;
		if (startSeconds >= durationSeconds) break;
		slices.push(
			index === count - 1
				? { startSeconds }
				: { startSeconds, durationSeconds: sliceSeconds },
		);
	}
	const last = slices.at(-1);
	if (last) delete last.durationSeconds;
	return slices;
}

export interface HlsPlaylistSegment {
	seconds: number;
	lines: string[];
}

export interface HlsSlicePlaylist {
	map: string;
	targetDuration: number;
	seconds: number;
	segments: HlsPlaylistSegment[];
}

// Reads one slice's playlist for a rendition: a single media file addressed by
// byte range. Anything else in it means the slice is not what was asked for.
export function readHlsSlicePlaylist(
	playlist: string,
	source: string,
	name: string,
): HlsSlicePlaylist {
	let map: string | null = null;
	let targetDuration = 0;
	let seconds = 0;
	const segments: HlsPlaylistSegment[] = [];
	let open: HlsPlaylistSegment | null = null;
	for (const raw of playlist.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith("#EXT-X-TARGETDURATION:")) {
			targetDuration = Number(line.slice(line.indexOf(":") + 1));
		} else if (line.startsWith("#EXT-X-MAP:")) {
			if (!line.includes(`URI="${source}"`)) {
				throw new Error("HLS ladder slice has an unexpected init segment");
			}
			map = line.replace(`URI="${source}"`, `URI="${name}"`);
		} else if (line.startsWith("#EXTINF:")) {
			const duration = Number(line.slice("#EXTINF:".length).split(",")[0]);
			if (!(duration > 0)) {
				throw new Error("HLS ladder slice has a segment with no length");
			}
			open = { seconds: duration, lines: [line] };
		} else if (line.startsWith("#EXT-X-BYTERANGE:")) {
			open?.lines.push(line);
		} else if (line === source) {
			if (!open)
				throw new Error("HLS ladder slice has a segment with no length");
			open.lines.push(name);
			segments.push(open);
			seconds += open.seconds;
			open = null;
		} else if (line.length > 0 && !line.startsWith("#")) {
			throw new Error("HLS ladder slice references an unexpected file");
		}
	}
	if (!map) throw new Error("HLS ladder slice has no init segment");
	if (segments.length === 0)
		throw new Error("HLS ladder slice has no segments");
	return { map, targetDuration, seconds, segments };
}

// Slices are joined by playlist only: the playlist lists every slice's file in
// order, each behind its own init segment, so no media is copied after
// encoding. It is an event playlist from the first slice on: lines are only
// ever added, and the end marker goes on once every slice is in. A player
// that reaches the last line before then waits for more. Without a start
// offset players join an unfinished playlist near its end, as for a live
// stream.
export function joinHlsSlicePlaylists(
	slices: HlsSlicePlaylist[],
	options: { ended: boolean; untilSeconds?: number },
): string {
	const [first] = slices;
	if (!first) throw new Error("HLS ladder has no slices");
	const body: string[] = [];
	let targetDuration = 0;
	let position = 0;
	for (const slice of slices) {
		const lines: string[] = [];
		for (const segment of slice.segments) {
			if (
				options.untilSeconds !== undefined &&
				position >= options.untilSeconds
			) {
				break;
			}
			lines.push(...segment.lines);
			position += segment.seconds;
		}
		if (lines.length > 0) body.push(slice.map, ...lines);
		targetDuration = Math.max(targetDuration, slice.targetDuration);
	}
	return `${[
		"#EXTM3U",
		"#EXT-X-VERSION:7",
		`#EXT-X-TARGETDURATION:${targetDuration}`,
		"#EXT-X-MEDIA-SEQUENCE:0",
		"#EXT-X-PLAYLIST-TYPE:EVENT",
		"#EXT-X-INDEPENDENT-SEGMENTS",
		"#EXT-X-START:TIME-OFFSET=0",
		...body,
		...(options.ended ? ["#EXT-X-ENDLIST"] : []),
	].join("\n")}\n`;
}

export interface HlsMasterVariant {
	name: string;
	width: number;
	height: number;
	bandwidth: number;
	averageBandwidth: number;
	codecs: string | null;
}

export function hlsVariantCodecs(
	codecs: string | null,
	hasAudio: boolean,
): string | null {
	const list = [codecs, hasAudio ? AUDIO_CODEC : null].filter(
		(codec): codec is string => Boolean(codec),
	);
	return list.length > 0 ? list.join(",") : null;
}

export function buildSlicedHlsMaster(
	variants: HlsMasterVariant[],
	options: { hasAudio: boolean },
): string {
	if (variants.length === 0) throw new Error("HLS ladder has no renditions");
	const audioBandwidth = options.hasAudio ? HLS_AUDIO_BITRATE : 0;
	const master = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
	if (options.hasAudio) {
		master.push(
			`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${AUDIO_GROUP}",NAME="${HLS_AUDIO_NAME}",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="${HLS_AUDIO_NAME}.m3u8"`,
		);
	}
	for (const variant of variants) {
		const codecs = hlsVariantCodecs(variant.codecs, options.hasAudio);
		const attributes = [
			`BANDWIDTH=${Math.round(variant.bandwidth) + audioBandwidth}`,
			`AVERAGE-BANDWIDTH=${Math.round(variant.averageBandwidth) + audioBandwidth}`,
			`RESOLUTION=${variant.width}x${variant.height}`,
			...(codecs ? [`CODECS="${codecs}"`] : []),
			...(options.hasAudio ? [`AUDIO="${AUDIO_GROUP}"`] : []),
		];
		master.push(
			`#EXT-X-STREAM-INF:${attributes.join(",")}`,
			`${variant.name}.m3u8`,
		);
	}
	return `${master.join("\n")}\n`;
}
