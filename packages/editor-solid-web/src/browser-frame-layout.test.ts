import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	BrowserVisualConfig,
	default_project_config_json,
	initSync,
} from "../renderer/pkg/cap_editor_browser_renderer.js";
import { browserFrameLayout } from "./browser-frame-layout";

test("browser canvas layout matches the renderer uniforms used for direct manipulation", () => {
	initSync({
		module: readFileSync(
			resolve(
				import.meta.dir,
				"../renderer/pkg/cap_editor_browser_renderer_bg.wasm",
			),
		),
	});
	const config = JSON.parse(default_project_config_json());
	config.background.displayPosition = { x: 0.6, y: 0.5 };
	config.camera.manualPosition = { x: 0.5, y: 0.5 };
	const visual = new BrowserVisualConfig(JSON.stringify(config));
	try {
		const display = visual.layer_uniforms(
			1280,
			720,
			1920,
			1080,
			false,
			0,
			false,
		);
		const camera = visual.layer_uniforms(1280, 720, 640, 480, true, 0, false);
		const layout = browserFrameLayout(display, camera, 1280, 720);
		expect(layout.output_width).toBe(1280);
		expect(layout.output_height).toBe(720);
		expect((layout.display[0] + layout.display[2]) / 2).toBeCloseTo(768);
		const cameraBounds = layout.camera;
		if (!cameraBounds) throw new Error("Camera layout is unavailable");
		expect((cameraBounds[0] + cameraBounds[2]) / 2).toBeCloseTo(640);
		expect((cameraBounds[1] + cameraBounds[3]) / 2).toBeCloseTo(360);
		expect(browserFrameLayout(display, null, 1280, 720).camera).toBeNull();
	} finally {
		visual.free();
	}
});
