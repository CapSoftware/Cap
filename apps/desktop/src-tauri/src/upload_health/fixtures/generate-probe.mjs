import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const targetBytes = 256 * 1024;
const encoded = spawnSync(
	process.env.FFMPEG_BIN ?? "ffmpeg",
	[
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=640x360:rate=30:duration=1",
		"-an",
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"23",
		"-threads",
		"1",
		"-fflags",
		"+bitexact",
		"-flags:v",
		"+bitexact",
		"-map_metadata",
		"-1",
		"-movflags",
		"frag_keyframe+empty_moov",
		"-f",
		"mp4",
		"pipe:1",
	],
	{ maxBuffer: targetBytes },
);

if (encoded.error) throw encoded.error;
if (encoded.status !== 0) throw new Error(encoded.stderr.toString());
const paddingBytes = targetBytes - encoded.stdout.length;
if (paddingBytes < 8) throw new Error("The probe exceeds the target size");
const padding = Buffer.alloc(paddingBytes);
padding.writeUInt32BE(paddingBytes, 0);
padding.write("free", 4, "ascii");
const probe = Buffer.concat([encoded.stdout, padding]);
const output = fileURLToPath(new URL("./probe.mp4", import.meta.url));
writeFileSync(output, probe);
console.log(
	JSON.stringify({
		bytes: probe.length,
		sha256: createHash("sha256").update(probe).digest("hex"),
	}),
);
