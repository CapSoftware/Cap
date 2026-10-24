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
	waitForSignalledVideoProcessing,
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

	it("bounds waiting when a worker never completes", async () => {
		mocks.where.mockResolvedValue([pending]);
		await expect(waitForVideoProcessing("video")).rejects.toThrow(
			"Video processing timed out while processing 25% Processing video...",
		);
		expect(mocks.now).toBeLessThanOrEqual(60 * 60 * 1000 + 30_000);
		expect(mocks.sleep.mock.calls.length).toBeLessThan(130);
		expect(Math.max(...mocks.sleep.mock.calls.map(([delay]) => delay))).toBe(
			30_000,
		);
	});
});

describe("signalled video processing completion", () => {
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

	it("reads the status once when the worker signals", async () => {
		mocks.sleep.mockImplementation(() => new Promise(() => undefined));
		mocks.rows = [[], [metadata]];
		await expect(
			waitForSignalledVideoProcessing("video", Promise.resolve()),
		).resolves.toEqual(metadata);
		expect(mocks.where).toHaveBeenCalledTimes(2);
	});

	it("checks every five minutes when no signal arrives", async () => {
		mocks.rows = [[pending], [pending], [], [metadata]];
		await expect(
			waitForSignalledVideoProcessing("video", new Promise(() => undefined)),
		).resolves.toEqual(metadata);
		expect(mocks.sleep.mock.calls).toEqual([[300_000], [300_000], [300_000]]);
	});

	it("falls back to short polling if the signal beats the saved state", async () => {
		const sleeps: number[] = [];
		let signalled = false;
		mocks.sleep.mockImplementation((delay: number) => {
			sleeps.push(delay);
			mocks.now += delay;
			return delay === 300_000
				? new Promise(() => undefined)
				: Promise.resolve();
		});
		mocks.rows = [[pending], [pending], [], [metadata]];
		await expect(
			waitForSignalledVideoProcessing(
				"video",
				Promise.resolve().then(() => {
					signalled = true;
				}),
			),
		).resolves.toEqual(metadata);
		expect(signalled).toBe(true);
		expect(sleeps).toEqual([300_000, 5_000, 10_000]);
	});

	it("propagates worker failures after the signal", async () => {
		mocks.sleep.mockImplementation(() => new Promise(() => undefined));
		mocks.rows = [[{ ...pending, processingError: "Loom 404" }]];
		await expect(
			waitForSignalledVideoProcessing("video", Promise.resolve()),
		).rejects.toThrow("Loom 404");
	});

	it("subscribes to the signal only once", async () => {
		const then = vi.fn();
		mocks.where.mockResolvedValue([pending]);
		await expect(
			waitForSignalledVideoProcessing("video", { then }),
		).rejects.toThrow("Video processing timed out");
		expect(then).toHaveBeenCalledTimes(1);
		expect(mocks.now).toBeLessThanOrEqual(60 * 60 * 1000 + 300_000);
	});
});
