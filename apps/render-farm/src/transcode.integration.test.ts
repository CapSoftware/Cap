import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcodeArgs } from "./transcode";

test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe")).each([
	[641, 360],
	[640, 361],
	[641, 361],
])("CPU transcodes accept %i × %i recordings", (width, height) => {
	const directory = mkdtempSync(join(tmpdir(), "cap-transcode-"));
	const input = join(directory, "input.webm");
	const output = join(directory, "output.mp4");
	try {
		const generated = Bun.spawnSync([
			"ffmpeg",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			`testsrc=size=${width}x${height}:rate=10`,
			"-t",
			"1",
			"-pix_fmt",
			"yuv420p",
			"-c:v",
			"libvpx",
			"-deadline",
			"realtime",
			input,
		]);
		expect(generated.exitCode, generated.stderr.toString()).toBe(0);
		const encoded = Bun.spawnSync([
			"ffmpeg",
			...transcodeArgs(input, output, 1, "libx264"),
		]);
		expect(encoded.exitCode, encoded.stderr.toString()).toBe(0);
		const decoded = Bun.spawnSync([
			"ffprobe",
			"-v",
			"error",
			"-count_frames",
			"-show_entries",
			"stream=width,height,nb_read_frames,duration",
			"-of",
			"json",
			output,
		]);
		expect(decoded.exitCode, decoded.stderr.toString()).toBe(0);
		expect(decoded.stderr.toString()).toBe("");
		expect(JSON.parse(decoded.stdout.toString())).toMatchObject({
			streams: [
				{
					width: Math.ceil(width / 2) * 2,
					height: Math.ceil(height / 2) * 2,
					nb_read_frames: "10",
					duration: "1.000000",
				},
			],
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
