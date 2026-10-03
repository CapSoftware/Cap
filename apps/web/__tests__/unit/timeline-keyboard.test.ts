import { describe, expect, it } from "vitest";
import {
	isIgnoredTimelineKeyboardTarget,
	resolveTimelineKeyAction,
} from "@/app/s/[videoId]/_components/timeline/TimelineView";

describe("resolveTimelineKeyAction", () => {
	it("seeks to start (0) on bare ArrowUp and Home when not focused on slider", () => {
		expect(resolveTimelineKeyAction("ArrowUp", false, 120, false, false)).toEqual({
			type: "seekTo",
			time: 0,
		});
		expect(resolveTimelineKeyAction("Home", false, 120, false, false)).toEqual({
			type: "seekTo",
			time: 0,
		});
	});

	it("seeks to end on bare ArrowDown and End when not focused on slider", () => {
		expect(resolveTimelineKeyAction("ArrowDown", false, 120, false, false)).toEqual({
			type: "seekTo",
			time: 120,
		});
		expect(resolveTimelineKeyAction("End", false, 120, false, false)).toEqual({
			type: "seekTo",
			time: 120,
		});
	});

	it("steps incrementally on ArrowUp/Down/Left/Right when focused on ARIA slider per accessibility guidelines", () => {
		// ArrowUp increments slider
		expect(resolveTimelineKeyAction("ArrowUp", false, 120, false, true)).toEqual({
			type: "seekDelta",
			delta: 5,
		});
		// ArrowDown decrements slider
		expect(resolveTimelineKeyAction("ArrowDown", false, 120, false, true)).toEqual({
			type: "seekDelta",
			delta: -5,
		});
		// ArrowRight increments slider
		expect(resolveTimelineKeyAction("ArrowRight", false, 120, false, true)).toEqual({
			type: "seekDelta",
			delta: 5,
		});
		// ArrowLeft decrements slider
		expect(resolveTimelineKeyAction("ArrowLeft", false, 120, false, true)).toEqual({
			type: "seekDelta",
			delta: -5,
		});
		// Home/End on slider still jump to extremes
		expect(resolveTimelineKeyAction("Home", false, 120, false, true)).toEqual({
			type: "seekTo",
			time: 0,
		});
		expect(resolveTimelineKeyAction("End", false, 120, false, true)).toEqual({
			type: "seekTo",
			time: 120,
		});
	});

	it("handles non-finite or negative durations safely", () => {
		expect(resolveTimelineKeyAction("ArrowDown", false, Number.NaN, false, false)).toEqual({
			type: "seekTo",
			time: 0,
		});
		expect(resolveTimelineKeyAction("End", false, -10, false, false)).toEqual({
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

describe("isIgnoredTimelineKeyboardTarget", () => {
	it("returns false for null target or generic divs", () => {
		expect(isIgnoredTimelineKeyboardTarget(null)).toBe(false);
		const div = document.createElement("div");
		expect(isIgnoredTimelineKeyboardTarget(div)).toBe(false);
	});

	it("returns true for input, textarea, select, contenteditable, and listbox/menu roles", () => {
		const input = document.createElement("input");
		expect(isIgnoredTimelineKeyboardTarget(input)).toBe(true);

		const textarea = document.createElement("textarea");
		expect(isIgnoredTimelineKeyboardTarget(textarea)).toBe(true);

		const select = document.createElement("select");
		expect(isIgnoredTimelineKeyboardTarget(select)).toBe(true);

		const editable = document.createElement("div");
		editable.contentEditable = "true";
		expect(isIgnoredTimelineKeyboardTarget(editable)).toBe(true);

		const listbox = document.createElement("div");
		listbox.setAttribute("role", "listbox");
		expect(isIgnoredTimelineKeyboardTarget(listbox)).toBe(true);

		const menu = document.createElement("div");
		menu.setAttribute("role", "menu");
		expect(isIgnoredTimelineKeyboardTarget(menu)).toBe(true);
	});
});
