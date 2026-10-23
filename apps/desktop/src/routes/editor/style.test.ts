import { describe, expect, it } from "vitest";
import type {
	BackgroundConfiguration,
	Camera,
	CursorConfiguration,
} from "~/utils/tauri";
import {
	activeStyleSegments,
	cameraOnlyPaddingAt,
	defaultStyleSegment,
	editOverlayInterval,
	resolveStyle,
	splitOverlaySegment,
	stylesRevealCamera,
} from "./style";
import { rippleDeleteAllTracks } from "./timeline-utils";

const background: BackgroundConfiguration = {
	source: { type: "color", value: [0, 0, 0] },
	blur: 0,
	padding: 0,
	rounding: 0,
	roundingType: "rounded",
	inset: 0,
	crop: null,
	displayPosition: null,
	shadow: 0,
	advancedShadow: null,
	border: null,
	frame: null,
	notch: null,
};
const camera: Camera = {
	hide: true,
	mirror: false,
	position: { x: "right", y: "bottom" },
	manualPosition: null,
	size: 20,
	zoomSize: null,
	rounding: 0,
	shadow: 0,
	advancedShadow: null,
	shape: "square",
	roundingType: "rounded",
};
const cursor: CursorConfiguration = {
	hide: false,
	hideWhenIdle: false,
	hideWhenIdleDelay: 0,
	size: 1,
	type: "auto",
	animationStyle: "smooth",
	tension: 1,
	mass: 1,
	friction: 1,
	raw: false,
	motionBlur: 0,
	useSvg: false,
};
const base = { background, camera, cursor };

describe("style resolution", () => {
	it("inherits without copying global groups into a new style", () => {
		const style = defaultStyleSegment(0, 4);
		expect(style.overrides).toEqual({
			background: null,
			camera: null,
			cursor: null,
			cameraOnlyPadding: null,
		});
		expect(resolveStyle(base, [style], 2)).toEqual(base);
	});

	it("orders lanes, starts and stable indices, replacing only opted-in groups", () => {
		const lower = defaultStyleSegment(0, 10, 0);
		lower.overrides.background = { ...background, padding: 10 };
		lower.overrides.camera = { ...camera, hide: false };
		const later = defaultStyleSegment(2, 10, 1);
		later.overrides.background = { ...background, padding: 20 };
		const earlier = defaultStyleSegment(1, 10, 1);
		earlier.overrides.background = { ...background, padding: 30 };
		const tie = defaultStyleSegment(2, 10, 1);
		tie.overrides.cursor = { ...cursor, size: 2 };
		tie.overrides.background = { ...background, padding: 40 };
		const styles = [later, lower, earlier, tie];
		expect(activeStyleSegments(styles, 3).map(({ index }) => index)).toEqual([
			1, 2, 0, 3,
		]);
		const resolved = resolveStyle(base, styles, 3);
		expect(resolved.background.padding).toBe(40);
		expect(resolved.camera.hide).toBe(false);
		expect(resolved.cursor.size).toBe(2);
		expect(base.background.padding).toBe(0);
		expect(base.camera.hide).toBe(true);
	});

	it("ignores disabled and invalid intervals and uses an exclusive end", () => {
		const disabled = { ...defaultStyleSegment(0, 4), enabled: false };
		const styles = [
			disabled,
			defaultStyleSegment(-1, 5),
			defaultStyleSegment(4, 4),
			defaultStyleSegment(0, Number.NaN),
			defaultStyleSegment(0, 4),
		];
		expect(activeStyleSegments(styles, 0).map(({ index }) => index)).toEqual([
			4,
		]);
		expect(activeStyleSegments(styles, 4)).toEqual([]);
		expect(activeStyleSegments(styles, Number.NaN)).toEqual([]);
	});

	it("resolves finite camera-only padding in precedence order and clamps percent", () => {
		const styles = [defaultStyleSegment(0, 10), defaultStyleSegment(0, 10, 1)];
		styles[0].overrides.cameraOnlyPadding = 10;
		styles[1].overrides.cameraOnlyPadding = Number.NaN;
		expect(cameraOnlyPaddingAt(styles, 1)).toBe(10);
		styles[1].overrides.cameraOnlyPadding = 200;
		expect(cameraOnlyPaddingAt(styles, 1)).toBe(40);
		styles[1].overrides.cameraOnlyPadding = -5;
		expect(cameraOnlyPaddingAt(styles, 1)).toBe(0);
		expect(cameraOnlyPaddingAt(styles, 11)).toBe(0);
	});

	it("keeps camera scenes available independently of the playhead", () => {
		const style = defaultStyleSegment(8, 10);
		style.overrides.camera = { ...camera, hide: false };
		expect(stylesRevealCamera([style])).toBe(true);
		expect(stylesRevealCamera([{ ...style, enabled: false }])).toBe(false);
		expect(stylesRevealCamera([{ ...style, end: 7 }])).toBe(false);
		expect(stylesRevealCamera([{ ...style, start: -1 }])).toBe(false);
	});
});

describe("overlay timeline edits", () => {
	it("splits nested style state independently and rejects tiny fragments", () => {
		const style = defaultStyleSegment(2, 8);
		style.overrides.background = structuredClone(background);
		const parts = splitOverlaySegment(style, 4);
		expect(parts?.map(({ start, end }) => [start, end])).toEqual([
			[2, 4],
			[4, 8],
		]);
		if (!parts?.[0].overrides.background)
			throw new Error("Expected split background");
		parts[0].overrides.background.padding = 30;
		expect(parts[1].overrides.background?.padding).toBe(0);
		expect(style.overrides.background.padding).toBe(0);
		expect(splitOverlaySegment(style, 2.01)).toBeNull();
		expect(splitOverlaySegment(style, Number.NaN)).toBeNull();
	});

	it("clamps dragging and both trim edges against neighbours", () => {
		const segment = { start: 3, end: 6 };
		expect(editOverlayInterval(segment, -20, "move", 1, 10)).toEqual({
			start: 1,
			end: 4,
		});
		expect(editOverlayInterval(segment, 20, "move", 1, 10)).toEqual({
			start: 7,
			end: 10,
		});
		expect(editOverlayInterval(segment, -20, "start", 1, 10)).toEqual({
			start: 1,
			end: 6,
		});
		expect(editOverlayInterval(segment, 20, "start", 1, 10).start).toBeCloseTo(
			5.95,
		);
		expect(editOverlayInterval(segment, -20, "end", 1, 10).end).toBeCloseTo(
			3.05,
		);
		expect(editOverlayInterval(segment, 20, "end", 1, 10).end).toBe(10);
	});

	it("retimes styles and images in output time when deleting through a text hold", () => {
		const timeline = {
			segments: [{ start: 0, end: 10, timescale: 1 }],
			textSegments: [
				{ start: 2, end: 4, enabled: true, layout: "fullscreen" as const },
			],
			styleSegments: [defaultStyleSegment(8, 9)],
			imageSegments: [{ start: 8, end: 9, path: "content/images/example.png" }],
		};
		rippleDeleteAllTracks(timeline, 1, 5);
		expect(timeline.textSegments).toEqual([]);
		expect(timeline.styleSegments[0]).toMatchObject({ start: 2, end: 3 });
		expect(timeline.imageSegments[0]).toEqual({
			start: 2,
			end: 3,
			path: "content/images/example.png",
		});
	});
});
