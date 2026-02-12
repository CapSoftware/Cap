import { describe, expect, it } from "vitest";
import { computeRenderSpec } from "../compute";
import { normalizeConfigForRender } from "../normalize";
import type { NormalizedRenderConfig } from "../types";

function baseConfig(
	overrides: Partial<NormalizedRenderConfig> = {},
): NormalizedRenderConfig {
	return {
		aspectRatio: null,
		background: {
			source: { type: "color", value: [255, 255, 255], alpha: 1 },
			padding: 0,
			rounding: 0,
			roundingType: "squircle",
			crop: null,
			shadow: 0,
			advancedShadow: { size: 50, opacity: 18, blur: 50 },
		},
		timeline: null,
		...overrides,
	};
}

describe("computeRenderSpec", () => {
	it("selects aspect ratio from config", () => {
		const spec = computeRenderSpec(
			baseConfig({ aspectRatio: "square" }),
			1280,
			720,
		);
		expect(spec.outputWidth).toBe(1280);
		expect(spec.outputHeight).toBe(1280);
	});

	it("falls back to source aspect ratio when config aspect ratio is null", () => {
		const spec = computeRenderSpec(baseConfig(), 1280, 720);
		expect(spec.outputWidth).toBe(1280);
		expect(spec.outputHeight).toBe(720);
	});

	it("computes inner rect based on padding", () => {
		const spec = computeRenderSpec(
			baseConfig({ background: { ...baseConfig().background, padding: 10 } }),
			100,
			100,
		);
		expect(spec.innerRect.width).toBe(80);
		expect(spec.innerRect.height).toBe(80);
		expect(spec.innerRect.x).toBe(10);
		expect(spec.innerRect.y).toBe(10);
	});

	it("fits inner rect to source ratio when output ratio differs", () => {
		const spec = computeRenderSpec(
			baseConfig({ aspectRatio: "classic" }),
			1920,
			1080,
		);
		expect(spec.outputWidth).toBe(1920);
		expect(spec.outputHeight).toBe(1440);
		expect(spec.innerRect.width).toBe(1920);
		expect(spec.innerRect.height).toBe(1080);
		expect(spec.innerRect.x).toBe(0);
		expect(spec.innerRect.y).toBe(180);
	});

	it("keeps room for shadow when source ratio differs from output ratio", () => {
		const spec = computeRenderSpec(
			baseConfig({
				aspectRatio: "classic",
				background: {
					...baseConfig().background,
					shadow: 100,
					advancedShadow: { size: 50, opacity: 50, blur: 50 },
				},
			}),
			1920,
			1080,
		);
		expect(spec.innerRect.width).toBeLessThan(spec.outputWidth);
		expect(spec.innerRect.x).toBeGreaterThan(0);
		expect(spec.innerRect.width / spec.innerRect.height).toBeCloseTo(16 / 9, 2);
	});

	it("maps rounding type to radius multiplier", () => {
		const rounded = computeRenderSpec(
			baseConfig({
				background: {
					...baseConfig().background,
					rounding: 100,
					roundingType: "rounded",
				},
			}),
			100,
			100,
		);
		const squircle = computeRenderSpec(
			baseConfig({
				background: {
					...baseConfig().background,
					rounding: 100,
					roundingType: "squircle",
				},
			}),
			100,
			100,
		);
		expect(rounded.maskSpec.radiusPx).toBe(50);
		expect(squircle.maskSpec.radiusPx).toBe(40);
	});

	it("computes shadow semantics including spread", () => {
		const spec = computeRenderSpec(
			baseConfig({
				background: {
					...baseConfig().background,
					shadow: 100,
					advancedShadow: { size: 50, opacity: 50, blur: 50 },
				},
			}),
			100,
			100,
		);
		expect(spec.shadowSpec.enabled).toBe(true);
		expect(spec.shadowSpec.offsetY).toBe(9);
		expect(spec.shadowSpec.blurPx).toBe(65);
		expect(spec.shadowSpec.spreadPx).toBe(6);
		expect(spec.shadowSpec.alpha).toBe(0.45);
	});

	it("uses crop bounds for rendered source frame", () => {
		const spec = computeRenderSpec(
			baseConfig({
				background: {
					...baseConfig().background,
					crop: { x: 10, y: 20, width: 640, height: 360 },
				},
			}),
			1920,
			1080,
		);

		expect(spec.videoCrop).toEqual({ x: 10, y: 20, width: 640, height: 360 });
		expect(spec.outputWidth).toBe(640);
		expect(spec.outputHeight).toBe(360);
	});

	it("clamps crop bounds into source frame", () => {
		const spec = computeRenderSpec(
			baseConfig({
				background: {
					...baseConfig().background,
					crop: { x: -10, y: -40, width: 5000, height: 5000 },
				},
			}),
			1280,
			720,
		);

		expect(spec.videoCrop).toEqual({ x: 0, y: 0, width: 1280, height: 720 });
	});
});

describe("normalizeConfigForRender", () => {
	it("normalizes background color alpha and gradient angle", () => {
		const result = normalizeConfigForRender({
			background: {
				source: {
					type: "color",
					value: [0, 0, 0],
					alpha: 0.5,
				},
			},
		});

		expect(result.config.background.source.type).toBe("color");
		if (result.config.background.source.type === "color") {
			expect(result.config.background.source.alpha).toBe(0.5);
		}
		expect(
			result.issues.some((i) => i.code === "BACKGROUND_ALPHA_UNSUPPORTED"),
		).toBe(true);

		const result2 = normalizeConfigForRender({
			background: {
				source: {
					type: "gradient",
					from: [0, 0, 0],
					to: [255, 255, 255],
					angle: 450,
				},
			},
		});

		expect(result2.config.background.source.type).toBe("gradient");
		if (result2.config.background.source.type === "gradient") {
			expect(result2.config.background.source.angle).toBe(360);
		}
	});

	it("accepts valid background crop", () => {
		const result = normalizeConfigForRender({
			background: {
				crop: {
					x: 100,
					y: 120,
					width: 800,
					height: 500,
				},
			},
		});

		expect(result.config.background.crop).toEqual({
			x: 100,
			y: 120,
			width: 800,
			height: 500,
		});
		expect(
			result.issues.some((i) => i.code === "BACKGROUND_CROP_UNSUPPORTED"),
		).toBe(false);
	});
});
