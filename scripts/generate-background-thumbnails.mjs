import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.some((argument) => argument !== "--check")) {
	throw new Error(
		"Usage: node scripts/generate-background-thumbnails.mjs [--check]",
	);
}
const check = args.includes("--check");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const backgrounds = join(root, "apps/desktop/src-tauri/assets/backgrounds");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const temporary = await mkdtemp(join(tmpdir(), "cap-background-thumbnails-"));
let count = 0;
try {
	const categories = await readdir(backgrounds, { withFileTypes: true });
	for (const category of categories.sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		if (!category.isDirectory()) continue;
		const directory = join(backgrounds, category.name);
		const files = await readdir(directory, { withFileTypes: true });
		for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
			if (
				!file.isFile() ||
				!file.name.endsWith(".jpg") ||
				file.name.endsWith("-thumbnail.jpg")
			) {
				continue;
			}
			const input = join(directory, file.name);
			const thumbnail = join(
				directory,
				file.name.replace(/\.jpg$/, "-thumbnail.jpg"),
			);
			const output = check ? join(temporary, "thumbnail.jpg") : thumbnail;
			const result = spawnSync(
				ffmpeg,
				[
					"-hide_banner",
					"-loglevel",
					"error",
					"-y",
					"-threads",
					"1",
					"-i",
					input,
					"-vf",
					"scale=256:256:force_original_aspect_ratio=decrease:flags=lanczos",
					"-frames:v",
					"1",
					"-threads",
					"1",
					"-q:v",
					"3",
					"-map_metadata",
					"-1",
					"-update",
					"1",
					output,
				],
				{ encoding: "utf8" },
			);
			if (result.error) throw result.error;
			if (result.status !== 0) {
				throw new Error(
					`Thumbnail generation failed for ${input}: ${result.stderr}`,
				);
			}
			if (check) {
				const [expected, actual] = await Promise.all([
					readFile(thumbnail),
					readFile(output),
				]);
				if (!expected.equals(actual)) {
					throw new Error(
						`Regenerate ${relative(root, thumbnail)} with the same FFmpeg version`,
					);
				}
			}
			count += 1;
		}
	}
	if (count === 0) throw new Error("No background JPEGs found");
	console.log(
		`${check ? "Verified" : "Generated"} ${count} background thumbnails`,
	);
} finally {
	await rm(temporary, { recursive: true, force: true });
}
