import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	rows: [] as unknown[][],
	where: vi.fn(),
	sleep: vi.fn(),
	now: 0,
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
	});
});
