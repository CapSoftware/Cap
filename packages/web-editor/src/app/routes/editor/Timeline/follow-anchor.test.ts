import { describe, expect, test } from "vitest";
import { FOLLOW_STEPS, nextFollowAnchor } from "./follow-anchor";

const base = {
	anchor: null,
	position: 10,
	zoom: 16,
	playing: true,
	scrolled: false,
	zoomChanged: false,
};

describe("nextFollowAnchor", () => {
	test("lays out at the exact position until playback scrolls the view", () => {
		expect(nextFollowAnchor(base)).toBeNull();
		expect(nextFollowAnchor({ ...base, scrolled: true })).toBe(10);
	});

	test("holds the anchor for a step, then moves it on", () => {
		const step = base.zoom / FOLLOW_STEPS;
		expect(
			nextFollowAnchor({ ...base, anchor: 10, position: 10 + step / 2 }),
		).toBe(10);
		expect(nextFollowAnchor({ ...base, anchor: 10, position: 10 + step })).toBe(
			10 + step,
		);
		expect(nextFollowAnchor({ ...base, anchor: 10, position: 9.5 })).toBe(9.5);
	});

	test("drops the anchor when playback stops or the zoom changes", () => {
		expect(
			nextFollowAnchor({ ...base, anchor: 10, playing: false }),
		).toBeNull();
		expect(
			nextFollowAnchor({ ...base, anchor: 10, zoomChanged: true }),
		).toBeNull();
	});
});
