import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { parse, stringify } from "yaml";
import {
	mergeMacManifests,
	prepareReleaseAssets,
} from "./prepare-electron-release-assets.mjs";

const tempDirs = [];

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

function manifest(url, sha512) {
	return stringify({
		version: "1.2.3",
		files: [{ url, sha512, size: 42 }],
		path: url,
		sha512,
		releaseDate: "2026-08-13T00:00:00.000Z",
	});
}

test("merges macOS updater files while retaining x64 legacy metadata", () => {
	const merged = parse(
		mergeMacManifests(
			manifest("Cap-1.2.3-mac.zip", "x64-hash"),
			manifest("Cap-1.2.3-arm64-mac.zip", "arm64-hash"),
		),
	);

	assert.equal(merged.path, "Cap-1.2.3-mac.zip");
	assert.equal(merged.sha512, "x64-hash");
	assert.deepEqual(
		merged.files.map((file) => file.url),
		["Cap-1.2.3-mac.zip", "Cap-1.2.3-arm64-mac.zip"],
	);
});

test("assembles unique platform assets and one merged macOS manifest", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "cap-release-assets-"));
	tempDirs.push(root);
	const input = path.join(root, "input");
	const output = path.join(root, "output");
	const fixtures = {
		"x86_64-apple-darwin": {
			"Cap-1.2.3.dmg": "dmg-x64",
			"Cap-1.2.3-mac.zip": "zip-x64",
			"latest-mac.yml": manifest("Cap-1.2.3-mac.zip", "x64-hash"),
		},
		"aarch64-apple-darwin": {
			"Cap-1.2.3-arm64.dmg": "dmg-arm64",
			"Cap-1.2.3-arm64-mac.zip": "zip-arm64",
			"latest-mac.yml": manifest("Cap-1.2.3-arm64-mac.zip", "arm64-hash"),
		},
		"x86_64-pc-windows-msvc": {
			"Cap-Setup-1.2.3.exe": "exe",
			"latest.yml": "version: 1.2.3\n",
		},
		"x86_64-unknown-linux-gnu": {
			"Cap-1.2.3.deb": "deb",
			"latest-linux.yml": "version: 1.2.3\n",
		},
	};

	for (const [target, files] of Object.entries(fixtures)) {
		const dir = path.join(input, `release-assets-${target}`);
		await mkdir(dir, { recursive: true });
		await Promise.all(
			Object.entries(files).map(([name, contents]) =>
				writeFile(path.join(dir, name), contents),
			),
		);
	}

	const assets = await prepareReleaseAssets(input, output);
	assert.deepEqual(assets, [
		"Cap-1.2.3-arm64-mac.zip",
		"Cap-1.2.3-arm64.dmg",
		"Cap-1.2.3-mac.zip",
		"Cap-1.2.3.deb",
		"Cap-1.2.3.dmg",
		"Cap-Setup-1.2.3.exe",
		"latest-linux.yml",
		"latest-mac.yml",
		"latest.yml",
	]);
	const merged = parse(
		await readFile(path.join(output, "latest-mac.yml"), "utf8"),
	);
	assert.equal(merged.files.length, 2);
});
