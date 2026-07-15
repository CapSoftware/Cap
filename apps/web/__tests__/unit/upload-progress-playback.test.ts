import { describe, expect, it } from "vitest";
import {
	canRetryFailedProcessing,
	getStalledProcessingMessage,
	getUploadFailureMessage,
	shouldDeferPlaybackSource,
	shouldReloadPlaybackAfterUploadCompletes,
} from "@/app/s/[videoId]/_components/ProgressCircle";

describe("shouldDeferPlaybackSource", () => {
	it.each([
		{ status: "fetching" },
		{
			status: "uploading",
			lastUpdated: new Date(),
			progress: 10,
		},
	])("returns true for active upload state %#", (uploadProgress) => {
		expect(shouldDeferPlaybackSource(uploadProgress as never)).toBe(true);
	});

	it.each([
		null,
		{
			status: "processing",
			lastUpdated: new Date(),
			progress: 42,
			message: "Processing video...",
		},
		{
			status: "generating_thumbnail",
			lastUpdated: new Date(),
			progress: 90,
		},
		{
			status: "error",
			lastUpdated: new Date(),
			errorMessage: "Processing failed",
		},
		{
			status: "failed",
			lastUpdated: new Date(),
		},
	])("returns false for non-blocking state %#", (uploadProgress) => {
		expect(shouldDeferPlaybackSource(uploadProgress as never)).toBe(false);
	});

	it("allows retry only for owner-visible processing errors", () => {
		expect(
			canRetryFailedProcessing(
				{
					status: "error",
					lastUpdated: new Date(),
					errorMessage: "Video processing timed out",
					hasRawFallback: false,
				},
				true,
			),
		).toBe(true);
		expect(
			canRetryFailedProcessing(
				{
					status: "error",
					lastUpdated: new Date(),
					errorMessage: "Video processing timed out",
					hasRawFallback: false,
				},
				false,
			),
		).toBe(false);
		expect(
			canRetryFailedProcessing(
				{
					status: "failed",
					lastUpdated: new Date(),
				} as never,
				true,
			),
		).toBe(false);
	});

	it("uses upload-specific failure messaging", () => {
		expect(
			getUploadFailureMessage(
				{
					status: "error",
					lastUpdated: new Date(),
					errorMessage: "Video uploaded, but processing could not start.",
					hasRawFallback: false,
				},
				true,
			),
		).toBe("Video uploaded, but processing could not start.");
		expect(
			getUploadFailureMessage(
				{
					status: "error",
					lastUpdated: new Date(),
					errorMessage: null,
					hasRawFallback: false,
				},
				false,
			),
		).toBe("处理失败。请联系所有者重试处理或重新上传录制内容。");
		expect(
			getUploadFailureMessage(
				{
					status: "failed",
					lastUpdated: new Date(),
				} as never,
				false,
			),
		).toBe("上传在处理完成前停滞。请重新上传录制内容以继续。");
	});

	it("reloads playback when upload progress clears", () => {
		expect(
			shouldReloadPlaybackAfterUploadCompletes(
				{
					status: "processing",
					lastUpdated: new Date(),
					progress: 80,
					message: "Finishing video...",
				},
				{
					status: "processing",
					lastUpdated: new Date(),
					progress: 90,
					message: "Still processing...",
				},
			),
		).toBe(false);
		expect(
			shouldReloadPlaybackAfterUploadCompletes(
				{
					status: "fetching",
				},
				null,
			),
		).toBe(false);
		expect(
			shouldReloadPlaybackAfterUploadCompletes(
				{
					status: "fetching",
				},
				null,
				{ includeFetching: true },
			),
		).toBe(true);
		expect(
			shouldReloadPlaybackAfterUploadCompletes(
				{
					status: "processing",
					lastUpdated: new Date(),
					progress: 80,
					message: "Finishing video...",
				},
				null,
			),
		).toBe(true);
		expect(shouldReloadPlaybackAfterUploadCompletes(null, null)).toBe(false);
	});

	it("detects processing that never actually started", () => {
		expect(
			getStalledProcessingMessage({
				phase: "processing",
				updatedAt: new Date(Date.now() - 91_000),
				processingProgress: 0,
			}),
		).toBe("视频处理未开始，请重试处理。");

		expect(
			getStalledProcessingMessage({
				phase: "processing",
				updatedAt: new Date(Date.now() - 30_000),
				processingProgress: 0,
			}),
		).toBeNull();
	});

	it("detects processing that stalled after starting", () => {
		expect(
			getStalledProcessingMessage({
				phase: "processing",
				updatedAt: new Date(Date.now() - 11 * 60 * 1000),
				processingProgress: 25,
			}),
		).toBe("视频处理已停滞，请重试处理。");
	});
});
