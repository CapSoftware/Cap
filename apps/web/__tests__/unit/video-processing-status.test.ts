import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as unknown[][],
	where: vi.fn(),
	sleep: vi.fn(),
	observe: vi.fn(),
	now: 0,
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		MEDIA_SERVER_URL: "https://worker.example.com",
		WEB_URL: "https://cap.example.com",
		MEDIA_SERVER_WEBHOOK_SECRET: "test-secret",
	}),
}));
vi.mock("@/lib/desktop-recording-job-status", () => ({
	observeDesktopRecordingJob: mocks.observe,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({ from: () => ({ where: mocks.where }) }),
	}),
}));
vi.mock("@cap/database/schema", () => ({
	videos: { id: "id" },
	videoUploads: { videoId: "videoId" },
}));
vi.mock("@cap/web-domain", () => ({
	Video: { VideoId: { make: (id: string) => id } },
}));
vi.mock("workflow", () => ({
	sleep: mocks.sleep,
	FatalError: class FatalError extends Error {},
}));

import {
	readVideoProcessingStatus,
	VIDEO_PROCESSING_STALL_MS,
	VideoProcessingFailedError,
	waitForVideoProcessing,
} from "@/workflows/video-processing-status";

const metadata = { duration: 30, width: 1920, height: 1080, fps: 30 };
const pending = {
	phase: "processing",
	processingProgress: 25,
	processingMessage: "Processing video...",
	processingError: null,
};

