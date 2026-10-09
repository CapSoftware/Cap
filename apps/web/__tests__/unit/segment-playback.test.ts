import { describe, expect, it } from "vitest";
import { getSegmentPlaybackState } from "@/lib/segment-playback";

const manifest = {
	version: 2,
	video_init_uploaded: true,
	audio_init_uploaded: true,
	video_segments: [{ index: 1, duration: 3 }],
	audio_segments: [{ index: 1, duration: 3 }],
	is_complete: true,
};

describe("Instant recording playback readiness", () => {
	it("allows complete audio and video without waiting for an MP4", () => {
		expect(getSegmentPlaybackState(manifest)).toBe("ready");
	});

	it("allows an intentionally silent recording", () => {
		expect(
			getSegmentPlaybackState({
				...manifest,
				audio_init_uploaded: false,
				audio_segments: [],
			}),
		).toBe("ready");
	});

	it("keeps unfinished uploads pending even when their first frame exists", () => {
		expect(getSegmentPlaybackState({ ...manifest, is_complete: false })).toBe(
			"uploading",
		);
	});

	it.each([
		{ audio_init_uploaded: false },
		{ video_segments: [{ index: 4, duration: 1.589 }] },
		{
			video_init_uploaded: false,
			audio_init_uploaded: false,
			video_segments: [],
			audio_segments: [],
		},
		{
			video_segments: [
				{ index: 1, duration: 2.09 },
				{ index: 2, duration: 0.662 },
			],
			audio_init_uploaded: false,
		},
		{ audio_segments: [] },
		{ video_segments: [{ index: 1, duration: 0 }] },
	])(
		"refuses an incomplete source instead of silently dropping media: %j",
		(change) => {
			expect(getSegmentPlaybackState({ ...manifest, ...change })).toBe(
				"incomplete",
			);
		},
	);

	it("retains support for legacy numeric segment entries", () => {
		expect(
			getSegmentPlaybackState({
				...manifest,
				version: 1,
				video_segments: [1, 2],
				audio_segments: [1, 2],
			}),
		).toBe("ready");
	});
});
