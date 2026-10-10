import {
	applyDefaultStyle,
	extractDefaultStyle,
	parseDefaultStyle,
} from "@cap/editor-cap-bundle/default-style";
import { describe, expect, it } from "vitest";

const styled = {
	aspectRatio: "wide",
	background: {
		source: { type: "gradient", from: [1, 2, 3], to: [4, 5, 6] },
		padding: 12,
		rounding: 24,
		shadow: 60,
		crop: { position: { x: 10, y: 10 }, size: { x: 100, y: 100 } },
		displayPosition: { x: 0.4, y: 0.5 },
	},
	camera: { hide: true, position: { x: "left", y: "top" }, size: 30 },
	cursor: { size: 150, type: "pointer" },
	timeline: { segments: [{ start: 0, end: 5 }] },
	captions: { segments: [] },
	colorCorrection: { exposure: 1 },
};

describe("default style", () => {
	it("keeps the look and drops what belongs to one recording", () => {
		expect(extractDefaultStyle(styled)).toEqual({
			version: 1,
			aspectRatio: "wide",
			background: {
				source: { type: "gradient", from: [1, 2, 3], to: [4, 5, 6] },
				padding: 12,
				rounding: 24,
				shadow: 60,
			},
			camera: { position: { x: "left", y: "top" }, size: 30 },
			cursor: { size: 150, type: "pointer" },
		});
	});

	it("leaves out project-local background images", () => {
		const style = extractDefaultStyle({
			background: {
				source: { type: "image", path: "content/images/a.png" },
				padding: 4,
			},
		});
		expect(style?.background).toEqual({ padding: 4 });
	});

	it("rejects styles it cannot trust", () => {
		expect(parseDefaultStyle(null)).toBeNull();
		expect(parseDefaultStyle({ version: 2, background: {} })).toBeNull();
		expect(extractDefaultStyle("config")).toBeNull();
		expect(
			extractDefaultStyle({ cursor: { blob: "x".repeat(70 * 1024) } }),
		).toBeNull();
	});

	it("lays the style over a project without touching its recording", () => {
		const style = extractDefaultStyle(styled);
		if (!style) throw new Error("style expected");
		const fresh = {
			aspectRatio: null,
			background: {
				source: { type: "wallpaper", path: "macOS/sequoia-dark" },
				padding: 0,
				rounding: 0,
				crop: { position: { x: 1, y: 2 }, size: { x: 3, y: 4 } },
			},
			camera: {
				hide: false,
				position: { x: "right", y: "bottom" },
				mirror: false,
			},
			cursor: { size: 100, hideWhenIdle: true },
			timeline: { segments: [{ start: 0, end: 9 }] },
		};
		const next = applyDefaultStyle(fresh, style);
		expect(next.aspectRatio).toBe("wide");
		expect(next.background).toEqual({
			source: { type: "gradient", from: [1, 2, 3], to: [4, 5, 6] },
			padding: 12,
			rounding: 24,
			shadow: 60,
			crop: { position: { x: 1, y: 2 }, size: { x: 3, y: 4 } },
		});
		expect(next.camera).toEqual({
			hide: false,
			position: { x: "left", y: "top" },
			size: 30,
			mirror: false,
		});
		expect(next.cursor).toEqual({
			size: 150,
			type: "pointer",
			hideWhenIdle: true,
		});
		expect(next.timeline).toBe(fresh.timeline);
		expect(fresh.background.padding).toBe(0);
	});
});