describe("durable video processing completion", () => {
	beforeEach(() => {
		mocks.rows = [];
		mocks.now = 0;
		vi.spyOn(Date, "now").mockImplementation(() => mocks.now);
		mocks.where.mockReset().mockImplementation(async () => mocks.rows.shift());
		mocks.sleep.mockReset().mockImplementation(async (delay: number) => {
			mocks.now += delay;
		});
		mocks.observe
			.mockReset()
			.mockResolvedValue({ status: "unavailable", delivered: false });
	});

	afterEach(() => vi.restoreAllMocks());

	it("accepts a callback that already completed without sleeping", async () => {
		mocks.rows = [[], [metadata]];
		await expect(waitForVideoProcessing("video")).resolves.toEqual(metadata);
		expect(mocks.sleep).not.toHaveBeenCalled();
	});

	it("suspends between status reads and observes a delayed callback", async () => {
		mocks.rows = [[pending], [pending], [pending], [], [metadata]];
		await expect(waitForVideoProcessing("video")).resolves.toEqual(metadata);
		expect(mocks.sleep.mock.calls).toEqual([[5_000], [10_000], [15_000]]);
	});

	it("supports an explicit complete row", async () => {
		mocks.rows = [[{ ...pending, phase: "complete" }], [metadata]];
		await expect(waitForVideoProcessing("video")).resolves.toEqual(metadata);
	});

	it.each([
		{ ...pending, processingError: "Download failed" },
		{ ...pending, phase: "error", processingMessage: "Download failed" },
	])("propagates worker failures without another wait", async (upload) => {
		mocks.rows = [[upload]];
		await expect(waitForVideoProcessing("video")).rejects.toThrow(
			"Download failed",
		);
		expect(mocks.sleep).not.toHaveBeenCalled();
	});

	it.each([undefined, { ...metadata, width: null }, { ...metadata, fps: 0 }])(
		"does not treat a missing upload as proof of valid output",
		async (video) => {
			mocks.rows = [[], video ? [video] : []];
			await expect(waitForVideoProcessing("video")).rejects.toThrow(
				"Processing completed but video metadata is missing",
			);
		},
	);

	it("preserves unknown duration without inventing a positive duration", async () => {
		mocks.rows = [[], [{ ...metadata, duration: null }]];
		await expect(readVideoProcessingStatus("video")).resolves.toEqual({
			status: "complete",
			metadata: { ...metadata, duration: 0 },
		});
	});

	it("keeps waiting on a long recording for as long as the worker reports in", async () => {
		const fourHours = 4 * 60 * 60 * 1000;
		const heartbeatMs = 15 * 60 * 1000;
		mocks.rows = [[], [metadata]];
		mocks.where.mockImplementation(async () =>
			mocks.now < fourHours
				? [
						{
							...pending,
							updatedAt: new Date(
								Math.floor(mocks.now / heartbeatMs) * heartbeatMs,
							),
						},
					]
				: mocks.rows.shift(),
		);
		await expect(
			waitForVideoProcessing("video", { maxPollMs: 2 * 60 * 1000 }),
		).resolves.toEqual(metadata);
		expect(mocks.now).toBeGreaterThanOrEqual(fourHours);
		expect(mocks.sleep.mock.calls.length).toBeLessThan(150);
	});

	it("gives up on processing that stops changing, however short the video", async () => {
		mocks.where.mockResolvedValue([{ ...pending, updatedAt: new Date(0) }]);
		const waiting = waitForVideoProcessing("video");
		await expect(waiting).rejects.toBeInstanceOf(VideoProcessingFailedError);
		await expect(waiting).rejects.toThrow(
			"Video processing stopped making progress while processing 25% Processing video...",
		);
		expect(mocks.now).toBeGreaterThan(VIDEO_PROCESSING_STALL_MS);
		expect(mocks.now).toBeLessThanOrEqual(VIDEO_PROCESSING_STALL_MS + 30_000);
		expect(Math.max(...mocks.sleep.mock.calls.map(([delay]) => delay))).toBe(
			30_000,
		);
		expect(mocks.observe).not.toHaveBeenCalled();
	});

	it("asks the media server before giving up, and gives up once it no longer has the job", async () => {
		mocks.where.mockResolvedValue([{ ...pending, updatedAt: new Date(0) }]);
		await expect(
			waitForVideoProcessing("video", { jobId: "job-1" }),
		).rejects.toBeInstanceOf(VideoProcessingFailedError);
		expect(mocks.observe).toHaveBeenCalledExactlyOnceWith({
			videoId: "video",
			jobId: "job-1",
			mediaServerUrl: "https://worker.example.com",
			webhookUrl:
				"https://cap.example.com/api/webhooks/media-server/progress?retryable=true",
			secret: "test-secret",
		});
	});

	it("keeps waiting without a second copy while the media server still runs the job", async () => {
		const stuck = { ...pending, updatedAt: new Date(0) };
		let finishedAt = Number.POSITIVE_INFINITY;
		mocks.observe.mockImplementation(async () => {
			if (mocks.now > 90 * 60 * 1000) {
				finishedAt = mocks.now;
				return { status: "terminal", delivered: true };
			}
			return { status: "active", delivered: false };
		});
		mocks.rows = [[], [metadata]];
		mocks.where.mockImplementation(async () =>
			mocks.now <= finishedAt ? [stuck] : mocks.rows.shift(),
		);
		await expect(
			waitForVideoProcessing("video", { jobId: "job-1" }),
		).resolves.toEqual(metadata);
		expect(finishedAt).toBeGreaterThan(90 * 60 * 1000);
		const checks = mocks.observe.mock.calls.length;
		expect(checks).toBeGreaterThan(100);
		expect(checks).toBeLessThan(mocks.where.mock.calls.length);
	});

	it("goes back to quiet waiting once updates arrive again", async () => {
		let updatedAt = 0;
		mocks.observe.mockImplementation(async () => {
			updatedAt = mocks.now;
			return { status: "active", delivered: false };
		});
		mocks.rows = [[], [metadata]];
		mocks.where.mockImplementation(async () =>
			mocks.now < 3 * 60 * 60 * 1000
				? [{ ...pending, updatedAt: new Date(updatedAt) }]
				: mocks.rows.shift(),
		);
		await expect(
			waitForVideoProcessing("video", { jobId: "job-1" }),
		).resolves.toEqual(metadata);
		expect(mocks.observe.mock.calls.length).toBeLessThanOrEqual(9);
	});
});
