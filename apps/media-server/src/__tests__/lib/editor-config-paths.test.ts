import { expect, test } from "bun:test";
import { join } from "node:path";
import {
	mapEditorConfigPaths,
	mapEditorInstanceConfigPaths,
} from "../../lib/editor-config-paths";
import { editorWallpaperDirectory } from "../../lib/editor-wallpapers";

const projectPath = "/tmp/cap-editor-config-test.cap";
const image = "content/images/22222222-2222-4222-8222-222222222222.png";
const video = "content/videos/33333333-3333-4333-8333-333333333333.mp4";
const audio = "assets/audio/import-44444444-4444-4444-8444-444444444444.mp3";
const wallpaper =
	"cap-web-wallpaper://assets/backgrounds/macOS/tahoe-dusk-min.jpg";

test("web project paths resolve only staged media and portable wallpapers", () => {
	const original = {
		background: { source: { type: "wallpaper", path: wallpaper } },
		timeline: {
			audioSegments: [{ path: audio }],
			imageSegments: [{ path: image }],
			videoSegments: [{ path: video }],
			styleSegments: [
				{
					overrides: {
						background: { source: { type: "wallpaper", path: wallpaper } },
					},
				},
			],
		},
	};
	const native = mapEditorConfigPaths(
		original,
		"native",
		projectPath,
	) as typeof original;
	const nativeWallpaper = join(
		editorWallpaperDirectory(),
		"macOS/tahoe-dusk-min.jpg",
	);
	expect(native.background.source.path).toBe(nativeWallpaper);
	expect(
		native.timeline.styleSegments[0]?.overrides.background.source.path,
	).toBe(nativeWallpaper);
	expect(native.timeline.audioSegments[0]?.path).toBe(audio);
	expect(native.timeline.imageSegments[0]?.path).toBe(image);
	expect(native.timeline.videoSegments[0]?.path).toBe(video);
	expect(mapEditorConfigPaths(native, "browser", projectPath)).toEqual(
		original,
	);
	expect(
		mapEditorInstanceConfigPaths(
			{ savedProjectConfig: native, recordingDuration: 4 },
			"browser",
			projectPath,
		),
	).toEqual({ savedProjectConfig: original, recordingDuration: 4 });
});

test("background images use a project-local native path and a relative saved path", () => {
	const original = { background: { source: { type: "image", path: image } } };
	const native = mapEditorConfigPaths(
		original,
		"native",
		projectPath,
	) as typeof original;
	expect(native.background.source.path).toBe(join(projectPath, image));
	expect(mapEditorConfigPaths(native, "browser", projectPath)).toEqual(
		original,
	);
});

test("a chosen desktop wallpaper remains portable across editor sessions", () => {
	const original = {
		background: { source: { type: "wallpaper", path: image } },
	};
	const native = mapEditorConfigPaths(
		original,
		"native",
		projectPath,
	) as typeof original;
	expect(native.background.source.path).toBe(join(projectPath, image));
	expect(mapEditorConfigPaths(native, "browser", projectPath)).toEqual(
		original,
	);
});

test("native configuration rejects worker-local and traversing media paths", () => {
	for (const [track, path] of [
		["audioSegments", "/tmp/secret.mp3"],
		["imageSegments", "content/images/../../secret.png"],
		["videoSegments", "content/videos/../../secret.mp4"],
	]) {
		expect(() =>
			mapEditorConfigPaths(
				{ timeline: { [track]: [{ path }] } },
				"native",
				projectPath,
			),
		).toThrow();
	}
	for (const source of [
		{ type: "wallpaper", path: "/tmp/secret.jpg" },
		{ type: "image", path: "/tmp/secret.png" },
	]) {
		expect(() =>
			mapEditorConfigPaths({ background: { source } }, "native", projectPath),
		).toThrow();
	}
});
