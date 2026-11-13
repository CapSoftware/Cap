import type {
	DeveloperVideoRendition,
	DeveloperVideoResolutionTier,
} from "@cap/database/types";
import { z } from "zod";
import { randomDeveloperId } from "./developer-ids";

export const DEVELOPER_VIDEO_DEFAULT_TIER: DeveloperVideoResolutionTier =
	"1080p";

export const DEVELOPER_VIDEO_TIER_PIXELS: Record<
	DeveloperVideoResolutionTier,
	number
> = {
	"1080p": 2_073_600,
	"1440p": 4_194_304,
	"2160p": 8_294_400,
};

export const DEVELOPER_VIDEO_TIER_PIXEL_TOLERANCE = 1.02;

const LADDER_TIERS = [
	{ name: "2160p", shortSide: 2160 },
	{ name: "1440p", shortSide: 1440 },
	{ name: "1080p", shortSide: 1080 },
	{ name: "720p", shortSide: 720 },
	{ name: "360p", shortSide: 360 },
] as const;

export type DeveloperVideoLadderTier = (typeof LADDER_TIERS)[number]["name"];

const MAX_ENCODE_DIMENSION = 4096;

export const DEVELOPER_VIDEO_MASTER_PLAYLIST = "master.m3u8";
export const DEVELOPER_VIDEO_MP4_FILE = "video.mp4";
export const DEVELOPER_VIDEO_POSTER_FILE = "poster.jpg";
const AUDIO_NAME = "audio";

export const HLS_PLAYLIST_CONTENT_TYPE = "application/vnd.apple.mpegurl";
export const HLS_MEDIA_CONTENT_TYPE = "video/mp4";

export interface DeveloperVideoSource {
	width: number;
	height: number;
}

export interface DeveloperVideoEncodePlan {
	ladderMaxTier: DeveloperVideoLadderTier;
	uploads: { name: string; contentType: string }[];
	mp4MaxDimension: number;
}

function even(value: number): number {
	return Math.max(2, Math.round(value / 2) * 2);
}

function topRendition(
	source: DeveloperVideoSource,
	shortSide: number,
): { width: number; height: number } {
	const sourceShort = Math.min(source.width, source.height);
	const sourceLong = Math.max(source.width, source.height);
	const scale = Math.min(
		1,
		shortSide / sourceShort,
		MAX_ENCODE_DIMENSION / sourceLong,
	);
	return {
		width: even(source.width * scale),
		height: even(source.height * scale),
	};
}

function pixels(size: { width: number; height: number }): number {
	return size.width * size.height;
}

export function planDeveloperVideoEncode(
	source: DeveloperVideoSource,
	maxTier: DeveloperVideoResolutionTier,
): DeveloperVideoEncodePlan {
	if (!(source.width > 0) || !(source.height > 0)) {
		throw new Error("Source video has no usable dimensions");
	}
	const pixelBudget = DEVELOPER_VIDEO_TIER_PIXELS[maxTier];
	const firstIndex = LADDER_TIERS.findIndex((tier) => tier.name === maxTier);
	const fitting = LADDER_TIERS.findIndex(
		(tier, index) =>
			index >= firstIndex &&
			pixels(topRendition(source, tier.shortSide)) <=
				pixelBudget * DEVELOPER_VIDEO_TIER_PIXEL_TOLERANCE,
	);
	const tiers = LADDER_TIERS.slice(
		fitting === -1 ? LADDER_TIERS.length - 1 : fitting,
	);
	const ladderTiers = tiers.map((tier) => tier.name);
	const top = topRendition(source, tiers[0]?.shortSide ?? 360);

	const uploads = [
		{
			name: DEVELOPER_VIDEO_MASTER_PLAYLIST,
			contentType: HLS_PLAYLIST_CONTENT_TYPE,
		},
		...[...ladderTiers, AUDIO_NAME].flatMap((name) => [
			{ name: `${name}.m3u8`, contentType: HLS_PLAYLIST_CONTENT_TYPE },
			{ name: `${name}.m4s`, contentType: HLS_MEDIA_CONTENT_TYPE },
		]),
	];

	return {
		ladderMaxTier: ladderTiers[0] ?? "360p",
		uploads,
		mp4MaxDimension: Math.max(top.width, top.height),
	};
}

