import { describe, expect, it } from "vitest";
import { DEFAULT_TIMELINE_HEIGHT, editorVerticalLayout } from "./editor-layout";

describe("editor startup layout", () => {
	it("preserves player space when the startup split is constrained", () => {
		for (const height of [360, 560, 720, 1000]) {
			const loading = editorVerticalLayout(height, DEFAULT_TIMELINE_HEIGHT);
			expect(loading.timelineHeight).toBeLessThanOrEqual(
				DEFAULT_TIMELINE_HEIGHT,
			);
			expect(
				loading.timelineHeight + loading.minPlayerHeight,
			).toBeLessThanOrEqual(height);
		}
	});
	it("keeps the saved user split when it fits", () => {
		expect(editorVerticalLayout(900, 410).timelineHeight).toBe(410);
	});
	it("handles a collapsed window without negative dimensions", () => {
		expect(editorVerticalLayout(0, 260)).toEqual({
			minPlayerHeight: 0,
			timelineHeight: 0,
		});
	});
});
