import { expect, test } from "vitest";
import {
	backgroundImagePath,
	styleBackgroundImagePaths,
} from "./browser-background-preload";

const image = (path: string) => ({ source: { type: "image", path } });

test("enabled style segments' background images are collected once each", () => {
	const config = {
		background: image("bg/main.png"),
		timeline: {
			styleSegments: [
				{ overrides: { background: image("bg/focus.png") } },
				{
					overrides: {
						background: { source: { type: "wallpaper", path: "macOS/dawn" } },
					},
				},
				{ overrides: { background: image("bg/focus.png") } },
				{ enabled: false, overrides: { background: image("bg/off.png") } },
				{ overrides: { background: { source: { type: "color" } } } },
				{ overrides: { camera: { hide: true } } },
				{ overrides: { background: image("") } },
				null,
			],
		},
	};
	expect(backgroundImagePath(config)).toBe("bg/main.png");
	expect(styleBackgroundImagePaths(config)).toEqual([
		"bg/focus.png",
		"macOS/dawn",
	]);
});

test("a project without style segments has no style backgrounds", () => {
	expect(styleBackgroundImagePaths({})).toEqual([]);
	expect(
		styleBackgroundImagePaths({ timeline: { styleSegments: {} } }),
	).toEqual([]);
});
