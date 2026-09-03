import {
	describeRecordingCodecs,
	openShareUrlInNewTab,
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

describe("detectRecordingModeFromTrack", () => {
	it("returns null when track is null", async () => {
		const { detectRecordingModeFromTrack } = await import(
			"@cap/recorder-core/recorder-utils"
		);
		expect(detectRecordingModeFromTrack(null)).toBeNull();
	});

	it("detects fullscreen, window, and tab from track label heuristics", async () => {
		const { detectRecordingModeFromTrack } = await import(
			"@cap/recorder-core/recorder-utils"
		);
		const screenTrack = {
			label: "Entire Screen 1",
			getSettings: () => ({}),
		} as unknown as MediaStreamTrack;
		const windowTrack = {
			label: "Application Window (Cap)",
			getSettings: () => ({}),
		} as unknown as MediaStreamTrack;
		const tabTrack = {
			label: "Browser Tab - YouTube",
			getSettings: () => ({}),
		} as unknown as MediaStreamTrack;

		expect(detectRecordingModeFromTrack(screenTrack)).toBe("fullscreen");
		expect(detectRecordingModeFromTrack(windowTrack)).toBe("window");
		expect(detectRecordingModeFromTrack(tabTrack)).toBe("tab");
	});

	it("detects recording mode from browser-provided displaySurface settings", async () => {
		const { detectRecordingModeFromTrack } = await import(
			"@cap/recorder-core/recorder-utils"
		);
		const monitorTrack = {
			label: "custom-label",
			getSettings: () => ({ displaySurface: "monitor" }),
		} as unknown as MediaStreamTrack;
		const windowTrack = {
			label: "custom-label",
			getSettings: () => ({ displaySurface: "window" }),
		} as unknown as MediaStreamTrack;
		const browserTrack = {
			label: "custom-label",
			getSettings: () => ({ displaySurface: "browser" }),
		} as unknown as MediaStreamTrack;

		expect(detectRecordingModeFromTrack(monitorTrack)).toBe("fullscreen");
		expect(detectRecordingModeFromTrack(windowTrack)).toBe("window");
		expect(detectRecordingModeFromTrack(browserTrack)).toBe("tab");
	});
});


describe("error retry utilities", () => {
	it("identifies user cancellation errors correctly", async () => {
		const { isUserCancellationError } = await import(
			"@cap/recorder-core/recorder-utils"
		);
		const notAllowed = new DOMException("Permission denied", "NotAllowedError");
		const abort = new DOMException("Aborted by user", "AbortError");
		const other = new DOMException("Format unsupported", "NotSupportedError");

		expect(isUserCancellationError(notAllowed)).toBe(true);
		expect(isUserCancellationError(abort)).toBe(true);
		expect(isUserCancellationError(other)).toBe(false);
		expect(isUserCancellationError(new Error("generic error"))).toBe(false);
	});

	it("identifies retryable display media preference errors", async () => {
		const { shouldRetryDisplayMediaWithoutPreferences } = await import(
			"@cap/recorder-core/recorder-utils"
		);
		const notSupported = new DOMException(
			"Preferences not supported",
			"NotSupportedError",
		);
		const overconstrained = new DOMException(
			"Constraint unfulfilled",
			"OverconstrainedError",
		);
		const invalidAccess = new DOMException(
			"Invalid access",
			"InvalidAccessError",
		);
		const typeError = new TypeError("Invalid parameter");
		const notAllowed = new DOMException("Permission denied", "NotAllowedError");

		expect(shouldRetryDisplayMediaWithoutPreferences(notSupported)).toBe(true);
		expect(shouldRetryDisplayMediaWithoutPreferences(overconstrained)).toBe(
			true,
		);
		expect(shouldRetryDisplayMediaWithoutPreferences(invalidAccess)).toBe(true);
		expect(shouldRetryDisplayMediaWithoutPreferences(typeError)).toBe(true);
		expect(shouldRetryDisplayMediaWithoutPreferences(notAllowed)).toBe(false);
	});
});
