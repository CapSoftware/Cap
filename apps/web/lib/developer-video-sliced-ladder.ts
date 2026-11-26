import type { DeveloperVideoSliceRendition } from "@cap/database/types";
import { z } from "zod";
import {
	DEVELOPER_VIDEO_MASTER_PLAYLIST,
	developerVideoKeys,
} from "./developer-video-plan";
import {
	buildSlicedHlsMaster,
	HLS_AUDIO_NAME,
	joinHlsSlicePlaylists,
	readHlsSlicePlaylist,
} from "./developer-video-sliced-playlist";
import {
	type FinishedSlice,
	slicedFileName,
	slicedHlsMasterVariants,
} from "./developer-video-slices";

export function slicedHlsKeys(
	video: { appId: string; id: string },
	encodeId: string,
	output: string,
): { hlsPrefix: string; slicePrefix: string } {
	const { hlsPrefix } = developerVideoKeys(video, encodeId, output);
	return {
		hlsPrefix,
		slicePrefix: `${hlsPrefix.slice(0, -"hls/".length)}slices/`,
	};
}

const sliceRenditionSchema = z.object({
	name: z.string().regex(/^[A-Za-z0-9_-]+$/),
	width: z.number().int().positive(),
	height: z.number().int().positive(),
	bandwidth: z.number().positive().nullable().optional(),
	averageBandwidth: z.number().positive().nullable().optional(),
	codecs: z.string().nullable().optional(),
	bytes: z.number().int().positive(),
});

const sliceLadderSchema = z.object({
	renditions: z.array(sliceRenditionSchema).min(1),
	audio: z.object({ bytes: z.number().int().positive() }).nullable().optional(),
});

export function parseDeveloperVideoSliceLadder(
	ladder: unknown,
): { renditions: DeveloperVideoSliceRendition[]; audioBytes: number } | null {
	const parsed = sliceLadderSchema.safeParse(ladder);
	if (!parsed.success) return null;
	const renditions = parsed.data.renditions
		.map((rendition) => {
			const bandwidth = rendition.bandwidth ?? rendition.averageBandwidth ?? 0;
			return {
				name: rendition.name,
				width: rendition.width,
				height: rendition.height,
				bandwidth,
				averageBandwidth: rendition.averageBandwidth ?? bandwidth,
				bytes: rendition.bytes,
				codecs: rendition.codecs ?? null,
			};
		})
		.sort((a, b) => b.width * b.height - a.width * a.height);
	return { renditions, audioBytes: parsed.data.audio?.bytes ?? 0 };
}

type ReadText = (key: string) => Promise<string | null>;

interface SlicedHlsSource {
	video: { appId: string; id: string };
	encodeId: string;
	output: string;
	slices: FinishedSlice[];
	hasAudio: boolean;
	ended: boolean;
}

// Reads one slice's stored playlist for a stream and renames its media file
// to the name that file was stored under.
export async function readStoredSlicePlaylist(
	source: Pick<SlicedHlsSource, "video" | "encodeId" | "output">,
	slice: { index: number; token: string },
	stream: string,
	read: ReadText,
) {
	const { slicePrefix } = slicedHlsKeys(
		source.video,
		source.encodeId,
		source.output,
	);
	const text = await read(
		`${slicePrefix}${slicedFileName(`${stream}.m3u8`, slice.index, slice.token)}`,
	);
	if (!text) throw new Error("A slice of the video has no stored playlist");
	return readHlsSlicePlaylist(
		text,
		`${stream}.m4s`,
		slicedFileName(`${stream}.m4s`, slice.index, slice.token),
	);
}

export const SLICED_AUDIO_PLAYLIST = `${HLS_AUDIO_NAME}.m3u8`;

// The text of one playlist of a ladder made of slices, built from what the
// finished slices stored. Null when the ladder has no such playlist. While
// slices are still to come the audio, which is encoded whole with the first
// slice, is listed only as far as the video reaches.
export async function slicedHlsPlaylistText(
	source: SlicedHlsSource,
	file: string,
	read: ReadText,
): Promise<string | null> {
	const { slices, ended } = source;
	const [first] = slices;
	if (!first) return null;
	if (file === DEVELOPER_VIDEO_MASTER_PLAYLIST) {
		return buildSlicedHlsMaster(slicedHlsMasterVariants(slices), {
			hasAudio: source.hasAudio,
			audioBitrate: first.result.audioBitrate,
		});
	}
	if (file === SLICED_AUDIO_PLAYLIST) {
		if (!source.hasAudio) return null;
		const audio = await readStoredSlicePlaylist(
			source,
			{ index: 0, token: first.job.output },
			HLS_AUDIO_NAME,
			read,
		);
		return joinHlsSlicePlaylists([audio], {
			ended,
			...(ended
				? {}
				: {
						untilSeconds: slices.reduce(
							(total, slice) => total + slice.result.seconds,
							0,
						),
					}),
		});
	}
	const rendition = first.result.renditions.find(
		(candidate) => `${candidate.name}.m3u8` === file,
	);
	if (!rendition) return null;
	const playlists = await Promise.all(
		slices.map((slice, index) =>
			readStoredSlicePlaylist(
				source,
				{ index, token: slice.job.output },
				rendition.name,
				read,
			),
		),
	);
	return joinHlsSlicePlaylists(playlists, { ended });
}

export function slicedHlsPlaylistFiles(source: SlicedHlsSource): string[] {
	const [first] = source.slices;
	if (!first) return [];
	return [
		DEVELOPER_VIDEO_MASTER_PLAYLIST,
		...first.result.renditions.map((rendition) => `${rendition.name}.m3u8`),
		...(source.hasAudio ? [SLICED_AUDIO_PLAYLIST] : []),
	];
}

export function slicedHlsMediaFiles(source: SlicedHlsSource): string[] {
	return source.slices.flatMap((slice, index) => [
		...slice.result.renditions.map((rendition) =>
			slicedFileName(`${rendition.name}.m4s`, index, slice.job.output),
		),
		...(index === 0 && source.hasAudio
			? [slicedFileName(`${HLS_AUDIO_NAME}.m4s`, index, slice.job.output)]
			: []),
	]);
}
