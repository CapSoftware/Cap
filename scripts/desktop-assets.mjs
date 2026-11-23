#!/usr/bin/env node
// Builds the desktop asset manifest and stages the files for upload.
//
// Wallpapers and music are not bundled with the desktop app. The app knows
// each file's size and sha256 from `apps/desktop-gpui/assets/asset-manifest.json`
// and downloads it from the release below when someone first uses it.
//
//   node scripts/desktop-assets.mjs manifest        rewrite the manifest
//   node scripts/desktop-assets.mjs check           fail if it is out of date
//   node scripts/desktop-assets.mjs stage <dir>     copy files under release names
//
// Upload with:
//   gh release upload desktop-assets-v1 <dir>/* --repo CapSoftware/transcription-models

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const assetsDir = path.join(repoRoot, "apps", "desktop-gpui", "assets");
const manifestPath = path.join(assetsDir, "asset-manifest.json");

export const RELEASE_BASE =
	"https://github.com/CapSoftware/transcription-models/releases/download/desktop-assets-v1/";

export function releaseName(kind, id, extension) {
	return `${kind}.${id.replaceAll("/", ".")}.${extension}`;
}

async function sha256(file) {
	return createHash("sha256")
		.update(await fs.readFile(file))
		.digest("hex");
}

async function entry(kind, id, file, extension) {
	const { size } = await fs.stat(file);
	return {
		id,
		url: RELEASE_BASE + releaseName(kind, id, extension),
		size,
		sha256: await sha256(file),
	};
}

export async function collect() {
	const wallpapers = [];
	const backgrounds = path.join(assetsDir, "backgrounds");
	const themes = (await fs.readdir(backgrounds, { withFileTypes: true }))
		.filter((dirent) => dirent.isDirectory())
		.map((dirent) => dirent.name)
		.sort();
	for (const theme of themes) {
		const names = (await fs.readdir(path.join(backgrounds, theme)))
			.filter(
				(name) => name.endsWith(".jpg") && !name.endsWith("-thumbnail.jpg"),
			)
			.sort();
		for (const name of names) {
			const id = `${theme}/${name.slice(0, -".jpg".length)}`;
			const file = path.join(backgrounds, theme, name);
			wallpapers.push({
				...(await entry("wallpaper", id, file, "jpg")),
				file,
			});
		}
	}

	const music = [];
	const musicDir = path.join(assetsDir, "music");
	const tracks = (await fs.readdir(musicDir))
		.filter((name) => name.endsWith(".mp3"))
		.sort();
	for (const name of tracks) {
		const id = name.slice(0, -".mp3".length);
		const file = path.join(musicDir, name);
		music.push({ ...(await entry("music", id, file, "mp3")), file });
	}
	return { wallpapers, music };
}

export function render({ wallpapers, music }) {
	const strip = ({ file: _file, ...rest }) => rest;
	return `${JSON.stringify(
		{
			version: 1,
			wallpapers: wallpapers.map(strip),
			music: music.map(strip),
		},
		null,
		"\t",
	)}\n`;
}

async function main(command, argument) {
	const collected = await collect();
	const contents = render(collected);
	if (command === "manifest") {
		await fs.writeFile(manifestPath, contents);
		console.log(
			`wrote ${path.relative(repoRoot, manifestPath)}: ${collected.wallpapers.length} wallpapers, ${collected.music.length} tracks`,
		);
		return;
	}
	if (command === "check") {
		const current = await fs.readFile(manifestPath, "utf8").catch(() => "");
		if (current.replaceAll("\r\n", "\n") !== contents) {
			console.error(
				"asset-manifest.json is out of date: run node scripts/desktop-assets.mjs manifest",
			);
			process.exit(1);
		}
		console.log("asset-manifest.json is up to date");
		return;
	}
	if (command === "stage" && argument) {
		await fs.mkdir(argument, { recursive: true });
		const copy = async (kind, extension, items) => {
			for (const item of items) {
				await fs.copyFile(
					item.file,
					path.join(argument, releaseName(kind, item.id, extension)),
				);
			}
		};
		await copy("wallpaper", "jpg", collected.wallpapers);
		await copy("music", "mp3", collected.music);
		console.log(
			`staged ${collected.wallpapers.length + collected.music.length} files in ${argument}`,
		);
		return;
	}
	console.error(
		"usage: node scripts/desktop-assets.mjs manifest | check | stage <dir>",
	);
	process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	await main(process.argv[2], process.argv[3]);
}
