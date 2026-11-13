import { describe, expect, it } from "vitest";
import { developerVideoPlayback } from "@/lib/developer-video-params";

const DEFAULTS = {
	autoPlay: false,
	muted: false,
	loop: false,
	controls: true,
	startAt: 0,
};

describe("developerVideoPlayback", () => {
	it("plays a plain embed with its controls, sound and no loop", () => {
		expect(developerVideoPlayback({}, "embed")).toEqual(DEFAULTS);
	});

	it("reads every embed parameter", () => {
		expect(
			developerVideoPlayback(
				{ autoplay: "1", muted: "1", loop: "1", controls: "0", t: "90" },
				"embed",
			),
		).toEqual({
			autoPlay: true,
			muted: true,
			loop: true,
			controls: false,
			startAt: 90,
		});
	});

	it("accepts true and false as well as 1 and 0", () => {
		expect(
			developerVideoPlayback({ autoplay: "true", controls: "false" }, "embed"),
		).toMatchObject({ autoPlay: true, controls: false });
		expect(
			developerVideoPlayback({ autoplay: "0", controls: "1" }, "embed"),
		).toMatchObject({ autoPlay: false, controls: true });
	});

	it.each([
		["12.5", 12.5],
		["0", 0],
		["007", 7],
		["999999", 999999],
	])("starts at %s seconds", (t, startAt) => {
		expect(developerVideoPlayback({ t }, "embed").startAt).toBe(startAt);
	});

	it.each([
		"-5",
		"1e3",
		"abc",
		"1m30s",
		"90s",
		" 90",
		"",
		"NaN",
		"Infinity",
		"1234567",
		"1.2345",
		"0x10",
	])("ignores the malformed start time %j", (t) => {
		expect(developerVideoPlayback({ t }, "embed").startAt).toBe(0);
	});

	it.each(["yes", "on", "2", "", "TRUE", " 1", "<script>"])(
		"ignores the unknown switch value %j",
		(value) => {
			expect(
				developerVideoPlayback(
					{ autoplay: value, muted: value, loop: value, controls: value },
					"embed",
				),
			).toEqual(DEFAULTS);
		},
	);

	it("ignores parameters it does not know", () => {
		expect(
			developerVideoPlayback(
				{ speed: "2", start: "30", autoPlay: "1" },
				"embed",
			),
		).toEqual(DEFAULTS);
	});

	it("takes the first value when a parameter is repeated", () => {
		expect(
			developerVideoPlayback({ t: ["30", "60"], loop: ["1", "0"] }, "embed"),
		).toMatchObject({ startAt: 30, loop: true });
		expect(
			developerVideoPlayback({ t: ["x", "60"], muted: [] }, "embed"),
		).toEqual(DEFAULTS);
	});

	it("takes only the start time on the share page", () => {
		expect(
			developerVideoPlayback(
				{ autoplay: "1", muted: "1", loop: "1", controls: "0", t: "42" },
				"share",
			),
		).toEqual({ ...DEFAULTS, startAt: 42 });
	});
});
