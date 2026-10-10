import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	editorWallpaperDirectory,
	mapEditorInstanceWallpaper,
	mapEditorWallpaperConfig,
} from "../../lib/editor-wallpapers";

const logical =
	"cap-web-wallpaper://assets/backgrounds/macOS/tahoe-dusk-min.jpg";

test("saved wallpaper IDs resolve to the desktop asset and survive reopening", () => {
	const original = {
		background: { source: { type: "wallpaper", path: logical }, padding: 12 },
	};
	const native = mapEditorWallpaperConfig(
		original,
		"native",
	) as typeof original;
	expect(native.background.source.path).toBe(
		join(editorWallpaperDirectory(), "macOS/tahoe-dusk-min.jpg"),
	);
	expect(mapEditorWallpaperConfig(native, "browser")).toEqual(original);
	expect(
		mapEditorInstanceWallpaper(
			{ savedProjectConfig: native, recordingDuration: 3 },
			"browser",
		),
	).toEqual({ savedProjectConfig: original, recordingDuration: 3 });
});

test("wallpaper paths reject traversal and linked files outside the asset root", async () => {
	const root = await mkdtemp(join(tmpdir(), "cap-editor-wallpaper-test-"));
	try {
		const outside = join(root, "outside.jpg");
		const category = join(root, "macOS");
		await writeFile(outside, "outside");
		await mkdir(category);
		await symlink(outside, join(category, "linked.jpg"));
		for (const path of [
			"cap-web-wallpaper://assets/backgrounds/macOS/../../outside.jpg",
			"cap-web-wallpaper://assets/backgrounds/macOS/linked.jpg",
		]) {
			expect(() =>
				mapEditorWallpaperConfig(
					{ background: { source: { type: "wallpaper", path } } },
					"native",
					root,
				),
			).toThrow();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("other background sources keep their paths unchanged", async () => {
	const root = await mkdtemp(join(tmpdir(), "cap-editor-wallpaper-test-"));
	try {
		const image = join(root, "personal.jpg");
		await writeFile(image, "personal");
		const original = { background: { source: { type: "image", path: image } } };
		expect(mapEditorWallpaperConfig(original, "native", root)).toBe(original);
		expect(mapEditorWallpaperConfig(original, "browser", root)).toBe(original);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
