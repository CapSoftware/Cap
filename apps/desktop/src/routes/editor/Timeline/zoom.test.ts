import { describe, expect, it } from "vitest";
import { pinchZoomFactor, sliderToZoom, zoomToSlider } from "./zoom";

describe("timeline zoom", () => {
	it("pinching out widens the view and pinching in narrows it", () => {
		expect(pinchZoomFactor(10)).toBeGreaterThan(1);
		expect(pinchZoomFactor(-10)).toBeLessThan(1);
		expect(pinchZoomFactor(0)).toBe(1);
	});

	it("caps a single mouse wheel notch", () => {
		expect(pinchZoomFactor(1000)).toBe(pinchZoomFactor(50));
		expect(pinchZoomFactor(-1000)).toBe(pinchZoomFactor(-50));
	});

	it("crosses from 3 seconds to 2 hours in a few pinches", () => {
		let zoom = 3;
		let events = 0;
		while (zoom < 7200) {
			zoom *= pinchZoomFactor(10);
			events++;
		}
		expect(events).toBeLessThan(80);
	});

	it("maps the slider logarithmically and back", () => {
		expect(zoomToSlider(7200, 3, 7200)).toBe(0);
		expect(zoomToSlider(3, 3, 7200)).toBe(1);
		expect(sliderToZoom(0, 3, 7200)).toBeCloseTo(7200);
		expect(sliderToZoom(1, 3, 7200)).toBeCloseTo(3);
		for (const zoom of [3, 10, 60, 600, 7200]) {
			expect(sliderToZoom(zoomToSlider(zoom, 3, 7200), 3, 7200)).toBeCloseTo(
				zoom,
			);
		}
		expect(zoomToSlider(Math.sqrt(3 * 7200), 3, 7200)).toBeCloseTo(0.5);
	});

	it("handles a recording shorter than the closest zoom", () => {
		expect(zoomToSlider(2, 3, 2)).toBe(1);
		expect(sliderToZoom(0.4, 3, 2)).toBe(2);
	});
});
