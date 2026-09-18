import { expect, test } from "bun:test";
import {
	mapEditorImportedImages,
	registerEditorImportedImage,
	resolveEditorImportedImage,
	serializeEditorProjectSnapshot,
} from "./editor-file-mapping";

test("a desktop background picker path becomes the staged image before live update", () => {
	const temporary = "cap-web-editor://app-data/bg-1-photo.png";
	const staged = "content/images/22222222-2222-4222-8222-222222222222.png";
	registerEditorImportedImage(temporary, staged);
	const config = {
		background: { source: { type: "image", path: temporary } },
		timeline: {
			styleSegments: [
				{
					overrides: {
						background: { source: { type: "image", path: temporary } },
					},
				},
			],
			imageSegments: [{ path: staged }],
		},
	};
	const mapped = mapEditorImportedImages(config) as typeof config;
	expect(mapped.background.source.path).toBe(staged);
	expect(
		mapped.timeline.styleSegments[0]?.overrides.background.source.path,
	).toBe(staged);
	expect(mapped.timeline.imageSegments[0]?.path).toBe(staged);
	expect(config.background.source.path).toBe(temporary);
	expect(resolveEditorImportedImage(temporary)).toBe(staged);
	const draft = JSON.parse(
		serializeEditorProjectSnapshot(JSON.stringify(config)),
	) as typeof config | undefined;
	expect(draft?.background.source.path).toBe(staged);
	expect(
		draft?.timeline.styleSegments[0]?.overrides.background.source.path,
	).toBe(staged);
	expect(() =>
		registerEditorImportedImage(temporary, "/tmp/worker-local.png"),
	).toThrow();
});
