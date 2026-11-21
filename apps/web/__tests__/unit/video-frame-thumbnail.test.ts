import { describe, expect, it, vi } from "vitest";
import {
	captureVideoFrameDataUrl,
	MAX_LIVE_THUMBNAIL_DRIFT_SECONDS,
	shouldCaptureLiveThumbnail,
} from "@/app/s/[videoId]/_components/video-frame-thumbnail";

function createMockCanvas(options?: {
	contextReturnsNull?: boolean;
	drawImageThrows?: boolean;
	toDataURLThrows?: boolean;
}) {
	const ctx = {
		drawImage: options?.drawImageThrows
			? vi.fn(() => {
					throw new DOMException("Tainted canvas", "SecurityError");
				})
			: vi.fn(),
	};

	return {
		canvas: {
			width: 0,
			height: 0,
			getContext: options?.contextReturnsNull
				? vi.fn().mockReturnValue(null)
				: vi.fn().mockReturnValue(ctx),
			toDataURL: options?.toDataURLThrows
				? vi.fn(() => {
						throw new DOMException("Tainted canvas", "SecurityError");
					})
				: vi.fn().mockReturnValue("data:image/jpeg;base64,abc123"),
		} as unknown as HTMLCanvasElement,
		ctx,
	};
}

function createMockVideo(
	readyState = 3,
	videoWidth = 224,
	videoHeight = 128,
): HTMLVideoElement {
	return { readyState, videoWidth, videoHeight } as unknown as HTMLVideoElement;
}

describe("captureVideoFrameDataUrl", () => {
	it("returns undefined when video is null", () => {
		const result = captureVideoFrameDataUrl({ video: null });
		expect(result).toBeUndefined();
	});

	it("returns undefined when video.readyState < 2", () => {
		const result = captureVideoFrameDataUrl({
			video: createMockVideo(1),
		});
		expect(result).toBeUndefined();
	});

	it("returns undefined when the 2D context is null", () => {
		const { canvas } = createMockCanvas({ contextReturnsNull: true });
		const result = captureVideoFrameDataUrl({
			video: createMockVideo(),
			createCanvas: () => canvas,
		});
		expect(result).toBeUndefined();
	});

	it("returns undefined when drawImage throws (tainted canvas)", () => {
		const { canvas } = createMockCanvas({ drawImageThrows: true });
		const result = captureVideoFrameDataUrl({
			video: createMockVideo(),
			createCanvas: () => canvas,
		});
		expect(result).toBeUndefined();
	});

	it("returns undefined when toDataURL throws (tainted canvas)", () => {
		const { canvas } = createMockCanvas({ toDataURLThrows: true });
		const result = captureVideoFrameDataUrl({
			video: createMockVideo(),
			createCanvas: () => canvas,
		});
		expect(result).toBeUndefined();
	});

	it("returns a data URL on the happy path", () => {
		const { canvas, ctx } = createMockCanvas();
		const video = createMockVideo();
		const result = captureVideoFrameDataUrl({
			video,
			createCanvas: () => canvas,
		});
		expect(result).toBe("data:image/jpeg;base64,abc123");
		expect(ctx.drawImage).toHaveBeenCalledWith(
			video,
			0,
			0,
			224,
			128,
			0,
			0,
			224,
			128,
		);
		expect(canvas.toDataURL).toHaveBeenCalledWith("image/jpeg", 0.8);
	});

	it("respects custom width and height", () => {
		const { canvas, ctx } = createMockCanvas();
		const video = createMockVideo(3, 320, 180);
		captureVideoFrameDataUrl({
			video,
			createCanvas: () => canvas,
			width: 320,
			height: 180,
		});
		expect(canvas.width).toBe(320);
		expect(canvas.height).toBe(180);
		expect(ctx.drawImage).toHaveBeenCalledWith(
			video,
			0,
			0,
			320,
			180,
			0,
			0,
			320,
			180,
		);
	});

	it("center-crops a taller source to the output aspect ratio", () => {
		const { canvas, ctx } = createMockCanvas();
		const video = createMockVideo(3, 1280, 960);
		captureVideoFrameDataUrl({
			video,
			createCanvas: () => canvas,
			width: 160,
			height: 90,
		});
		expect(ctx.drawImage).toHaveBeenCalledWith(
			video,
			0,
			120,
			1280,
			720,
			0,
			0,
			160,
			90,
		);
	});

	it("center-crops a wider source to the output aspect ratio", () => {
		const { canvas, ctx } = createMockCanvas();
		const video = createMockVideo(3, 2560, 1080);
		captureVideoFrameDataUrl({
			video,
			createCanvas: () => canvas,
			width: 160,
			height: 90,
		});
		expect(ctx.drawImage).toHaveBeenCalledWith(
			video,
			320,
			0,
			1920,
			1080,
			0,
			0,
			160,
			90,
		);
	});

	it("respects custom JPEG quality", () => {
		const { canvas } = createMockCanvas();
		captureVideoFrameDataUrl({
			video: createMockVideo(),
			createCanvas: () => canvas,
			quality: 0.45,
		});
		expect(canvas.toDataURL).toHaveBeenCalledWith("image/jpeg", 0.45);
	});

	it("uses the injected createCanvas factory", () => {
		const { canvas } = createMockCanvas();
		const factory = vi.fn().mockReturnValue(canvas);
		captureVideoFrameDataUrl({
			video: createMockVideo(),
			createCanvas: factory,
		});
		expect(factory).toHaveBeenCalledTimes(1);
	});
});

