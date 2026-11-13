import { db } from "@cap/database";
import { developerApps, developerVideos } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { developerVideoOutputs } from "./developer-video-api";
import {
	CAPTIONS_CONTENT_TYPE,
	CAPTIONS_UNKNOWN_LANGUAGE,
	captionsFileLanguage,
	captionsFileName,
	captionsPlaylistLanguage,
	captionsPlaylistName,
	developerVideoCaptions,
	videoCaptionsKey,
} from "./developer-video-captions";
import {
	DEVELOPER_VIDEO_MASTER_PLAYLIST,
	DEVELOPER_VIDEO_MP4_FILE,
	DEVELOPER_VIDEO_POSTER_FILE,
	developerVideoKeys,
	HLS_PLAYLIST_CONTENT_TYPE,
} from "./developer-video-plan";
import {
	developerVideoUrlAnswersAnyOrigin,
	readDeveloperVideoText,
	signedDeveloperVideoUrl,
} from "./developer-video-storage";
import {
	DEVELOPER_VIDEO_UNAVAILABLE,
	developerVideoIsTakenDown,
} from "./developer-video-takedown";
import { getInfraAppStanding } from "./infra-standing";

export const PLAYBACK_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const HLS_FILE_PATTERN = /^[A-Za-z0-9_-]+\.(m3u8|m4s)$/;
const MEDIA_FILE_PATTERN = /^[A-Za-z0-9_-]+\.m4s$/;

const SIGNED_URL_MIN_SECONDS = 12 * 60 * 60;
const SIGNED_URL_WINDOW_SECONDS = 6 * 60 * 60;
// How long an answer may be served from a shared cache. It bounds how long a
// deleted video keeps answering new viewers, and how long a paused app waits
// for playback after a top-up.
const CACHE_SECONDS = 60;

const START_MAX_BANDWIDTH = 2_600_000;
const START_MAX_SHORT_SIDE = 1080;

export const PLAYBACK_CORS_HEADERS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
	"Access-Control-Allow-Headers": "Range",
	"Access-Control-Expose-Headers": "Content-Length, Content-Range",
	"Access-Control-Max-Age": "86400",
};

const CACHEABLE = {
	"Cache-Control": `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}`,
};

function notFound(): Response {
	return new Response("Not found", {
		status: 404,
		headers: { ...PLAYBACK_CORS_HEADERS, "Cache-Control": "no-store" },
	});
}

// Never cached, so restoring a video brings it back on the next request.
function gone(): Response {
	return new Response(DEVELOPER_VIDEO_UNAVAILABLE, {
		status: 410,
		headers: {
			...PLAYBACK_CORS_HEADERS,
			"Cache-Control": "no-store",
			"Content-Type": "text/plain; charset=utf-8",
		},
	});
}

function paused(): Response {
	return new Response(
		"Playback is paused because the account that hosts this video is out of credit.",
		{
			status: 402,
			headers: {
				...PLAYBACK_CORS_HEADERS,
				...CACHEABLE,
				"Content-Type": "text/plain; charset=utf-8",
			},
		},
	);
}

// A browser caches media under its signed URL, and a URL signed from the
// current time is new on every request, so a repeat view downloaded the video
// again. Signing from the start of a fixed window gives every request in that
// window the same URL, and the URL still works for SIGNED_URL_MIN_SECONDS
// after the window ends.
export function signedUrlValidity(now: number = Date.now()): {
	signingDate: Date;
	expiresIn: number;
} {
	const windowMs = SIGNED_URL_WINDOW_SECONDS * 1000;
	return {
		signingDate: new Date(Math.floor(now / windowMs) * windowMs),
		expiresIn: SIGNED_URL_WINDOW_SECONDS + SIGNED_URL_MIN_SECONDS,
	};
}

async function redirectTo(key: string, request: Request): Promise<Response> {
	return new Response(null, {
		status: 302,
		headers: {
			...PLAYBACK_CORS_HEADERS,
			...CACHEABLE,
			Location: await signedDeveloperVideoUrl(
				key,
				signedUrlValidity(),
				request,
			),
		},
	});
}

