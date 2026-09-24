import { expect, test } from "bun:test";
import { browserFrameLayout } from "./browser-frame-layout";

test("browser canvas layout mirrors the native frame layout event", () => {
	const layout = browserFrameLayout(
		new Float64Array([100, 50, 1180, 670, 900, 400, 1200, 700, 1280, 720]),
	);
	expect(layout).toEqual({
		display: [100, 50, 1180, 670],
		camera: [900, 400, 1200, 700],
		output_width: 1280,
		output_height: 720,
	});
	expect(
		browserFrameLayout(
			new Float64Array([
				0,
				0,
				1280,
				720,
				Number.NaN,
				Number.NaN,
				Number.NaN,
				Number.NaN,
				1280,
				720,
			]),
		).camera,
	).toBeNull();
	expect(() => browserFrameLayout(new Float64Array(10))).toThrow();
});
