import {
	recorderOptions,
	recordingBitrate,
} from "@cap/recorder-core/recorder-encoding";
import { describe, expect, it } from "vitest";

const track = (settings: MediaTrackSettings) =>
	({ getSettings: () => settings }) as MediaStreamTrack;

describe("recordingBitrate", () => {
	it("scales with the captured pixels and high frame rates", () => {
		expect(recordingBitrate(1280, 720, 30)).toBe(2_500_000);
		expect(recordingBitrate(1920, 1080, 30)).toBe(4_000_000);
		expect(recordingBitrate(2560, 1600, 30)).toBe(6_000_000);
		expect(recordingBitrate(3840, 2160, 30)).toBe(10_000_000);
		expect(recordingBitrate(1920, 1080, 60)).toBe(6_000_000);
		expect(recordingBitrate(undefined, undefined, undefined)).toBe(4_000_000);
	});

	it("gives cameras a camera-shaped rate, lowest for a camera bubble", () => {
		expect(recordingBitrate(1280, 720, 30, "cameraOverlay")).toBe(2_000_000);
		expect(recordingBitrate(1920, 1080, 30, "cameraOverlay")).toBe(3_500_000);
		expect(recordingBitrate(3840, 2160, 30, "cameraOverlay")).toBe(8_000_000);
		expect(recordingBitrate(1920, 1080, 60, "cameraOverlay")).toBe(5_250_000);
		expect(recordingBitrate(1920, 1080, 30, "camera")).toBe(4_500_000);
	});
});

describe("recorderOptions", () => {
	it("sets the H.264 level from the capture size when the browser supports it", () => {
		const options = recorderOptions(
			'video/mp4;codecs="avc1.64002A,mp4a.40.2"',
			track({ width: 3024, height: 1964, frameRate: 30 }),
			() => true,
		);
		expect(options.mimeType).toBe('video/mp4;codecs="avc1.640033,mp4a.40.2"');
		expect(options.videoBitsPerSecond).toBe(10_000_000);
		expect(options.videoKeyFrameIntervalDuration).toBe(2000);
	});

	it("scales a camera track's rate for the quality level", () => {
		expect(
			recorderOptions(
				'video/mp4;codecs="avc1.64002A"',
				track({ width: 1920, height: 1080, frameRate: 30 }),
				() => true,
				1.6,
				"cameraOverlay",
			).videoBitsPerSecond,
		).toBe(5_600_000);
	});

	it("gives VP8 camera recordings more bits than H.264", () => {
		expect(
			recorderOptions(
				"video/webm;codecs=vp8",
				track({ width: 1920, height: 1080, frameRate: 30 }),
				() => true,
				1,
				"cameraOverlay",
			).videoBitsPerSecond,
		).toBe(4_550_000);
	});

	it("keeps the chosen type when the sized one is unsupported or not H.264", () => {
		expect(
			recorderOptions(
				'video/mp4;codecs="avc1.64002A"',
				track({ width: 5120, height: 2880 }),
				() => false,
			).mimeType,
		).toBe('video/mp4;codecs="avc1.64002A"');
		expect(
			recorderOptions(
				"video/webm;codecs=vp9",
				track({ width: 3840, height: 2160 }),
				() => true,
			).mimeType,
		).toBe("video/webm;codecs=vp9");
	});
});