const SHORT_SEGMENTS_QUERY = "segments=short";
const PLAYLIST_FILE_PATTERN = /^[A-Za-z0-9_-]+\.m3u8$/;

// A rendition is one file read by byte range, so a playlist that signs every
// segment repeats one long signed URL per segment: about 250 KB for a 21 minute
// video, fetched for video and for audio before playback starts. The short
// form signs only the init section and first segment of a playlist longer than
// this, which is all a player needs for the first frame, and lists the later
// segments by file name. A player resolves those to this route and follows its
// redirect to the same signed URL.
//
// It is only served on request. In players built on hls.js it left the first
// frame and seeking as they were when measured. Apple's own players ask this
// route again for every segment, which made each seek slower.
const FULLY_SIGNED_SEGMENTS = 15;

export function wantsShortSegments(request: Request): boolean {
	const values = new URL(request.url).searchParams.getAll("segments");
	return values.length === 1 && values[0] === "short";
}

export function listShortSegmentPlaylists(master: string): string {
	return master
		.split(/\r?\n/)
		.map((raw) => {
			const line = raw.trim();
			if (line.startsWith("#")) {
				return line.replace(
					/URI="([A-Za-z0-9_-]+\.m3u8)"/,
					(_, name: string) => `URI="${name}?${SHORT_SEGMENTS_QUERY}"`,
				);
			}
			return PLAYLIST_FILE_PATTERN.test(line)
				? `${line}?${SHORT_SEGMENTS_QUERY}`
				: raw;
		})
		.join("\n");
}

export async function signMediaPlaylist(
	playlist: string,
	sign: (name: string) => Promise<string>,
	listedByName: (signedUrl: string) => boolean = () => false,
): Promise<string> {
	const signed = new Map<string, string>();
	const resolve = async (name: string) => {
		if (!MEDIA_FILE_PATTERN.test(name)) {
			throw new Error("Playlist references an unexpected file");
		}
		const existing = signed.get(name);
		if (existing) return existing;
		const url = await sign(name);
		signed.set(name, url);
		return url;
	};

	const source = playlist.split(/\r?\n/).map((line) => line.trim());
	const segments = source.filter(
		(line) => line.length > 0 && !line.startsWith("#"),
	).length;
	const long = segments > FULLY_SIGNED_SEGMENTS;
	let segment = 0;

	const lines: string[] = [];
	for (const line of source) {
		if (line.startsWith("#EXT-X-MAP:")) {
			const uri = line.match(/URI="([^"]*)"/);
			if (!uri?.[1]) throw new Error("Playlist has no init segment");
			const url = await resolve(uri[1]);
			lines.push(line.replace(uri[0], () => `URI="${url}"`));
		} else if (line.length > 0 && !line.startsWith("#")) {
			const url = await resolve(line);
			lines.push(long && segment > 0 && listedByName(url) ? line : url);
			segment++;
		} else {
			lines.push(line);
		}
	}
	return lines.join("\n");
}

const RENDITION_NAME_PATTERN = /^(\d{3,4})p$/;
const RENDITION_HEIGHT_PATTERN = /^\d{3,4}$/;

function onlyQueryValue(request: Request, name: string): string | null {
	const values = new URL(request.url).searchParams.getAll(name);
	return values.length === 1 ? (values[0] ?? null) : null;
}

export function renditionChoice(request: Request): {
	rendition: string | null;
	max: number | null;
} {
	const rendition = onlyQueryValue(request, "rendition");
	const max = onlyQueryValue(request, "max");
	return {
		rendition:
			rendition && RENDITION_NAME_PATTERN.test(rendition) ? rendition : null,
		max: max && RENDITION_HEIGHT_PATTERN.test(max) ? Number(max) : null,
	};
}

