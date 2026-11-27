import {
	describeRecordingCodecs,
	openShareUrlInNewTab,
	selectAudioRecordingPipelineFromSupport,
	selectRecordingPipelineFromSupport,
	shouldPreferStreamingUpload,
} from "@cap/recorder-core/recorder-utils";
import { describe, expect, it, vi } from "vitest";

describe("selectRecordingPipelineFromSupport", () => {
	it("prefers streaming webm when webm and mp4 are both supported and streaming is preferred", () => {
		const supportedTypes = new Set([
			"video/webm;codecs=vp9,opus",
			'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
		]);

		const pipeline = selectRecordingPipelineFromSupport(
			true,
			(candidate) => supportedTypes.has(candidate),
			{ preferStreamingUpload: true },
		);

		expect(pipeline).toEqual({
			mode: "streaming-webm",
			mimeType: "video/webm;codecs=vp9,opus",
			fileExtension: "webm",
			supportsProgressiveUpload: true,
		});
	});

	it("prefers buffered mp4 when streaming uploads are not preferred", () => {
		const supportedTypes = new Set([
			"video/webm;codecs=vp9,opus",
			'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
		]);

		const pipeline = selectRecordingPipelineFromSupport(
			true,
			(candidate) => supportedTypes.has(candidate),
			{ preferStreamingUpload: false },
		);

		expect(pipeline).toEqual({
			mode: "buffered-raw",
			mimeType: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
			fileExtension: "mp4",
			supportsProgressiveUpload: false,
		});
	});

	it("falls back to buffered mp4 when webm is unavailable", () => {
		const supportedTypes = new Set(['video/mp4;codecs="avc1.42E01E"']);

		const pipeline = selectRecordingPipelineFromSupport(false, (candidate) =>
			supportedTypes.has(candidate),
		);

		expect(pipeline).toEqual({
			mode: "buffered-raw",
			mimeType: 'video/mp4;codecs="avc1.42E01E"',
			fileExtension: "mp4",
			supportsProgressiveUpload: false,
		});
	});

	it("falls back to buffered webm when streaming uploads are not preferred and mp4 is unavailable", () => {
		const supportedTypes = new Set(["video/webm;codecs=vp9,opus"]);

		const pipeline = selectRecordingPipelineFromSupport(
			true,
			(candidate) => supportedTypes.has(candidate),
			{ preferStreamingUpload: false },
		);

		expect(pipeline).toEqual({
			mode: "buffered-raw",
			mimeType: "video/webm;codecs=vp9,opus",
			fileExtension: "webm",
			supportsProgressiveUpload: false,
		});
	});

	it("uses streaming webm when mp4 is unavailable and streaming is preferred", () => {
		const supportedTypes = new Set(["video/webm;codecs=vp9,opus"]);

		const pipeline = selectRecordingPipelineFromSupport(
			true,
			(candidate) => supportedTypes.has(candidate),
			{ preferStreamingUpload: true },
		);

		expect(pipeline).toEqual({
			mode: "streaming-webm",
			mimeType: "video/webm;codecs=vp9,opus",
			fileExtension: "webm",
			supportsProgressiveUpload: true,
		});
	});

	it("returns null when no supported recorder mime type is available", () => {
		expect(selectRecordingPipelineFromSupport(true, () => false)).toBeNull();
	});

	it("streams fragmented H.264 MP4 when asked for MP4 and the browser can", () => {
		const supportedTypes = new Set([
			"video/webm;codecs=vp9,opus",
			'video/mp4;codecs="avc1.64002A,mp4a.40.2"',
		]);

		expect(
			selectRecordingPipelineFromSupport(
				true,
				(candidate) => supportedTypes.has(candidate),
				{ preferStreamingUpload: true, preferMp4: true },
			),
		).toEqual({
			mode: "streaming-mp4",
			mimeType: 'video/mp4;codecs="avc1.64002A,mp4a.40.2"',
			fileExtension: "mp4",
			supportsProgressiveUpload: true,
		});
	});

	it("picks the video-only MP4 type first for a track without audio", () => {
		const supportedTypes = new Set([
			'video/mp4;codecs="avc1.64002A,mp4a.40.2"',
			'video/mp4;codecs="avc1.64002A"',
		]);

		expect(
			selectRecordingPipelineFromSupport(
				false,
				(candidate) => supportedTypes.has(candidate),
				{ preferStreamingUpload: true, preferMp4: true },
			)?.mimeType,
		).toBe('video/mp4;codecs="avc1.64002A"');
	});

	it("falls back to streaming WebM when the browser can't stream MP4", () => {
		const supportedTypes = new Set([
			"video/webm;codecs=vp8,opus",
			'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
		]);

		expect(
			selectRecordingPipelineFromSupport(
				true,
				(candidate) => supportedTypes.has(candidate),
				{ preferStreamingUpload: true, preferMp4: true },
			),
		).toEqual({
			mode: "streaming-webm",
			mimeType: "video/webm;codecs=vp8,opus",
			fileExtension: "webm",
			supportsProgressiveUpload: true,
		});
	});

	it("keeps buffered capture where streaming isn't preferred, even when MP4 is asked for", () => {
		const supportedTypes = new Set([
			'video/mp4;codecs="avc1.64002A,mp4a.40.2"',
			'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
		]);

		expect(
			selectRecordingPipelineFromSupport(
				true,
				(candidate) => supportedTypes.has(candidate),
				{ preferStreamingUpload: false, preferMp4: true },
			),
		).toEqual({
			mode: "buffered-raw",
			mimeType: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
			fileExtension: "mp4",
			supportsProgressiveUpload: false,
		});
	});

	it("never picks streaming MP4 unless asked, so Instant recordings keep WebM", () => {
		const supportedTypes = new Set([
			"video/webm;codecs=vp9,opus",
			'video/mp4;codecs="avc1.64002A,mp4a.40.2"',
		]);

		expect(
			selectRecordingPipelineFromSupport(
				true,
				(candidate) => supportedTypes.has(candidate),
				{ preferStreamingUpload: true },
			)?.mode,
		).toBe("streaming-webm");
	});
});

