import { describe, expect, it, vi } from "vitest";
import { captureVideoFrameDataUrl } from "@/app/s/[videoId]/_components/video-frame-thumbnail";

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

function createMockVideo(readyState = 3): HTMLVideoElement {
	return { readyState } as unknown as HTMLVideoElement;
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
		expect(ctx.drawImage).toHaveBeenCalledWith(video, 0, 0, 224, 128);
		expect(canvas.toDataURL).toHaveBeenCalledWith("image/jpeg", 0.8);
	});

	it("respects custom width and height", () => {
		const { canvas, ctx } = createMockCanvas();
		const video = createMockVideo();
		captureVideoFrameDataUrl({
			video,
			createCanvas: () => canvas,
			width: 320,
			height: 180,
		});
		expect(canvas.width).toBe(320);
		expect(canvas.height).toBe(180);
		expect(ctx.drawImage).toHaveBeenCalledWith(video, 0, 0, 320, 180);
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
