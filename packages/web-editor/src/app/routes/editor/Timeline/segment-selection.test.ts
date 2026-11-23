import { describe, expect, it } from "vitest";
import { nextSegmentSelection } from "./segment-selection";

const plain = { shiftKey: false, ctrlKey: false, metaKey: false };

describe("nextSegmentSelection", () => {
	it("selects only the chosen segment", () => {
		expect(
			nextSegmentSelection(
				{ type: "text", indices: [0, 1] },
				{ type: "text", index: 3 },
				plain,
			),
		).toEqual({ type: "text", indices: [3] });
	});

	it("replaces a selection of another kind", () => {
		expect(
			nextSegmentSelection(
				{ type: "transition", index: 2 },
				{ type: "clip", index: 1 },
				{ ...plain, metaKey: true },
			),
		).toEqual({ type: "clip", indices: [1] });
		expect(
			nextSegmentSelection(
				{ type: "zoom", indices: [4] },
				{ type: "audio", index: 0 },
				{ ...plain, shiftKey: true },
			),
		).toEqual({ type: "audio", indices: [0] });
	});

	it("selects the range from the last selected segment with Shift", () => {
		expect(
			nextSegmentSelection(
				{ type: "mask", indices: [1, 5] },
				{ type: "mask", index: 2 },
				{ ...plain, shiftKey: true },
			),
		).toEqual({ type: "mask", indices: [2, 3, 4, 5] });
	});

	it("toggles a segment with Cmd or Ctrl", () => {
		expect(
			nextSegmentSelection(
				{ type: "scene", indices: [1] },
				{ type: "scene", index: 3 },
				{ ...plain, ctrlKey: true },
			),
		).toEqual({ type: "scene", indices: [1, 3] });
		expect(
			nextSegmentSelection(
				{ type: "scene", indices: [1, 3] },
				{ type: "scene", index: 1 },
				{ ...plain, metaKey: true },
			),
		).toEqual({ type: "scene", indices: [3] });
		expect(
			nextSegmentSelection(
				{ type: "scene", indices: [3] },
				{ type: "scene", index: 3 },
				{ ...plain, metaKey: true },
			),
		).toBeNull();
	});

	it("starts a selection from nothing", () => {
		expect(
			nextSegmentSelection(
				null,
				{ type: "3d", index: 0 },
				{
					...plain,
					shiftKey: true,
				},
			),
		).toEqual({ type: "3d", indices: [0] });
	});
});
