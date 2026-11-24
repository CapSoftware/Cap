import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
	declaredPlaylistSeconds,
	readDeclaredLength,
} from "@/lib/free-plan-declared-length";

const video = (type: string) => ({
	id: "video-1",
	ownerId: "owner-1",
	source: { type },
});

const objects = (entries: Record<string, string>) => (key: string) =>
	Effect.succeed(entries[key] ?? null);

const read = (type: string, entries: Record<string, string>) =>
	Effect.runPromise(readDeclaredLength(video(type), objects(entries)));

describe("declared free plan lengths", () => {
	it("totals the segments a manifest lists", async () => {
		const manifest = JSON.stringify({
			version: 1,
			video_init_uploaded: true,
			audio_init_uploaded: false,
			video_segments: Array.from({ length: 120 }, (_, index) => ({
				index,
				duration: 3,
			})),
			audio_segments: [],
			is_complete: true,
		});
		expect(
			await read("desktopSegments", {
				"owner-1/video-1/segments/manifest.json": manifest,
			}),
		).toEqual({ key: "owner-1/video-1/segments/manifest.json", seconds: 360 });
	});

	it("follows the first rendition of a multivariant playlist", async () => {
		const media = "#EXTM3U\n#EXTINF:4.0,\na.ts\n#EXTINF:4.5,\nb.ts\n";
		expect(
			await read("MediaConvert", {
				"owner-1/video-1/output/video_recording_000.m3u8":
					"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvideo_recording_000_1080p.m3u8\n",
				"owner-1/video-1/output/video_recording_000_1080p.m3u8": media,
			}),
		).toEqual({
			key: "owner-1/video-1/output/video_recording_000_1080p.m3u8",
			seconds: 8.5,
		});
	});

	it("never reads outside the video for a crafted rendition", async () => {
		expect(
			await read("local", {
				"owner-1/video-1/combined-source/stream.m3u8":
					"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n../../other/x.m3u8\n",
			}),
		).toBeNull();
	});

	it("has nothing to declare for whole files or missing playlists", async () => {
		expect(await read("webMP4", {})).toBeNull();
		expect(await read("local", {})).toBeNull();
		expect(declaredPlaylistSeconds("#EXTINF:abc,\n#EXTINF:2,\n")).toBe(2);
	});
});
