import { Video } from "@cap/web-domain";
import { Effect, Schema } from "effect";
import { totalSegmentDuration } from "@/lib/segment-playback";

export const declaredPlaylistSeconds = (text: string) =>
	text.split("\n").reduce((total, line) => {
		const match = /^#EXTINF:\s*([0-9.]+)/.exec(line.trim());
		const seconds = match ? Number(match[1]) : 0;
		return Number.isFinite(seconds) ? total + seconds : total;
	}, 0);

const isUriLine = (line: string) =>
	line.length > 0 && !line.startsWith("#") && !/^[a-z]+:/i.test(line);

const decodeManifest = Schema.decodeUnknownSync(Video.SegmentManifest);

// The length a segmented or HLS video declares in the manifest or playlist its
// player reads, with the key it was read from, or null for other videos.
export const readDeclaredLength = <E, R>(
	video: { id: string; ownerId: string; source: { type: string } },
	getObject: (key: string) => Effect.Effect<string | null, E, R>,
) =>
	Effect.gen(function* () {
		const prefix = `${video.ownerId}/${video.id}/`;
		if (video.source.type === "desktopSegments") {
			const key = `${prefix}segments/manifest.json`;
			const text = yield* getObject(key);
			if (text === null) return null;
			const manifest = yield* Effect.try(() =>
				decodeManifest(JSON.parse(text)),
			);
			return {
				key,
				seconds: totalSegmentDuration(
					manifest.video_segments.map(Video.normalizeSegmentEntry),
				),
			};
		}
		if (video.source.type !== "local" && video.source.type !== "MediaConvert")
			return null;
		let key =
			video.source.type === "MediaConvert"
				? `${prefix}output/video_recording_000.m3u8`
				: `${prefix}combined-source/stream.m3u8`;
		let text = yield* getObject(key);
		if (text === null) return null;
		if (text.includes("#EXT-X-STREAM-INF")) {
			const variant = text
				.split("\n")
				.map((line) => line.trim())
				.find(isUriLine);
			if (!variant) return null;
			key = `${key.slice(0, key.lastIndexOf("/") + 1)}${variant}`;
			if (!key.startsWith(prefix) || key.includes("..")) return null;
			text = yield* getObject(key);
			if (text === null) return null;
		}
		return { key, seconds: declaredPlaylistSeconds(text) };
	});
