import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
	readFileSync(path.join(root, "package.json"), "utf8"),
);
const version = spawnSync("bun", ["--version"], { encoding: "utf8" });
assert.equal(version.status, 0, version.error?.message ?? version.stderr);
assert.equal(`bun@${version.stdout.trim()}`, manifest.packageManager);
const parsed = ts.parseConfigFileTextToJson(
	"bun.lock",
	readFileSync(path.join(root, "bun.lock"), "utf8"),
);
assert.equal(parsed.error, undefined, "bun.lock must be valid JSONC");
const lock = parsed.config;
let checked = 0;
for (const [directory, workspace] of Object.entries(lock.workspaces)) {
	const dependencies = {
		...workspace.dependencies,
		...workspace.devDependencies,
	};
	for (const name of Object.keys(dependencies)) {
		const installed = JSON.parse(
			readFileSync(
				path.join(root, directory, "node_modules", name, "package.json"),
				"utf8",
			),
		);
		const entry =
			lock.packages[`${workspace.name}/${name}`] ?? lock.packages[name];
		assert.ok(entry, `Missing lockfile resolution for ${directory}: ${name}`);
		if (!entry[0].includes("@workspace:")) {
			assert.equal(
				`${installed.name}@${installed.version.replace(/^v/, "")}`,
				entry[0],
				`${directory}: ${name} must match bun.lock`,
			);
		}
		checked++;
	}
}
const webRequire = createRequire(path.join(root, "apps/web/package.json"));
const mobileRequire = createRequire(
	path.join(root, "apps/mobile/package.json"),
);
const nativeRequire = createRequire(
	mobileRequire.resolve("react-native/package.json"),
);
assert.equal(
	nativeRequire("react/package.json").version,
	mobileRequire("react/package.json").version,
	"React Native must resolve the mobile React version",
);
const ffmpeg = webRequire("ffmpeg-static");
assert.equal(
	typeof ffmpeg,
	"string",
	"ffmpeg-static must support this platform",
);
const ffmpegResult = spawnSync(ffmpeg, ["-version"], { encoding: "utf8" });
assert.equal(
	ffmpegResult.status,
	0,
	ffmpegResult.error?.message ?? ffmpegResult.stderr,
);
const nextRequire = createRequire(webRequire.resolve("next/package.json"));
const image = await nextRequire("sharp")({
	create: { width: 1, height: 1, channels: 3, background: "white" },
})
	.png()
	.toBuffer();
assert.ok(image.length > 0, "sharp must load its native binding");
console.log(
	`Bun ${version.stdout.trim()}: ${checked} workspace dependencies match the lockfile; React Native, FFmpeg and sharp passed.`,
);
