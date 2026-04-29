import { describe, expect, it, vi } from "vitest";
import {
	openShareUrlInNewTab,
	selectRecordingPipelineFromSupport,
	shouldPreferStreamingUpload,
} from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/web-recorder-utils";

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
