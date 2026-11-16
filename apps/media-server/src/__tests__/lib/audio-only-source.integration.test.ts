import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHasAudioTrack, extractAudio } from "../../lib/media-audio";

// Regular Cap transcription checks a source for audio, then extracts it. A
// source with audio and no video (an audio-only recording or upload) must be
// read like any other, and a video with no audio must still say so.
let dir = "";

async function ffmpeg(args: string[]): Promise<void> {
	const proc = Bun.spawn(["ffmpeg", "-v", "error", "-y", ...args], {
		stdout: "ignore",
		stderr: "pipe",
	});
	const [code, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stderr).text(),
	]);
	if (code !== 0) throw new Error(stderr);
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "audio-only-"));
	await ffmpeg([
		"-f",
		"lavfi",
		"-i",
		"sine=d=2:r=48000",
		"-c:a",
		"aac",
		join(dir, "audio-only.m4a"),
	]);
	await ffmpeg([
		"-f",
		"lavfi",
		"-i",
		"testsrc=d=2:s=128x96:r=10",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		join(dir, "video-only.mp4"),
	]);
}, 60_000);

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("audio-only sources", () => {
	test("an audio-only file has audio", async () => {
		expect(await checkHasAudioTrack(join(dir, "audio-only.m4a"))).toBe(true);
	}, 30_000);

	test("an audio-only file extracts to MP3", async () => {
		const audio = await extractAudio(join(dir, "audio-only.m4a"));
		expect(audio.length).toBeGreaterThan(1000);
	}, 30_000);

	test("a video with no audio still has no audio", async () => {
		expect(await checkHasAudioTrack(join(dir, "video-only.mp4"))).toBe(false);
	}, 30_000);
});
