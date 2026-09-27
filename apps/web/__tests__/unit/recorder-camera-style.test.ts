import {
	applyDefaultStyle,
	parseRecorderCamera,
	withRecorderCamera,
} from "@cap/editor-cap-bundle/default-style";
import { describe, expect, it } from "vitest";

const layout = {
	version: 1,
	position: { x: "left", y: "top" },
	size: 40,
	mirror: true,
	shape: "round",
} as const;

describe("recorder camera layout", () => {
	it("rejects layouts the editor can't place", () => {
		expect(parseRecorderCamera({ ...layout, size: 90 })).toBeNull();
		expect(
			parseRecorderCamera({ ...layout, position: { x: "middle", y: "top" } }),
		).toBeNull();
		expect(parseRecorderCamera({ ...layout, shape: "hexagon" })).toBeNull();
		expect(parseRecorderCamera(layout)).toEqual(layout);
	});

	it("places the camera over a saved style without dropping its look", () => {
		const style = withRecorderCamera(
			{
				version: 1,
				camera: { shadow: 10, position: { x: "right", y: "bottom" } },
			},
			layout,
		);
		expect(style?.camera).toMatchObject({
			shadow: 10,
			position: { x: "left", y: "top" },
			manualPosition: null,
			size: 40,
			mirror: true,
			shape: "square",
			rounding: 100,
		});
	});

	it("maps full frame to the camera's own aspect", () => {
		const style = withRecorderCamera(null, { ...layout, shape: "full" });
		expect(style?.camera).toMatchObject({ shape: "source", rounding: 25 });
	});

	it("leaves the style alone without a layout", () => {
		const saved = { version: 1 as const, cursor: { size: 2 } };
		expect(withRecorderCamera(saved, null)).toBe(saved);
	});

	it("lands in the project the editor opens with", () => {
		const project = applyDefaultStyle(
			{
				camera: {
					hide: false,
					size: 30,
					position: { x: "right", y: "bottom" },
				},
			},
			withRecorderCamera(null, layout) ?? { version: 1 },
		);
		expect(project.camera).toMatchObject({
			hide: false,
			size: 40,
			mirror: true,
			position: { x: "left", y: "top" },
		});
	});
});
