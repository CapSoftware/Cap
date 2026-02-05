import type {
	RenderInnerRect,
	RenderMaskSpec,
	RenderShadowSpec,
} from "@cap/editor-render-spec";
import { describe, expect, it } from "vitest";
import { drawShadow } from "../draw-shadow";

function createMockCtx() {
	const calls: Array<{ method: string; args: unknown[] }> = [];
	const props: Record<string, unknown> = {};

	const handler: ProxyHandler<Record<string, unknown>> = {
		get(target, prop: string) {
			if (prop === "__calls") return calls;
			if (prop === "__props") return props;
			if (
				prop === "fillStyle" ||
				prop === "shadowColor" ||
				prop === "shadowBlur" ||
				prop === "shadowOffsetX" ||
				prop === "shadowOffsetY"
			) {
				return props[prop];
			}
			if (typeof prop === "string") {
				if (!(prop in target)) {
					target[prop] = (...args: unknown[]) => {
						calls.push({ method: prop, args });
						return undefined;
					};
				}
				return target[prop];
			}
			return undefined;
		},
		set(_target, prop: string, value) {
			props[prop] = value;
			calls.push({ method: `set:${prop}`, args: [value] });
			return true;
		},
	};

	return new Proxy(
		{} as Record<string, unknown>,
		handler,
	) as unknown as CanvasRenderingContext2D & {
		__calls: typeof calls;
		__props: typeof props;
	};
}

describe("drawShadow", () => {
	const innerRect: RenderInnerRect = {
		x: 100,
		y: 100,
		width: 1720,
		height: 880,
	};

	const maskSpec: RenderMaskSpec = {
		shape: "roundedRect",
		roundingType: "rounded",
		radiusPx: 20,
	};

	it("does nothing when shadow is disabled", () => {
		const ctx = createMockCtx();
		const shadowSpec: RenderShadowSpec = {
			enabled: false,
			offsetX: 0,
			offsetY: 0,
			blurPx: 0,
			spreadPx: 0,
			alpha: 0,
		};

		drawShadow(ctx, innerRect, maskSpec, shadowSpec);

		expect(ctx.__calls.length).toBe(0);
	});

	it("does nothing when alpha is zero", () => {
		const ctx = createMockCtx();
		const shadowSpec: RenderShadowSpec = {
			enabled: true,
			offsetX: 0,
			offsetY: 5,
			blurPx: 10,
			spreadPx: 3,
			alpha: 0,
		};

		drawShadow(ctx, innerRect, maskSpec, shadowSpec);

		expect(ctx.__calls.length).toBe(0);
	});

	it("uses FAR_OFFSET technique for shadow rendering", () => {
		const ctx = createMockCtx();
		const shadowSpec: RenderShadowSpec = {
			enabled: true,
			offsetX: 0,
			offsetY: 5,
			blurPx: 10,
			spreadPx: 3,
			alpha: 0.5,
		};

		drawShadow(ctx, innerRect, maskSpec, shadowSpec);

		const saveCall = ctx.__calls.find((c) => c.method === "save");
		expect(saveCall).toBeDefined();

		const shadowOffsetXSet = ctx.__calls.find(
			(c) => c.method === "set:shadowOffsetX",
		);
		expect(shadowOffsetXSet).toBeDefined();
		expect(shadowOffsetXSet?.args[0]).toBe(10000);

		const shadowOffsetYSet = ctx.__calls.find(
			(c) => c.method === "set:shadowOffsetY",
		);
		expect(shadowOffsetYSet).toBeDefined();
		expect(shadowOffsetYSet?.args[0]).toBe(10005);

		const translateCall = ctx.__calls.find((c) => c.method === "translate");
		expect(translateCall).toBeDefined();
		expect(translateCall?.args).toEqual([-10000, -10000]);

		const fillCall = ctx.__calls.find((c) => c.method === "fill");
		expect(fillCall).toBeDefined();

		const restoreCall = ctx.__calls.find((c) => c.method === "restore");
		expect(restoreCall).toBeDefined();
	});

	it("sets correct shadow properties", () => {
		const ctx = createMockCtx();
		const shadowSpec: RenderShadowSpec = {
			enabled: true,
			offsetX: 0,
			offsetY: 8,
			blurPx: 20,
			spreadPx: 5,
			alpha: 0.7,
		};

		drawShadow(ctx, innerRect, maskSpec, shadowSpec);

		const blurSet = ctx.__calls.find((c) => c.method === "set:shadowBlur");
		expect(blurSet).toBeDefined();
		expect(blurSet?.args[0]).toBe(20);

		const colorSet = ctx.__calls.find((c) => c.method === "set:shadowColor");
		expect(colorSet).toBeDefined();
		expect(colorSet?.args[0]).toBe("rgba(0, 0, 0, 0.7)");
	});
});
