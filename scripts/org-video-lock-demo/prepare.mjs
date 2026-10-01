import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import { directory } from "./paths.mjs";

mkdirSync(directory, { recursive: true, mode: 0o700 });
await sharp(
	Buffer.from(
		'<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="#1e3a8a"/><rect x="100" y="180" width="1080" height="360" rx="32" fill="#2563eb"/><text x="640" y="345" text-anchor="middle" font-family="sans-serif" font-size="52" fill="white">Team project walkthrough</text><text x="640" y="410" text-anchor="middle" font-family="sans-serif" font-size="28" fill="#bfdbfe">Example Studio - Synthetic demonstration</text></svg>',
	),
)
	.jpeg()
	.toFile(join(directory, "screenshot.jpg"));
const result = spawnSync(
	"ffmpeg",
	[
		"-loglevel",
		"error",
		"-y",
		"-loop",
		"1",
		"-i",
		join(directory, "screenshot.jpg"),
		"-t",
		"12",
		"-r",
		"24",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"+faststart",
		join(directory, "demo.mp4"),
	],
	{ stdio: "inherit" },
);
if (result.status !== 0) throw new Error("Could not prepare synthetic media");
