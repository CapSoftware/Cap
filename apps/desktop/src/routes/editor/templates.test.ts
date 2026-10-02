import { describe, expect, it } from "vitest";
import type { EditorProjectConfiguration } from "./context";
import {
	applyTemplate,
	defaultLookKey,
	EDITOR_TEMPLATES,
	fullSpanScene,
	lookKey,
	templateDefaultConfig,
	templateDefaultKey,
	templateLookKey,
	templateSource,
	withoutTemplateScene,
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

	it("drop only the whole-video scene a template added", () => {
		const scenes = [
			{ start: 0, end: 10, mode: "floating" as const },
			{ start: 0, end: 10, mode: "cameraOnly" as const },
			{ start: 2, end: 4, mode: "floating" as const },
		];
		expect(withoutTemplateScene(scenes, "floating", 10)).toEqual([
			{ start: 0, end: 10, mode: "cameraOnly" },
			{ start: 2, end: 4, mode: "floating" },
		]);
	});
});

// What the server stores: no camera visibility, extra fields, and object keys
// in whatever order MySQL's JSON column returns them.
const savedStyle = (config: EditorProjectConfiguration) => {
	const reversed = (value: unknown): unknown =>
		typeof value === "object" && value !== null && !Array.isArray(value)
			? Object.fromEntries(
					Object.entries(value)
						.reverse()
						.map(([key, field]) => [key, reversed(field)]),
				)
			: value;
	const { hide: _hide, ...camera } = config.camera;
	return reversed({
		version: 1,
		aspectRatio: config.aspectRatio,
		background: { ...config.background, blur: 0 },
		camera,
		cursor: { size: 100 },
	}) as Parameters<typeof defaultLookKey>[0];
};

describe("default looks", () => {
	it("recognise the template a saved default came from", () => {
		for (const template of EDITOR_TEMPLATES.filter((t) => !t.scene)) {
			const wallpaper =
				template.background.type === "wallpaper" ? "/wallpaper.jpg" : null;
			const config = templateDefaultConfig(project(), template, wallpaper);
			if (!config) throw new Error(`${template.id} has no default config`);
			expect(defaultLookKey(savedStyle(config))).toBe(
				templateDefaultKey(template, wallpaper),
			);
			for (const other of EDITOR_TEMPLATES.filter(
				(t) => !t.scene && t !== template,
			)) {
				expect(defaultLookKey(savedStyle(config))).not.toBe(
					templateDefaultKey(other, wallpaper),
				);
			}
		}
	});

	it("leave out templates whose scene can't reach a new recording", () => {
		for (const template of EDITOR_TEMPLATES.filter((t) => t.scene)) {
			expect(templateDefaultConfig(project(), template, null)).toBeNull();
		}
	});

	it("ignore camera visibility but not the look", () => {
		const config = project();
		const hidden = project();
		hidden.camera.hide = true;
		expect(defaultLookKey(hidden)).toBe(defaultLookKey(config));
		hidden.background.padding = 4;
		expect(defaultLookKey(hidden)).not.toBe(defaultLookKey(config));
	});

	it("match animated gradients whatever order their fields come back in", () => {
		const config = project();
		config.background.source = {
			type: "animatedGradient",
			config: { speed: 1, colors: ["#fff", "#000"] },
		} as unknown as EditorProjectConfiguration["background"]["source"];
		expect(defaultLookKey(savedStyle(config))).toBe(defaultLookKey(config));
	});
});
