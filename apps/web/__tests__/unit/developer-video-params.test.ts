import { describe, expect, it } from "vitest";
import {
	cappedPlaylistUrl,
	developerVideoPlayback,
} from "@/lib/developer-video-params";

const DEFAULTS = {
	autoPlay: false,
	muted: false,
	loop: false,
	controls: true,
	captions: false,
	startAt: 0,
	accentColor: null,
	radius: 0,
	maxQuality: null,
	poster: true,
	keyboard: true,
	events: true,
	qualityMenu: true,
	speedMenu: true,
	pip: true,
	fullscreen: true,
};

describe("developerVideoPlayback", () => {
	it("plays a plain embed with its controls, sound and no loop", () => {
		expect(developerVideoPlayback({}, "embed")).toEqual(DEFAULTS);
	});

	it("reads every embed parameter", () => {
		expect(
			developerVideoPlayback(
				{
					autoplay: "1",
					muted: "1",
					loop: "1",
					controls: "0",
					captions: "1",
					t: "90",
				},
				"embed",
			),
		).toEqual({
			...DEFAULTS,
			autoPlay: true,
			muted: true,
			loop: true,
			controls: false,
			captions: true,
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
					{
						autoplay: value,
						muted: value,
						loop: value,
						controls: value,
						captions: value,
					},
					"embed",
				),
			).toEqual(DEFAULTS);
		},
	);

	it("keeps captions off unless the embed asks for them", () => {
		expect(developerVideoPlayback({}, "embed").captions).toBe(false);
		expect(developerVideoPlayback({ captions: "0" }, "embed").captions).toBe(
			false,
		);
		expect(
			developerVideoPlayback({ captions: "false" }, "embed").captions,
		).toBe(false);
		expect(developerVideoPlayback({ captions: "1" }, "embed").captions).toBe(
			true,
		);
		expect(developerVideoPlayback({ captions: "true" }, "embed").captions).toBe(
			true,
		);
		expect(
			developerVideoPlayback({ captions: ["1", "0"] }, "embed").captions,
		).toBe(true);
		expect(developerVideoPlayback({ captions: "en" }, "embed").captions).toBe(
			false,
		);
	});

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
				{
					autoplay: "1",
					muted: "1",
					loop: "1",
					controls: "0",
					captions: "1",
					t: "42",
				},
				"share",
			),
		).toEqual({ ...DEFAULTS, startAt: 42, events: false });
	});

	it("reads every look and feel parameter", () => {
		expect(
			developerVideoPlayback(
				{
					color: "3B82F6",
					radius: "12",
					quality: "720",
					poster: "0",
					keyboard: "0",
					quality_menu: "0",
					speed_menu: "0",
					pip: "0",
					fullscreen: "0",
				},
				"embed",
			),
		).toEqual({
			...DEFAULTS,
			accentColor: "#3b82f6",
			radius: 12,
			maxQuality: 720,
			poster: false,
			keyboard: false,
			qualityMenu: false,
			speedMenu: false,
			pip: false,
			fullscreen: false,
		});
	});

	it.each([
		["3b82f6", "#3b82f6"],
		["#3b82f6", "#3b82f6"],
		["F80", "#ff8800"],
		["#abc", "#aabbcc"],
	])("takes the accent colour %j", (color, accentColor) => {
		expect(developerVideoPlayback({ color }, "embed").accentColor).toBe(
			accentColor,
		);
	});

	it.each([
		"red",
		"#12345",
		"1234567",
		"#3b82f6;background:url(x)",
		"3b82f6</style><script>alert(1)</script>",
		"var(--x)",
		"#3b82f6 ",
		"%233b82f6",
		"",
		"#",
		"rgb(0,0,0)",
		"expression(alert(1))",
	])("ignores the hostile or malformed colour %j", (color) => {
		expect(developerVideoPlayback({ color }, "embed").accentColor).toBeNull();
	});

	it.each([
		["0", 0],
		["8", 8],
		["24", 24],
		["99", 24],
		["-4", 0],
		["12px", 0],
		["1.5", 0],
		["100", 0],
		["", 0],
		["12;}", 0],
	])("reads the corner radius %j as %d px", (radius, expected) => {
		expect(developerVideoPlayback({ radius }, "embed").radius).toBe(expected);
	});

	it.each([
		["720", 720],
		["720p", 720],
		["1080P", 1080],
		["2160", 2160],
		["360", 360],
		["99", null],
		["9999", null],
		["720px", null],
		["auto", null],
		["-720", null],
		["720&max=1", null],
		["", null],
	])("reads the quality cap %j as %s", (quality, expected) => {
		expect(developerVideoPlayback({ quality }, "embed").maxQuality).toBe(
			expected,
		);
	});

	it("hides only the menus and buttons that are switched off", () => {
		expect(
			developerVideoPlayback(
				{ quality_menu: "0", speed_menu: "1", pip: "yes", fullscreen: "false" },
				"embed",
			),
		).toMatchObject({
			qualityMenu: false,
			speedMenu: true,
			pip: true,
			fullscreen: false,
		});
	});

	it("keeps the look and feel parameters to the embed", () => {
		expect(
			developerVideoPlayback(
				{ color: "f00", radius: "8", quality: "720", poster: "0", pip: "0" },
				"share",
			),
		).toMatchObject({
			accentColor: null,
			radius: 0,
			maxQuality: null,
			poster: true,
			pip: true,
		});
	});
});

describe("cappedPlaylistUrl", () => {
	const MASTER = "https://web.example/api/developer/playback/abc/master.m3u8";

	it("leaves the playlist alone without a cap", () => {
		expect(cappedPlaylistUrl(MASTER, null)).toBe(MASTER);
	});

	it("asks the playback route for renditions up to the cap", () => {
		expect(cappedPlaylistUrl(MASTER, 720)).toBe(`${MASTER}?max=720`);
		expect(cappedPlaylistUrl(`${MASTER}?max=1080`, 720)).toBe(
			`${MASTER}?max=720`,
		);
	});
});
