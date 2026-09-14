import { describe, expect, it } from "vitest";
import { resolveTimelineKeyAction } from "@/app/s/[videoId]/_components/timeline/TimelineView";

describe("resolveTimelineKeyAction", () => {
	it("seeks to start (0) on bare ArrowUp and Home", () => {
		expect(resolveTimelineKeyAction("ArrowUp", false, 120, false)).toEqual({
			type: "seekTo",
			time: 0,
		});
		expect(resolveTimelineKeyAction("Home", false, 120, false)).toEqual({
			type: "seekTo",
			time: 0,
		});
	});

	it("seeks to end on bare ArrowDown and End", () => {
		expect(resolveTimelineKeyAction("ArrowDown", false, 120, false)).toEqual({
			type: "seekTo",
			time: 120,
		});
		expect(resolveTimelineKeyAction("End", false, 120, false)).toEqual({
			type: "seekTo",
			time: 120,
		});
	});

	it("handles non-finite or negative durations safely", () => {
		expect(resolveTimelineKeyAction("ArrowDown", false, Number.NaN, false)).toEqual({
			type: "seekTo",
			time: 0,
		});
		expect(resolveTimelineKeyAction("End", false, -10, false)).toEqual({
			type: "seekTo",
			time: 0,
		});
	});

	it("seeks delta on ArrowLeft and ArrowRight", () => {
		expect(resolveTimelineKeyAction("ArrowLeft", false, 120, false)).toEqual({
			type: "seekDelta",
			delta: -5,
		});
		expect(resolveTimelineKeyAction("ArrowRight", false, 120, false)).toEqual({
			type: "seekDelta",
			delta: 5,
		});
	});

	it("toggles play on Space unless focused over a branch node button", () => {
		expect(resolveTimelineKeyAction(" ", false, 120, false)).toEqual({
			type: "togglePlay",
		});
		expect(resolveTimelineKeyAction("Spacebar", false, 120, false)).toEqual({
			type: "togglePlay",
		});
		expect(resolveTimelineKeyAction(" ", false, 120, true)).toBeNull();
	});

	it("strictly ignores actions when any modifier is pressed", () => {
		expect(resolveTimelineKeyAction("ArrowUp", true, 120, false)).toBeNull();
		expect(resolveTimelineKeyAction("ArrowDown", true, 120, false)).toBeNull();
		expect(resolveTimelineKeyAction("Home", true, 120, false)).toBeNull();
		expect(resolveTimelineKeyAction("End", true, 120, false)).toBeNull();
		expect(resolveTimelineKeyAction("ArrowLeft", true, 120, false)).toBeNull();
		expect(resolveTimelineKeyAction("ArrowRight", true, 120, false)).toBeNull();
		expect(resolveTimelineKeyAction(" ", true, 120, false)).toBeNull();
	});
});
