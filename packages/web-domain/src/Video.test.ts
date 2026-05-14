import { describe, expect, it } from "vitest";
import {
	M3U8Source,
	Mp4Source,
	normalizeSegmentEntry,
	SegmentsSource,
} from "./Video";

describe("video source file keys", () => {
	it("builds deterministic keys for MP4 sources", () => {
		const source = new Mp4Source({ ownerId: "owner-1", videoId: "video-1" });

		expect(source.getFileKey()).toBe("owner-1/video-1/result.mp4");
	});

	it("builds deterministic keys for HLS playlist sources", () => {
		const source = new M3U8Source({
			ownerId: "owner-1",
			videoId: "video-1",
			subpath: "combined-source/stream.m3u8",
		});

		expect(source.getPlaylistFileKey()).toBe(
			"owner-1/video-1/combined-source/stream.m3u8",
		);
	});

	it("builds deterministic keys for segmented desktop recordings", () => {
		const source = new SegmentsSource({
			ownerId: "owner-1",
			videoId: "video-1",
		});

		expect(source.getManifestKey()).toBe(
			"owner-1/video-1/segments/manifest.json",
		);
		expect(source.getVideoInitKey()).toBe(
			"owner-1/video-1/segments/video/init.mp4",
		);
		expect(source.getAudioInitKey()).toBe(
			"owner-1/video-1/segments/audio/init.mp4",
		);
		expect(source.getVideoSegmentKey(7)).toBe(
			"owner-1/video-1/segments/video/segment_007.m4s",
		);
		expect(source.getAudioSegmentKey(12)).toBe(
			"owner-1/video-1/segments/audio/segment_012.m4s",
		);
	});
});

describe("normalizeSegmentEntry", () => {
	it("uses the legacy default duration for numeric manifest entries", () => {
		expect(normalizeSegmentEntry(4)).toEqual({ index: 4, duration: 3.0 });
	});

	it("preserves explicit segment durations", () => {
		expect(normalizeSegmentEntry({ index: 2, duration: 1.5 })).toEqual({
			index: 2,
			duration: 1.5,
		});
	});
});
