import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkHasAudioTrack, extractAudio } from "../../lib/ffmpeg";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const TEST_VIDEO_WITH_AUDIO = `file://${join(FIXTURES_DIR, "test-with-audio.mp4")}`;
const TEST_VIDEO_NO_AUDIO = `file://${join(FIXTURES_DIR, "test-no-audio.mp4")}`;

describe("ffmpeg integration tests", () => {
	describe("checkHasAudioTrack", () => {
		test("detects audio track in video with audio", async () => {
			const hasAudio = await checkHasAudioTrack(TEST_VIDEO_WITH_AUDIO);
			expect(hasAudio).toBe(true);
		});

		test("detects no audio track in video without audio", async () => {
			const hasAudio = await checkHasAudioTrack(TEST_VIDEO_NO_AUDIO);
			expect(hasAudio).toBe(false);
		});
	});

	describe("extractAudio", () => {
		test("extracts audio from video with audio track", async () => {
			const audioData = await extractAudio(TEST_VIDEO_WITH_AUDIO);

			expect(audioData).toBeInstanceOf(Uint8Array);
			expect(audioData.length).toBeGreaterThan(0);

			const hasFtypBox =
				audioData[4] === 0x66 &&
				audioData[5] === 0x74 &&
				audioData[6] === 0x79 &&
				audioData[7] === 0x70;
			expect(hasFtypBox).toBe(true);
		});

		test("throws error for video without audio track", async () => {
			await expect(extractAudio(TEST_VIDEO_NO_AUDIO)).rejects.toThrow();
		});
	});
});
