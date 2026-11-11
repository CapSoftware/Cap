import { db } from "@cap/database";
import { developerApps, developerVideos } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { developerVideoOutputs } from "./developer-video-api";
import {
	DEVELOPER_VIDEO_MASTER_PLAYLIST,
	DEVELOPER_VIDEO_MP4_FILE,
	DEVELOPER_VIDEO_POSTER_FILE,
	developerVideoKeys,
	HLS_PLAYLIST_CONTENT_TYPE,
} from "./developer-video-plan";
import {
	readDeveloperVideoText,
	signedDeveloperVideoUrl,
} from "./developer-video-storage";

const PLAYBACK_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const HLS_FILE_PATTERN = /^[A-Za-z0-9_-]+\.(m3u8|m4s)$/;
const MEDIA_FILE_PATTERN = /^[A-Za-z0-9_-]+\.m4s$/;

const SIGNED_URL_SECONDS = 12 * 60 * 60;
const CACHE_SECONDS = 300;

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

async function redirectTo(key: string): Promise<Response> {
	return new Response(null, {
		status: 302,
		headers: {
			...PLAYBACK_CORS_HEADERS,
			...CACHEABLE,
			Location: await signedDeveloperVideoUrl(key, SIGNED_URL_SECONDS),
		},
	});
}

export async function signMediaPlaylist(
	playlist: string,
	sign: (name: string) => Promise<string>,
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

	const lines: string[] = [];
	for (const raw of playlist.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith("#EXT-X-MAP:")) {
			const uri = line.match(/URI="([^"]*)"/);
			if (!uri?.[1]) throw new Error("Playlist has no init segment");
			const url = await resolve(uri[1]);
			lines.push(line.replace(uri[0], () => `URI="${url}"`));
		} else if (line.length > 0 && !line.startsWith("#")) {
			lines.push(await resolve(line));
		} else {
			lines.push(line);
		}
	}
	return lines.join("\n");
}

async function findPlayableVideo(playbackId: string) {
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
): Promise<Response> {
	if (!PLAYBACK_ID_PATTERN.test(playbackId)) return notFound();

	const video = await findPlayableVideo(playbackId);
	if (!video?.processing) return notFound();

	const outputs = developerVideoOutputs(video);
	const keys = developerVideoKeys(video, video.processing.encodeId);

	if (file === DEVELOPER_VIDEO_MP4_FILE) {
		return outputs.mp4 ? redirectTo(keys.mp4) : notFound();
	}
	if (file === DEVELOPER_VIDEO_POSTER_FILE) {
		return outputs.poster ? redirectTo(keys.poster) : notFound();
	}
	if (!outputs.hls || !HLS_FILE_PATTERN.test(file)) return notFound();
	if (MEDIA_FILE_PATTERN.test(file)) {
		return redirectTo(`${keys.hlsPrefix}${file}`);
	}

	const playlist = await readDeveloperVideoText(`${keys.hlsPrefix}${file}`);
	if (!playlist) return notFound();
	const body =
		file === DEVELOPER_VIDEO_MASTER_PLAYLIST
			? playlist
			: await signMediaPlaylist(playlist, (name) =>
					signedDeveloperVideoUrl(
						`${keys.hlsPrefix}${name}`,
						SIGNED_URL_SECONDS,
					),
				);
	return new Response(body, {
		headers: {
			...PLAYBACK_CORS_HEADERS,
			...CACHEABLE,
			"Content-Type": HLS_PLAYLIST_CONTENT_TYPE,
		},
	});
}