export function createDeveloperPlaybackId(): string {
	return randomDeveloperId(18);
}

export function createDeveloperEncodeId(): string {
	return randomDeveloperId(9);
}

export interface DeveloperVideoKeys {
	hlsPrefix: string;
	mp4: string;
	poster: string;
}

export function developerVideoKeys(
	video: { appId: string; id: string },
	encodeId: string,
	output: string,
): DeveloperVideoKeys {
	const base = `developer/${video.appId}/${video.id}/${encodeId}/${output}`;
	return {
		hlsPrefix: `${base}/hls/`,
		mp4: `${base}/${DEVELOPER_VIDEO_MP4_FILE}`,
		poster: `${base}/${DEVELOPER_VIDEO_POSTER_FILE}`,
	};
}

const SOURCE_EXTENSIONS: Record<string, string> = {
	"video/mp4": ".mp4",
	"video/webm": ".webm",
	"video/quicktime": ".mov",
	"video/x-matroska": ".mkv",
	"video/avi": ".avi",
};

export function developerVideoSourceExtension(
	contentType: string | null | undefined,
): string | undefined {
	const essence = contentType?.split(";")[0]?.trim().toLowerCase();
	return essence ? SOURCE_EXTENSIONS[essence] : undefined;
}

const ladderRenditionSchema = z.object({
	name: z.string().regex(/^[A-Za-z0-9_-]+$/),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	bandwidth: z.number().positive().nullable().optional(),
	averageBandwidth: z.number().positive().nullable().optional(),
	codecs: z.string().nullable().optional(),
	bytes: z.number().int().positive(),
});

const ladderResultSchema = z.object({
	renditions: z.array(ladderRenditionSchema).min(1),
	audio: z.object({ bytes: z.number().int().positive() }).nullable().optional(),
});

export function parseDeveloperVideoLadder(
	ladder: unknown,
): { renditions: DeveloperVideoRendition[]; bytes: number } | null {
	const parsed = ladderResultSchema.safeParse(ladder);
	if (!parsed.success) return null;
	const renditions = parsed.data.renditions
		.map((rendition) => ({
			name: rendition.name,
			width: rendition.width,
			height: rendition.height,
			bitrate: Math.round(
				rendition.averageBandwidth ?? rendition.bandwidth ?? 0,
			),
			bytes: rendition.bytes,
			codecs: rendition.codecs ?? null,
		}))
		.sort((a, b) => b.width * b.height - a.width * a.height);
	const bytes =
		renditions.reduce((total, rendition) => total + rendition.bytes, 0) +
		(parsed.data.audio?.bytes ?? 0);
	return { renditions, bytes };
}

export function hlsMasterVariantPlaylists(master: string): string[] {
	const lines = master
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const playlists: string[] = [];
	for (const [index, line] of lines.entries()) {
		if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
		const uri = lines[index + 1];
		if (uri && !uri.startsWith("#")) playlists.push(uri);
	}
	return playlists;
}

export function hlsPlaylistDuration(playlist: string): number {
	let seconds = 0;
	for (const line of playlist.split(/\r?\n/)) {
		const match = line.trim().match(/^#EXTINF:([0-9.]+)/);
		if (match?.[1]) seconds += Number(match[1]);
	}
	return seconds;
}

export function ladderMatchesMaster(
	renditions: DeveloperVideoRendition[],
	master: string,
): boolean {
	const playlists = new Set(hlsMasterVariantPlaylists(master));
	return (
		playlists.size === renditions.length &&
		renditions.every((rendition) => playlists.has(`${rendition.name}.m3u8`))
	);
}