// A master playlist narrowed to some of its renditions. Safari's own HLS
// player offers no way to pick a rendition, so the hosted player picks one by
// loading a master that lists only it; the audio rendition stays listed, which
// a rendition's own playlist would leave out. A cap keeps every rendition no
// taller than it, or the shortest when none is, and a pick is made only among
// those. Height comes from the rendition's name, never from its bandwidth: the
// ladder is constant quality, so a taller rendition can need less. A choice
// that matches nothing leaves the master as it is.
export function selectRenditions(
	master: string,
	choice: { rendition: string | null; max: number | null },
): string {
	if (choice.rendition === null && choice.max === null) return master;
	const lines = master.split(/\r?\n/).filter((line) => line.trim().length > 0);
	const others: string[] = [];
	const variants: { height: number; uri: string; lines: string[] }[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (!line.startsWith("#EXT-X-STREAM-INF:")) {
			others.push(line);
			continue;
		}
		const uri = lines[index + 1]?.trim();
		if (!uri || uri.startsWith("#")) return master;
		const named = /^(\d{3,4})p\.m3u8$/.exec(uri);
		const resolution = line.match(/[:,]RESOLUTION=(\d+)x(\d+)/);
		const height = named
			? Number(named[1])
			: resolution
				? Math.min(Number(resolution[1]), Number(resolution[2]))
				: 0;
		variants.push({ height, uri, lines: [line, uri] });
		index++;
	}
	if (variants.length === 0) return master;

	let kept = variants;
	if (choice.max !== null) {
		const max = choice.max;
		const below = variants.filter((variant) => variant.height <= max);
		kept =
			below.length > 0
				? below
				: [
						variants.reduce((low, variant) =>
							variant.height < low.height ? variant : low,
						),
					];
	}
	if (choice.rendition !== null) {
		const named = kept.filter(
			(variant) => variant.uri === `${choice.rendition}.m3u8`,
		);
		if (named.length > 0) kept = named;
	}
	if (kept.length === variants.length) return master;
	return `${[...others, ...kept.flatMap((variant) => variant.lines)].join("\n")}\n`;
}

// Players start on the first rendition a master playlist lists, and the encoder
// lists the largest first. Lead with the best rendition an ordinary connection
// starts quickly and leave the others in their order, so the player steps up or
// down from there. A master that does not read as expected is served as stored.
export function leadWithStartRendition(master: string): string {
	const lines = master.split(/\r?\n/).filter((line) => line.trim().length > 0);
	const others: string[] = [];
	const variants: {
		bandwidth: number;
		shortSide: number;
		lines: string[];
	}[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (!line.startsWith("#EXT-X-STREAM-INF:")) {
			others.push(line);
			continue;
		}
		const uri = lines[index + 1];
		const bandwidth = Number(line.match(/[:,]BANDWIDTH=(\d+)/)?.[1]);
		const resolution = line.match(/[:,]RESOLUTION=(\d+)x(\d+)/);
		if (!uri || uri.startsWith("#") || !Number.isFinite(bandwidth)) {
			return master;
		}
		variants.push({
			bandwidth,
			shortSide: resolution
				? Math.min(Number(resolution[1]), Number(resolution[2]))
				: 0,
			lines: [line, uri],
		});
		index++;
	}
	const [listedFirst] = variants;
	if (!listedFirst) return master;

	const quick = variants.filter(
		(variant) =>
			variant.bandwidth <= START_MAX_BANDWIDTH &&
			variant.shortSide <= START_MAX_SHORT_SIDE,
	);
	const start =
		quick.length > 0
			? quick.reduce((best, variant) =>
					variant.bandwidth > best.bandwidth ? variant : best,
				)
			: variants.reduce((best, variant) =>
					variant.bandwidth < best.bandwidth ? variant : best,
				);
	if (start === listedFirst) return master;

	return `${[
		...others,
		...start.lines,
		...variants
			.filter((variant) => variant !== start)
			.flatMap((variant) => variant.lines),
	].join("\n")}\n`;
}

const SUBTITLES_GROUP = "subs";
const NO_SUBTITLES_QUERY = "none";

// Cap's own player draws the captions it is given and asks for a master
// without them. Listed there too, Safari's own player would offer every
// language twice and could show both at once.
export function wantsSubtitles(request: Request): boolean {
	return onlyQueryValue(request, "subtitles") !== NO_SUBTITLES_QUERY;
}

