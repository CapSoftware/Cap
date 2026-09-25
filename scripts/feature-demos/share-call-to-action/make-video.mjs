import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { demoVideoDuration, demoVideoPath } from "./fixture.mjs";

mkdirSync(dirname(demoVideoPath), { recursive: true });

const d = demoVideoDuration;
const boxes = [
	[96, 96, 1088, 56, "0xffffff@0.16"],
	[96, 196, 520, 28, "0xffffff@0.35"],
	[96, 244, 760, 20, "0xffffff@0.18"],
	[96, 280, 680, 20, "0xffffff@0.18"],
	[96, 340, 1088, 284, "0x000000@0.25"],
	[128, 372, 300, 220, "0x2f6bff@0.75"],
	[460, 372, 300, 220, "0x7a4dff@0.7"],
	[792, 372, 360, 220, "0x12a150@0.7"],
]
	.map(
		([x, y, w, h, color]) =>
			`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=fill`,
	)
	.join(",");
const scene = `gradients=s=1280x720:r=30:d=${d}:c0=0x0f1424:c1=0x1d2f6e:c2=0x2c1a52:n=3:speed=0.01,format=yuv420p,${boxes}[v]`;

const encoders = [
	[
		"-c:v",
		"libvpx-vp9",
		"-deadline",
		"realtime",
		"-cpu-used",
		"8",
		"-b:v",
		"1200k",
	],
	[
		"-c:v",
		"libvpx",
		"-deadline",
		"realtime",
		"-cpu-used",
		"8",
		"-b:v",
		"1500k",
	],
];

let lastError;
for (const encoder of encoders) {
	try {
		execFileSync(
			"ffmpeg",
			[
				"-y",
				"-hide_banner",
				"-loglevel",
				"error",
				"-filter_complex",
				scene,
				"-f",
				"lavfi",
				"-i",
				`anullsrc=r=48000:cl=stereo:d=${d}`,
				"-map",
				"[v]",
				"-map",
				"0:a",
				...encoder,
				"-c:a",
				"libopus",
				"-t",
				String(d),
				demoVideoPath,
			],
			{ stdio: "inherit" },
		);
		console.log(`demo video ready at ${demoVideoPath}`);
		process.exit(0);
	} catch (error) {
		lastError = error;
	}
}
throw lastError;
