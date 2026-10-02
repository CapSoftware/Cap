import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const binary = process.env.CAP_WEB_EDITOR_PREPARE_BIN;
assert.ok(binary, "Native web editor preparation binary is required");
const fixtures = join(import.meta.dir, "../fixtures/editor-clips");
const temporary = await mkdtemp(join(tmpdir(), "cap-web-cursor-mov-"));

try {
	const project = join(temporary, "cursor-project.cap");
	const eventsPath = join(temporary, "events.ndjson");
	const manifestPath = join(temporary, "source-manifest.json");
	const settingsPath = join(temporary, "mov-settings.json");
	const outputPath = join(temporary, "cursor-only.mov");
	const events = [
		{ version: 1, platform: "MacOS" },
		{
			kind: "move",
			timeMs: 200,
			x: 0.3,
			y: 0.4,
			cursor: "default",
			button: 0,
			modifiers: [],
		},
		{
			kind: "move",
			timeMs: 1000,
			x: 0.7,
			y: 0.6,
			cursor: "pointer",
			button: 0,
			modifiers: [],
		},
	];
	await writeFile(
		eventsPath,
		`${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
	);
	await writeFile(
		manifestPath,
		JSON.stringify({
			version: 1,
			title: "Paired web cursor export",
			displayPath: join(fixtures, "display-red.webm"),
			displayFps: 30,
			cameraPath: join(fixtures, "camera-green.webm"),
			cameraFps: 25,
			cameraOffsetMs: 0,
			inputEventsPath: eventsPath,
			mixedAudioInDisplay: false,
		}),
	);
	await runFile(binary, ["prepare", project, manifestPath]);
	assert.ok(
		(await readFile(join(project, "content/cursors/web-default.png"))).length >
			0,
	);
	assert.ok(
		(await readFile(join(project, "content/cursors/web-pointer.png"))).length >
			0,
	);
	await writeFile(
		settingsPath,
		JSON.stringify({
			format: "Mov",
			fps: 10,
			resolution_base: { x: 160, y: 90 },
			cursor_only: true,
		}),
	);
	await runFile(binary, [
		"export",
		project,
		join(project, "project-config.json"),
		settingsPath,
		outputPath,
	]);
	const probe = JSON.parse(
		(
			await runFile("ffprobe", [
				"-v",
				"error",
				"-show_entries",
				"stream=codec_name,pix_fmt,nb_frames:format=duration",
				"-of",
				"json",
				outputPath,
			])
		).stdout,
	) as {
		streams: Array<{
			codec_name?: string;
			pix_fmt?: string;
			nb_frames?: string;
		}>;
		format: { duration?: string };
	};
	assert.equal(probe.streams[0]?.codec_name, "prores");
	assert.ok(probe.streams[0]?.pix_fmt?.startsWith("yuva"));
	assert.ok(Number(probe.streams[0]?.nb_frames) >= 10);
	assert.ok(Number(probe.format.duration) > 0);
	const decoder = Bun.spawn(
		[
			"ffmpeg",
			"-hide_banner",
			"-loglevel",
			"error",
			"-i",
			outputPath,
			"-vf",
			"fps=2",
			"-pix_fmt",
			"rgba",
			"-f",
			"rawvideo",
			"-",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const rgba = new Uint8Array(await new Response(decoder.stdout).arrayBuffer());
	assert.equal(await decoder.exited, 0);
	const pixelsPerFrame = 160 * 90;
	const frameBytes = pixelsPerFrame * 4;
	assert.equal(rgba.length % frameBytes, 0);
	let cursorFrames = 0;
	let maxVisiblePixels = 0;
	for (let frame = 0; frame < rgba.length / frameBytes; frame++) {
		let visible = 0;
		for (let pixel = 0; pixel < pixelsPerFrame; pixel++) {
			if (rgba[frame * frameBytes + pixel * 4 + 3] > 0) visible++;
		}
		if (visible > 0) cursorFrames++;
		maxVisiblePixels = Math.max(maxVisiblePixels, visible);
		assert.ok(visible < pixelsPerFrame / 20);
	}
	assert.ok(cursorFrames >= 2, "Cursor-only MOV did not show its input cursor");
	process.stdout.write(
		`${JSON.stringify({ format: "ProRes MOV with alpha", frames: Number(probe.streams[0]?.nb_frames), cursorFrames, maxVisiblePixels, bytes: (await readFile(outputPath)).length })}\n`,
	);
} finally {
	await rm(temporary, { recursive: true, force: true });
}
