import { afterEach, describe, expect, it, vi } from "vitest";
import { isEarlyInstantPlaybackEnabled } from "@/lib/early-instant-playback";
import {
	contiguousSegmentPrefix,
	getEarlySegmentTracks,
} from "@/lib/segment-playback";

const uploading = {
	version: 2,
	video_init_uploaded: true,
	audio_init_uploaded: true,
	video_segments: [
		{ index: 1, duration: 2 },
		{ index: 2, duration: 2 },
	],
	audio_segments: [{ index: 1, duration: 2 }],
	is_complete: false,
};

describe("Contiguous segment prefix", () => {
	it("stops at the first segment still in flight", () => {
		expect(
			contiguousSegmentPrefix([
				{ index: 1, duration: 2 },
				{ index: 2, duration: 2 },
				{ index: 4, duration: 2 },
			]).map((segment) => segment.index),
		).toEqual([1, 2]);
	});

	it("is empty while the first segment is still uploading", () => {
		expect(contiguousSegmentPrefix([{ index: 2, duration: 2 }])).toEqual([]);
	});

	it("orders entries and reads legacy bare indexes", () => {
		expect(contiguousSegmentPrefix([2, 1, 3])).toEqual([
			{ index: 1, duration: 3 },
			{ index: 2, duration: 3 },
			{ index: 3, duration: 3 },
		]);
	});

	it("does not treat a 0-based list as a playable run", () => {
		expect(contiguousSegmentPrefix([0, 1, 2])).toEqual([]);
	});

	it("stops at a repeated index", () => {
		expect(contiguousSegmentPrefix([1, 1, 2]).map((s) => s.index)).toEqual([1]);
	});
});

describe("Early segment tracks", () => {
	it("plays the uploaded start of a stopped recording", () => {
		expect(getEarlySegmentTracks(uploading)).toEqual({
			video: uploading.video_segments,
			audio: uploading.audio_segments,
		});
	});

	it("leaves complete manifests to the regular playlist", () => {
		expect(getEarlySegmentTracks({ ...uploading, is_complete: true })).toBe(
			null,
		);
	});

	it("waits while audio has not started uploading", () => {
		expect(
			getEarlySegmentTracks({
				...uploading,
				audio_init_uploaded: false,
				audio_segments: [],
			}),
		).toBe(null);
		expect(getEarlySegmentTracks({ ...uploading, audio_segments: [] })).toBe(
			null,
		);
		expect(
			getEarlySegmentTracks({
				...uploading,
				audio_segments: [{ index: 2, duration: 2 }],
			}),
		).toBe(null);
	});

	it("waits for the video init and first video segment", () => {
		expect(
			getEarlySegmentTracks({ ...uploading, video_init_uploaded: false }),
		).toBe(null);
		expect(
			getEarlySegmentTracks({
				...uploading,
				video_segments: [{ index: 2, duration: 2 }],
			}),
		).toBe(null);
	});
});

describe("Early instant playback flag", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("is off unless configured", () => {
		vi.stubEnv("CAP_EARLY_INSTANT_PLAYBACK", "");
		expect(isEarlyInstantPlaybackEnabled("owner")).toBe(false);
		vi.stubEnv("CAP_EARLY_INSTANT_PLAYBACK", "true");
		expect(isEarlyInstantPlaybackEnabled("owner")).toBe(false);
	});

	it("can be enabled for everyone", () => {
		vi.stubEnv("CAP_EARLY_INSTANT_PLAYBACK", " enabled ");
		expect(isEarlyInstantPlaybackEnabled("owner")).toBe(true);
	});

	it("can be rolled out to listed owners", () => {
		vi.stubEnv("CAP_EARLY_INSTANT_PLAYBACK", "first, owner");
		expect(isEarlyInstantPlaybackEnabled("owner")).toBe(true);
		expect(isEarlyInstantPlaybackEnabled("other")).toBe(false);
		expect(isEarlyInstantPlaybackEnabled("own")).toBe(false);
	});
});