describe("shouldCaptureLiveThumbnail", () => {
	it("exports default drift threshold of 1.5 seconds", () => {
		expect(MAX_LIVE_THUMBNAIL_DRIFT_SECONDS).toBe(1.5);
	});

	it("returns true when hoverTime is within drift threshold of currentTime", () => {
		expect(shouldCaptureLiveThumbnail({ hoverTime: 10, currentTime: 10 })).toBe(
			true,
		);
		expect(
			shouldCaptureLiveThumbnail({ hoverTime: 11.2, currentTime: 10 }),
		).toBe(true);
		expect(
			shouldCaptureLiveThumbnail({ hoverTime: 8.8, currentTime: 10 }),
		).toBe(true);
		expect(
			shouldCaptureLiveThumbnail({ hoverTime: 11.5, currentTime: 10 }),
		).toBe(true);
		expect(
			shouldCaptureLiveThumbnail({ hoverTime: 8.5, currentTime: 10 }),
		).toBe(true);
	});

	it("returns false when hoverTime drifts beyond drift threshold", () => {
		expect(
			shouldCaptureLiveThumbnail({ hoverTime: 11.51, currentTime: 10 }),
		).toBe(false);
		expect(
			shouldCaptureLiveThumbnail({ hoverTime: 8.49, currentTime: 10 }),
		).toBe(false);
		expect(
			shouldCaptureLiveThumbnail({ hoverTime: 200, currentTime: 10 }),
		).toBe(false);
		expect(shouldCaptureLiveThumbnail({ hoverTime: 0, currentTime: 10 })).toBe(
			false,
		);
	});

	it("supports custom maxDriftSeconds", () => {
		expect(
			shouldCaptureLiveThumbnail({
				hoverTime: 13,
				currentTime: 10,
				maxDriftSeconds: 3,
			}),
		).toBe(true);
		expect(
			shouldCaptureLiveThumbnail({
				hoverTime: 13.1,
				currentTime: 10,
				maxDriftSeconds: 3,
			}),
		).toBe(false);
	});

	it("returns false for non-finite values", () => {
		expect(
			shouldCaptureLiveThumbnail({
				hoverTime: Number.NaN,
				currentTime: 10,
			}),
		).toBe(false);
		expect(
			shouldCaptureLiveThumbnail({
				hoverTime: 10,
				currentTime: Number.NaN,
			}),
		).toBe(false);
		expect(
			shouldCaptureLiveThumbnail({
				hoverTime: Number.POSITIVE_INFINITY,
				currentTime: 10,
			}),
		).toBe(false);
		expect(
			shouldCaptureLiveThumbnail({
				hoverTime: 10,
				currentTime: Number.NEGATIVE_INFINITY,
			}),
		).toBe(false);
	});
});
