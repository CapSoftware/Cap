import { afterEach, describe, expect, it, vi } from "vitest";
import {
	installAvcLevelClamp,
	pickMobileSafeAvcCodec,
	rewriteAvcCodecString,
} from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/avc-level-clamp";

describe("pickMobileSafeAvcCodec", () => {
	it("returns Level 4.2 for 1080p and below", () => {
		expect(pickMobileSafeAvcCodec(1920, 1080)).toBe("avc1.64002A");
		expect(pickMobileSafeAvcCodec(1280, 720)).toBe("avc1.64002A");
		expect(pickMobileSafeAvcCodec(1920, 1046)).toBe("avc1.64002A");
	});

	it("returns Level 5.1 for 4K and below", () => {
		expect(pickMobileSafeAvcCodec(3840, 2160)).toBe("avc1.640033");
		expect(pickMobileSafeAvcCodec(2560, 1440)).toBe("avc1.640033");
	});

	it("returns Level 5.2 for sources above 4K", () => {
		expect(pickMobileSafeAvcCodec(5120, 2880)).toBe("avc1.640034");
	});

	it("falls back to Level 4.2 when dimensions are missing", () => {
		expect(pickMobileSafeAvcCodec(undefined, undefined)).toBe("avc1.64002A");
		expect(pickMobileSafeAvcCodec(0, 0)).toBe("avc1.64002A");
	});
});

describe("rewriteAvcCodecString", () => {
	it("rewrites high-level avc1 strings to a mobile-safe level", () => {
		expect(rewriteAvcCodecString("avc1.64003D", 1920, 1080)).toBe(
			"avc1.64002A",
		);
		expect(rewriteAvcCodecString("avc1.64003D", 3840, 2160)).toBe(
			"avc1.640033",
		);
	});

	it("preserves non-avc codec strings untouched", () => {
		expect(rewriteAvcCodecString("vp09.00.10.08", 1920, 1080)).toBe(
			"vp09.00.10.08",
		);
		expect(rewriteAvcCodecString("hvc1.1.6.L120.90", 1920, 1080)).toBe(
			"hvc1.1.6.L120.90",
		);
	});
});

describe("installAvcLevelClamp", () => {
	const originalVideoEncoder = (
		globalThis as { VideoEncoder?: typeof VideoEncoder }
	).VideoEncoder;

	afterEach(() => {
		if (originalVideoEncoder === undefined) {
			delete (globalThis as { VideoEncoder?: typeof VideoEncoder })
				.VideoEncoder;
		} else {
			(globalThis as { VideoEncoder?: typeof VideoEncoder }).VideoEncoder =
				originalVideoEncoder;
		}
	});

	it("clamps avc1 codec strings passed to VideoEncoder.configure", () => {
		const configureSpy = vi.fn();
		class FakeVideoEncoder {
			configure(config: VideoEncoderConfig) {
				configureSpy(config);
			}
		}

		(globalThis as { VideoEncoder?: unknown }).VideoEncoder = FakeVideoEncoder;

		const restore = installAvcLevelClamp();

		try {
			const encoder = new FakeVideoEncoder();
			encoder.configure({
				codec: "avc1.64003D",
				width: 1920,
				height: 1080,
			} as VideoEncoderConfig);

			expect(configureSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					codec: "avc1.64002A",
					width: 1920,
					height: 1080,
				}),
			);
		} finally {
			restore();
		}
	});

	it("is a no-op when VideoEncoder is unavailable", () => {
		delete (globalThis as { VideoEncoder?: typeof VideoEncoder }).VideoEncoder;
		const restore = installAvcLevelClamp();
		expect(typeof restore).toBe("function");
		restore();
	});

	it("restores the original configure implementation", () => {
		const configureSpy = vi.fn();
		class FakeVideoEncoder {
			configure(config: VideoEncoderConfig) {
				configureSpy(config);
			}
		}
		(globalThis as { VideoEncoder?: unknown }).VideoEncoder = FakeVideoEncoder;

		const originalConfigure = FakeVideoEncoder.prototype.configure;
		const restore = installAvcLevelClamp();
		restore();

		expect(FakeVideoEncoder.prototype.configure).toBe(originalConfigure);
	});
});
