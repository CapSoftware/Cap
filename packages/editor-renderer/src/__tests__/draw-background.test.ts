import type { RenderSpec } from "@cap/editor-render-spec";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drawBackground } from "../draw-background";
import { ImageCache } from "../image-cache";

beforeEach(() => {
	vi.stubGlobal(
		"Image",
		class MockImage {
			crossOrigin = "";
			src = "";
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
		},
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function createMockCtx() {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const handler: ProxyHandler<Record<string, unknown>> = {
		get(target, prop: string) {
			if (prop === "__calls") return calls;
			if (
				prop === "fillStyle" ||
				prop === "shadowColor" ||
				prop === "shadowBlur" ||
				prop === "shadowOffsetX" ||
				prop === "shadowOffsetY"
			) {
				return target[prop];
			}
			if (typeof prop === "string") {
				if (!(prop in target)) {
					target[prop] = (...args: unknown[]) => {
						calls.push({ method: prop, args });
						if (prop === "createLinearGradient") {
							return {
								addColorStop: (offset: number, color: string) => {
									calls.push({
										method: "gradient.addColorStop",
										args: [offset, color],
									});
								},
							};
						}
						return undefined;
					};
				}
				return target[prop];
			}
			return undefined;
		},
		set(target, prop: string, value) {
			target[prop] = value;
			calls.push({ method: `set:${prop}`, args: [value] });
			return true;
		},
	};
	return new Proxy(
		{} as Record<string, unknown>,
		handler,
	) as unknown as CanvasRenderingContext2D & { __calls: typeof calls };
}

function makeSpec(bgOverride: RenderSpec["backgroundSpec"]): RenderSpec {
	return {
		outputWidth: 1920,
		outputHeight: 1080,
		innerRect: { x: 100, y: 100, width: 1720, height: 880 },
		videoCrop: { x: 0, y: 0, width: 1920, height: 1080 },
		backgroundSpec: bgOverride,
		maskSpec: { shape: "roundedRect", roundingType: "rounded", radiusPx: 20 },
		shadowSpec: {
			enabled: false,
			offsetX: 0,
			offsetY: 0,
			blurPx: 0,
			spreadPx: 0,
			alpha: 0,
		},
	};
}

describe("drawBackground", () => {
	it("fills solid color background", () => {
		const ctx = createMockCtx();
		const cache = new ImageCache();
		const spec = makeSpec({ type: "color", value: [255, 0, 0], alpha: 1 });

		drawBackground(ctx, spec, cache, (p) => p);

		const fillStyleSet = ctx.__calls.find(
			(c) =>
				c.method === "set:fillStyle" && (c.args[0] as string).includes("255"),
		);
		expect(fillStyleSet).toBeDefined();

		const fillRectCall = ctx.__calls.find((c) => c.method === "fillRect");
		expect(fillRectCall).toBeDefined();
		expect(fillRectCall?.args).toEqual([0, 0, 1920, 1080]);
	});

	it("creates linear gradient for gradient background", () => {
		const ctx = createMockCtx();
		const cache = new ImageCache();
		const spec = makeSpec({
			type: "gradient",
			from: [255, 0, 0],
			to: [0, 0, 255],
			angle: 90,
		});

		drawBackground(ctx, spec, cache, (p) => p);

		const gradientCall = ctx.__calls.find(
			(c) => c.method === "createLinearGradient",
		);
		expect(gradientCall).toBeDefined();

		const colorStops = ctx.__calls.filter(
			(c) => c.method === "gradient.addColorStop",
		);
		expect(colorStops.length).toBe(2);
	});

	it("fills gray when image is not loaded yet", () => {
		const ctx = createMockCtx();
		const cache = new ImageCache();
		const spec = makeSpec({ type: "wallpaper", path: "test/bg" });

		drawBackground(ctx, spec, cache, (p) => `/bg/${p}.jpg`);

		const fillStyleSet = ctx.__calls.find(
			(c) => c.method === "set:fillStyle" && c.args[0] === "rgb(128, 128, 128)",
		);
		expect(fillStyleSet).toBeDefined();
	});

	it("fills white for image background with null path", () => {
		const ctx = createMockCtx();
		const cache = new ImageCache();
		const spec = makeSpec({ type: "image", path: null });

		drawBackground(ctx, spec, cache, (p) => p);

		const fillStyleSet = ctx.__calls.find(
			(c) => c.method === "set:fillStyle" && c.args[0] === "rgb(255, 255, 255)",
		);
		expect(fillStyleSet).toBeDefined();
	});
});
