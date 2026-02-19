import type { RenderSpec } from "@cap/editor-render-spec";
import { describe, expect, it } from "vitest";
import { EditorRenderer } from "../renderer";

function createMockCanvas() {
	const calls: Array<{ method: string; args: unknown[] }> = [];

	const mockCtx = new Proxy({} as Record<string, unknown>, {
		get(target, prop: string) {
			if (prop === "__calls") return calls;
			if (
				[
					"fillStyle",
					"shadowColor",
					"shadowBlur",
					"shadowOffsetX",
					"shadowOffsetY",
				].includes(prop)
			) {
				return target[prop];
			}
			if (typeof prop === "string") {
				if (!(prop in target)) {
					target[prop] = (...args: unknown[]) => {
						calls.push({ method: prop, args });
						if (prop === "createLinearGradient") {
							return {
								addColorStop: () => {},
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
	});

	const canvas = {
		getContext: () => mockCtx,
		width: 0,
		height: 0,
		style: { width: "", height: "" },
	} as unknown as HTMLCanvasElement;

	return { canvas, mockCtx, calls };
}

function createMockVideo() {
	return {
		readyState: 2,
		videoWidth: 1920,
		videoHeight: 1080,
	} as unknown as HTMLVideoElement;
}

const testSpec: RenderSpec = {
	outputWidth: 1920,
	outputHeight: 1080,
	innerRect: { x: 100, y: 100, width: 1720, height: 880 },
	videoCrop: { x: 0, y: 0, width: 1920, height: 1080 },
	backgroundSpec: { type: "color", value: [30, 30, 30], alpha: 1 },
	maskSpec: { shape: "roundedRect", roundingType: "rounded", radiusPx: 20 },
	shadowSpec: {
		enabled: true,
		offsetX: 0,
		offsetY: 5,
		blurPx: 10,
		spreadPx: 3,
		alpha: 0.3,
	},
};

describe("EditorRenderer", () => {
	it("constructs without errors", () => {
		const { canvas } = createMockCanvas();
		const renderer = new EditorRenderer({
			canvas,
			spec: testSpec,
			resolveBackgroundPath: (p) => p,
		});
		expect(renderer).toBeDefined();
		renderer.destroy();
	});

	it("renders without errors", () => {
		const { canvas, calls } = createMockCanvas();
		const renderer = new EditorRenderer({
			canvas,
			spec: testSpec,
			resolveBackgroundPath: (p) => p,
		});
		renderer.setVideoSource(createMockVideo());

		renderer.render();

		const clearRect = calls.find((c) => c.method === "clearRect");
		expect(clearRect).toBeDefined();

		const saveCount = calls.filter((c) => c.method === "save").length;
		const restoreCount = calls.filter((c) => c.method === "restore").length;
		expect(saveCount).toBe(restoreCount);

		renderer.destroy();
	});

	it("renders with scaled spec instead of canvas transform", () => {
		const { canvas, calls } = createMockCanvas();
		const renderer = new EditorRenderer({
			canvas,
			spec: testSpec,
			resolveBackgroundPath: (p) => p,
		});
		renderer.setVideoSource(createMockVideo());

		renderer.render();

		const setTransform = calls.find((c) => c.method === "setTransform");
		expect(setTransform).toBeUndefined();

		const fillRect = calls.find((c) => c.method === "fillRect");
		expect(fillRect).toBeDefined();

		renderer.destroy();
	});

	it("does not render after destroy", () => {
		const { canvas, calls } = createMockCanvas();
		const renderer = new EditorRenderer({
			canvas,
			spec: testSpec,
			resolveBackgroundPath: (p) => p,
		});

		renderer.destroy();
		const callCountBefore = calls.length;
		renderer.render();
		expect(calls.length).toBe(callCountBefore);
	});

	it("updates spec and can still render", () => {
		const { canvas, calls } = createMockCanvas();
		const renderer = new EditorRenderer({
			canvas,
			spec: testSpec,
			resolveBackgroundPath: (p) => p,
		});
		renderer.setVideoSource(createMockVideo());

		const newSpec: RenderSpec = {
			...testSpec,
			backgroundSpec: {
				type: "gradient",
				from: [255, 0, 0],
				to: [0, 0, 255],
				angle: 45,
			},
		};

		renderer.updateSpec(newSpec);
		renderer.render();

		const gradientCall = calls.find((c) => c.method === "createLinearGradient");
		expect(gradientCall).toBeDefined();

		renderer.destroy();
	});

	it("handles resize correctly", () => {
		const { canvas } = createMockCanvas();
		const renderer = new EditorRenderer({
			canvas,
			spec: testSpec,
			resolveBackgroundPath: (p) => p,
		});

		renderer.resize(800, 600);

		expect(canvas.width).toBeGreaterThan(0);
		expect(canvas.height).toBeGreaterThan(0);

		renderer.destroy();
	});
});