describe("selectAudioRecordingPipelineFromSupport", () => {
	it("prefers Opus in WebM", () => {
		expect(selectAudioRecordingPipelineFromSupport(() => true)).toEqual({
			mimeType: "audio/webm;codecs=opus",
			fileExtension: "webm",
		});
	});

	it("uses AAC in MP4 where WebM audio can't be recorded", () => {
		const supportedTypes = new Set(["audio/mp4", "audio/mp4;codecs=mp4a.40.2"]);
		expect(
			selectAudioRecordingPipelineFromSupport((candidate) =>
				supportedTypes.has(candidate),
			),
		).toEqual({
			mimeType: "audio/mp4;codecs=mp4a.40.2",
			fileExtension: "mp4",
		});
	});

	it("returns null when no audio type is supported", () => {
		expect(selectAudioRecordingPipelineFromSupport(() => false)).toBeNull();
	});
});

describe("describeRecordingCodecs", () => {
	it("reads vp9 and opus from a webm mime type with audio", () => {
		expect(describeRecordingCodecs("video/webm;codecs=vp9,opus", true)).toEqual(
			{ videoCodec: "vp9", audioCodec: "opus" },
		);
	});

	it("reports vp8 when the recorder negotiated vp8, not vp9", () => {
		expect(describeRecordingCodecs("video/webm;codecs=vp8,opus", true)).toEqual(
			{ videoCodec: "vp8", audioCodec: "opus" },
		);
	});

	it("reads h264 and aac from a quoted mp4 codecs string", () => {
		expect(
			describeRecordingCodecs('video/mp4;codecs="avc1.42E01E,mp4a.40.2"', true),
		).toEqual({ videoCodec: "h264", audioCodec: "aac" });
	});

	it("omits the audio codec when the recording has no audio", () => {
		expect(describeRecordingCodecs("video/webm;codecs=vp9", false)).toEqual({
			videoCodec: "vp9",
			audioCodec: undefined,
		});
	});

	it("falls back to container defaults for a bare mime type", () => {
		expect(describeRecordingCodecs("video/webm", true)).toEqual({
			videoCodec: "vp8",
			audioCodec: "opus",
		});
		expect(describeRecordingCodecs("video/mp4", true)).toEqual({
			videoCodec: "h264",
			audioCodec: "aac",
		});
	});
});

describe("shouldPreferStreamingUpload", () => {
	it("enables streaming uploads for chromium-like browsers", () => {
		expect(
			shouldPreferStreamingUpload({
				userAgent:
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
			}),
		).toBe(true);
	});

	it("disables streaming uploads for safari and firefox", () => {
		expect(
			shouldPreferStreamingUpload({
				userAgent:
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
			}),
		).toBe(false);
		expect(
			shouldPreferStreamingUpload({
				userAgent:
					"Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:141.0) Gecko/20100101 Firefox/141.0",
			}),
		).toBe(false);
	});
});

describe("openShareUrlInNewTab", () => {
	it("opens the share url in a new tab", () => {
		const open = vi.fn(() => ({}));
		vi.stubGlobal("window", {
			open,
		});

		expect(openShareUrlInNewTab("https://cap.so/s/test-video")).toBe(true);
		expect(open).toHaveBeenCalledWith(
			"https://cap.so/s/test-video",
			"_blank",
			"noopener,noreferrer",
		);

		vi.unstubAllGlobals();
	});

	it("returns false when the browser blocks the popup", () => {
		vi.stubGlobal("window", {
			open: vi.fn(() => null),
		});

		expect(openShareUrlInNewTab("https://cap.so/s/test-video")).toBe(false);

		vi.unstubAllGlobals();
	});

	it("does not navigate when the share url is missing", () => {
		expect(openShareUrlInNewTab(null)).toBe(false);
		expect(openShareUrlInNewTab(undefined)).toBe(false);
		expect(openShareUrlInNewTab("")).toBe(false);
	});
});
