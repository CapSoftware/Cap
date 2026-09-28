import { describe, expect, it } from "vitest";
import type { EditorProjectConfiguration } from "./context";
import {
	applyTemplate,
	EDITOR_TEMPLATES,
	fullSpanScene,
	lookKey,
	templateLookKey,
	templateSource,
} from "./templates";

const project = () =>
	({
		aspectRatio: null,
		background: {
			source: { type: "color", value: [255, 255, 255] },
			padding: 0,
			rounding: 0,
			shadow: 0,
		},
		camera: {
			hide: false,
			position: { x: "left", y: "top" },
			size: 30,
			rounding: 100,
			shape: "square",
		},
		timeline: { sceneSegments: [{ start: 2, end: 4, mode: "cameraOnly" }] },
	}) as unknown as EditorProjectConfiguration;

const currentLook = (config: EditorProjectConfiguration) =>
	lookKey(config, fullSpanScene(config.timeline?.sceneSegments, 10));

describe("template looks", () => {
	it("recognise a template until the project changes", () => {
		for (const template of EDITOR_TEMPLATES) {
			const config = project();
			const wallpaper =
				template.background.type === "wallpaper" ? "/wallpaper.jpg" : null;
			applyTemplate(
				config,
				template,
				templateSource(template.background, wallpaper),
				10,
			);
			expect(currentLook(config)).toBe(templateLookKey(template, wallpaper));
			config.background.padding += 1;
			expect(currentLook(config)).not.toBe(
				templateLookKey(template, wallpaper),
			);
		}
	});

	it("tell presets apart from a template's whole-video scene", () => {
		const config = project();
		expect(currentLook(config)).toBe(lookKey(config, null));
		const sideBySide = EDITOR_TEMPLATES.find((t) => t.scene === "floating");
		if (!sideBySide) throw new Error("Side by side template is missing");
		applyTemplate(
			config,
			sideBySide,
			templateSource(sideBySide.background, "/wallpaper.jpg"),
			10,
		);
		expect(currentLook(config)).not.toBe(lookKey(config, null));
		expect(config.timeline?.sceneSegments).toContainEqual({
			start: 2,
			end: 4,
			mode: "cameraOnly",
		});
	});
});