type SubtitleTrack = { language: string; label: string };

const attributeText = (value: string) => value.replace(/["\r\n]/g, "").trim();

// Lists each captions language as a WebVTT subtitle rendition, so a player
// that reads only the master playlist, hls.js or Safari's own, can offer
// them. A master with no captions, or one that already has subtitles, is
// served as it is.
export function listSubtitles(
	master: string,
	tracks: readonly SubtitleTrack[],
): string {
	if (tracks.length === 0) return master;
	const lines = master.split(/\r?\n/);
	if (
		lines.some(
			(line) =>
				line.startsWith("#EXT-X-MEDIA:") &&
				/[:,]TYPE=SUBTITLES(,|$)/.test(line),
		) ||
		lines.some((line) => /^#EXT-X-STREAM-INF:.*[:,]SUBTITLES=/.test(line))
	) {
		return master;
	}
	const firstVariant = lines.findIndex((line) =>
		line.startsWith("#EXT-X-STREAM-INF:"),
	);
	if (firstVariant === -1) return master;
	const lastMedia = lines.findLastIndex((line) =>
		line.startsWith("#EXT-X-MEDIA:"),
	);
	const at =
		lastMedia >= 0 && lastMedia < firstVariant ? lastMedia + 1 : firstVariant;

	const names = new Set<string>();
	const media = tracks.map(({ language, label }) => {
		let name = attributeText(label) || language;
		if (names.has(name)) name = `${name} (${language})`;
		names.add(name);
		return [
			"#EXT-X-MEDIA:TYPE=SUBTITLES",
			`GROUP-ID="${SUBTITLES_GROUP}"`,
			`NAME="${name}"`,
			...(language === CAPTIONS_UNKNOWN_LANGUAGE
				? []
				: [`LANGUAGE="${language}"`]),
			"DEFAULT=NO",
			"AUTOSELECT=YES",
			"FORCED=NO",
			`URI="${captionsPlaylistName(language)}"`,
		].join(",");
	});
	const listed = lines.map((line) =>
		line.startsWith("#EXT-X-STREAM-INF:")
			? `${line},SUBTITLES="${SUBTITLES_GROUP}"`
			: line,
	);
	listed.splice(at, 0, ...media);
	return listed.join("\n");
}

// The captions file is one segment that covers the whole video.
export function subtitlesPlaylist(
	language: string,
	durationSeconds: number,
): string {
	return [
		"#EXTM3U",
		"#EXT-X-VERSION:3",
		`#EXT-X-TARGETDURATION:${Math.ceil(durationSeconds)}`,
		"#EXT-X-MEDIA-SEQUENCE:0",
		"#EXT-X-PLAYLIST-TYPE:VOD",
		`#EXTINF:${durationSeconds.toFixed(6)},`,
		captionsFileName(language),
		"#EXT-X-ENDLIST",
		"",
	].join("\n");
}

type PlayableVideo = NonNullable<Awaited<ReturnType<typeof findPlayableVideo>>>;

function playbackDuration(video: PlayableVideo): number | null {
	const duration = video.duration ?? video.processing?.probe?.duration ?? null;
	return typeof duration === "number" &&
		Number.isFinite(duration) &&
		duration > 0
		? duration
		: null;
}

// Captions are extra to playback, so a failed lookup serves the master
// without them.
async function subtitleTracks(video: PlayableVideo): Promise<SubtitleTrack[]> {
	if (playbackDuration(video) === null) return [];
	try {
		return await developerVideoCaptions(video);
	} catch (error) {
		console.error("[developer-playback] Failed to list captions", error);
		return [];
	}
}

// Sent as it is. The platform does not compress this content type, and a body
// compressed here reaches the viewer without its Content-Encoding header, so a
// player cannot read it.
function playlistResponse(playlist: string): Response {
	return new Response(playlist, {
		headers: {
			...PLAYBACK_CORS_HEADERS,
			...CACHEABLE,
			"Content-Type": HLS_PLAYLIST_CONTENT_TYPE,
		},
	});
}

// Captions are read here and sent as they are, like the playlists, rather than
// redirected to a signed URL. A <track> loads in same-origin mode unless its
// video sets crossorigin, so it cannot follow a redirect to storage on another
// origin, and setting crossorigin would change how every media file loads.
function captionsResponse(captions: string): Response {
	return new Response(captions, {
		headers: {
			...PLAYBACK_CORS_HEADERS,
			...CACHEABLE,
			"Content-Type": CAPTIONS_CONTENT_TYPE,
		},
	});
}

export async function findPlayableVideo(playbackId: string) {
	const [row] = await db()
		.select({ video: developerVideos })
		.from(developerVideos)
		.innerJoin(
			developerApps,
			and(
				eq(developerVideos.appId, developerApps.id),
				isNull(developerApps.deletedAt),
			),
		)
		.where(
			and(
				eq(developerVideos.playbackId, playbackId),
				isNull(developerVideos.deletedAt),
			),
		)
		.limit(1);
	return row?.video ?? null;
}

export async function developerPlaybackResponse(
	playbackId: string,
	file: string,
	request: Request,
): Promise<Response> {
	if (!PLAYBACK_ID_PATTERN.test(playbackId)) return notFound();

	const video = await findPlayableVideo(playbackId);
	if (video && developerVideoIsTakenDown(video)) return gone();
	if (!video?.processing) return notFound();
	if ((await getInfraAppStanding(video.appId)).state === "paused") {
		return paused();
	}

	const captionsLanguage = captionsFileLanguage(file);
	if (captionsLanguage) {
		const captions = await readDeveloperVideoText(
			videoCaptionsKey(video, captionsLanguage),
		);
		return captions === null ? notFound() : captionsResponse(captions);
	}

	const subtitlesLanguage = captionsPlaylistLanguage(file);
	if (subtitlesLanguage) {
		const duration = playbackDuration(video);
		const tracks = await subtitleTracks(video);
		return duration !== null &&
			tracks.some((track) => track.language === subtitlesLanguage)
			? playlistResponse(subtitlesPlaylist(subtitlesLanguage, duration))
			: notFound();
	}

	const { processing } = video;
	const outputs = developerVideoOutputs(video);
	const keysFor = (output: string) =>
		developerVideoKeys(video, processing.encodeId, output);

	if (file === DEVELOPER_VIDEO_MP4_FILE) {
		return outputs.mp4 && processing.mp4.state === "complete"
			? redirectTo(keysFor(processing.mp4.output).mp4, request)
			: notFound();
	}
	if (file === DEVELOPER_VIDEO_POSTER_FILE) {
		return outputs.poster && processing.poster
			? redirectTo(keysFor(processing.poster.output).poster, request)
			: notFound();
	}
	if (
		!outputs.hls ||
		processing.hls.state !== "complete" ||
		!HLS_FILE_PATTERN.test(file)
	) {
		return notFound();
	}
	const keys = keysFor(processing.hls.output);
	if (MEDIA_FILE_PATTERN.test(file)) {
		return redirectTo(`${keys.hlsPrefix}${file}`, request);
	}

	const isMaster = file === DEVELOPER_VIDEO_MASTER_PLAYLIST;
	const [playlist, subtitles] = await Promise.all([
		readDeveloperVideoText(`${keys.hlsPrefix}${file}`),
		isMaster && wantsSubtitles(request) ? subtitleTracks(video) : [],
	]);
	if (!playlist) return notFound();
	const short = wantsShortSegments(request);
	if (isMaster) {
		const master = leadWithStartRendition(
			selectRenditions(playlist, renditionChoice(request)),
		);
		return playlistResponse(
			listSubtitles(
				short ? listShortSegmentPlaylists(master) : master,
				subtitles,
			),
		);
	}
	return playlistResponse(
		await signMediaPlaylist(
			playlist,
			(name) =>
				signedDeveloperVideoUrl(
					`${keys.hlsPrefix}${name}`,
					signedUrlValidity(),
					request,
				),
			short ? developerVideoUrlAnswersAnyOrigin : undefined,
		),
	);
}
