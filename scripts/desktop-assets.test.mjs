import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { collect, RELEASE_BASE, releaseName, render } from "./desktop-assets.mjs";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const gpui = path.join(repoRoot, "apps", "desktop-gpui");

test("the manifest describes the files in the repository", async () => {
	const current = await readFile(
		path.join(gpui, "assets", "asset-manifest.json"),
		"utf8",
	);
	assert.equal(current.replaceAll("\r\n", "\n"), render(await collect()));
});

test("release names are flat and unique", async () => {
	const { wallpapers, music } = await collect();
	const names = [
		...wallpapers.map((item) => releaseName("wallpaper", item.id, "jpg")),
		...music.map((item) => releaseName("music", item.id, "mp3")),
	];
	assert.equal(new Set(names).size, names.length);
	for (const name of names) assert.match(name, /^[A-Za-z0-9._-]+$/);
	for (const item of [...wallpapers, ...music]) {
		assert.ok(item.url.startsWith(RELEASE_BASE));
	}
});

test("the app bundles wallpaper thumbnails only, and no music", async () => {
	const config = JSON.parse(
		await readFile(path.join(gpui, "tauri.conf.json"), "utf8"),
	);
	const sources = Object.keys(config.bundle.resources ?? {});
	assert.ok(sources.length > 0);
	for (const source of sources) {
		assert.ok(!source.includes("assets/music"), source);
		if (source.includes("assets/backgrounds")) {
			assert.ok(source.endsWith("*-thumbnail.jpg"), source);
		}
	}
});
