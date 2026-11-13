import { db } from "@cap/database";
import { developerApps, developerVideos } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { developerVideoOutputs } from "./developer-video-api";
import {
	CAPTIONS_CONTENT_TYPE,
	captionsFileLanguage,
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

	const playlist = await readDeveloperVideoText(`${keys.hlsPrefix}${file}`);
	if (!playlist) return notFound();
	const short = wantsShortSegments(request);
	if (file === DEVELOPER_VIDEO_MASTER_PLAYLIST) {
		const master = leadWithStartRendition(playlist);
		return playlistResponse(short ? listShortSegmentPlaylists(master) : master);
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
