import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareNativeAudio } from "./native-audio.mjs";

function fixture(t) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "ux-walk-audio-"));
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	const project = path.join(root, "source.cap");
	const directory = path.join(root, "walk");
	fs.mkdirSync(project);
	fs.mkdirSync(path.join(directory, "media"), { recursive: true });
	execFileSync("ffmpeg", [
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"color=size=32x32:rate=10:duration=1",
		"-c:v",
		"libx264",
		"-threads",
		"1",
		path.join(project, "display.mp4"),
	]);
	execFileSync("ffmpeg", [
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:duration=0.3",
		"-c:a",
		"aac",
		path.join(project, "mic.m4a"),
	]);
	const segments = [0, 1].map(() => ({
		display: { path: "display.mp4", start_time: 0 },
		mic: { path: "mic.m4a", start_time: 0 },
	}));
	const config = {
		timeline: {
			segments: segments.map((_, index) => ({
				recordingSegment: index,
				timescale: 1,
				start: 0,
				end: 1,
			})),
		},
		clips: [
			{ index: 0, offsets: { mic: 0.1 } },
			{ index: 1, offsets: { mic: -0.2 } },
		],
	};
	const save = () => {
		fs.writeFileSync(
			path.join(project, "recording-meta.json"),
			JSON.stringify({ segments }),
		);
		fs.writeFileSync(
			path.join(project, "project-config.json"),
			JSON.stringify(config),
		);
	};
	save();
	return { project, directory, segments, config, save };
}

function rms(audio, start, duration = 0.05) {
	const bytes = execFileSync("ffmpeg", [
		"-v",
		"error",
		"-ss",
		String(start),
		"-i",
		audio,
		"-t",
		String(duration),
		"-map",
		"0:a:0",
		"-ac",
		"1",
		"-ar",
		"8000",
		"-f",
		"f32le",
		"-",
	]);
	let sum = 0;
	for (let i = 0; i + 4 <= bytes.length; i += 4)
		sum += bytes.readFloatLE(i) ** 2;
	return Math.sqrt(sum / (bytes.length / 4));
}

test("source audio keeps silent segment padding and calibrated positive/negative offsets", async (t) => {
	const f = fixture(t);
	const result = await prepareNativeAudio(f.project, f.directory);
	assert.equal(result.durationS, 2);
	assert.ok(rms(result.path, 0.05) > 0.01);
	assert.ok(rms(result.path, 0.6) < 0.001);
	assert.ok(rms(result.path, 1.03) < 0.001);
	assert.ok(rms(result.path, 1.25) > 0.01);
	assert.ok(rms(result.path, 1.8) < 0.001);
});

test("missing audio in an earlier segment does not pull later speech forward", async (t) => {
	const f = fixture(t);
	delete f.segments[0].mic;
	f.config.clips = [];
	f.save();
	const result = await prepareNativeAudio(f.project, f.directory);
	assert.ok(rms(result.path, 0.1) < 0.001);
	assert.ok(rms(result.path, 1.1) > 0.01);
});

test("edited timelines and muted microphone use the rendered-audio fallback", async (t) => {
	for (const change of [
		(config) => {
			config.timeline.segments[0].start = 0.2;
		},
		(config) => {
			config.timeline.segments[0].timescale = 2;
		},
		(config) => {
			config.timeline.segments[0].volume = 0;
		},
		(config) => {
			config.audio = { mute: true };
		},
		(config) => {
			config.audio = { micVolumeDb: -31 };
		},
	]) {
		const f = fixture(t);
		change(f.config);
		f.save();
		assert.equal(await prepareNativeAudio(f.project, f.directory), null);
		assert.equal(
			fs.existsSync(path.join(f.directory, "media/source-audio.m4a")),
			false,
		);
	}
});

test("present clip configuration defaults omitted audio offsets to zero", async (t) => {
	const f = fixture(t);
	delete f.segments[0].mic;
	f.segments[0].mic = { path: "opening.m4a", start_time: 0 };
	f.segments[0].camera = { path: "display.mp4", start_time: 0.2 };
	f.config.clips[0] = { offsets: {} };
	execFileSync("ffmpeg", [
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=440:duration=0.1",
		"-af",
		"apad,atrim=duration=1",
		"-c:a",
		"aac",
		path.join(f.project, "opening.m4a"),
	]);
	f.save();
	const result = await prepareNativeAudio(f.project, f.directory);
	assert.ok(
		rms(result.path, 0.02) > 0.01,
		"opening speech must not be trimmed by an omitted offset field",
	);
});

test("exactly minus thirty decibels remains audible like the renderer", async (t) => {
	const f = fixture(t);
	f.config.audio = { micVolumeDb: -30 };
	f.save();
	const result = await prepareNativeAudio(f.project, f.directory);
	assert.ok(
		result,
		"the renderer only suppresses gains strictly below minus thirty decibels",
	);
	const level = rms(result.path, 0.02);
	assert.ok(level > 0.0001 && level < 0.005);
});
