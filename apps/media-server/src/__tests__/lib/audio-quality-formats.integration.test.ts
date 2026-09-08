import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAudioQualityCandidate } from "../../lib/audio-quality";

let directory: string;

async function fixture(
	name: string,
	inputs: readonly string[],
	output: readonly string[],
) {
	const path = join(directory, name);
	const process = Bun.spawn(
		[
			"ffmpeg",
			"-v",
			"error",
			"-nostdin",
			"-n",
			...inputs,
			...output,
			"-threads",
			"1",
			path,
		],
		{ stdout: "ignore", stderr: "pipe", stdin: "ignore" },
	);
	const [code, error] = await Promise.all([
		process.exited,
		new Response(process.stderr).text(),
	]);
	if (code !== 0) throw new Error(error);
	return path;
}

function audio(
	expression = "0.02*sin(2*PI*440*t)",
	rate = 48000,
	duration = 3,
) {
	return [
		"-f",
		"lavfi",
		"-i",
		`aevalsrc=${expression}:s=${rate}:d=${duration}`,
	];
}

const video = ["-f", "lavfi", "-i", "testsrc2=size=160x90:rate=15:duration=3"];
const h264 = ["-c:v", "libx264", "-preset", "ultrafast"];
const aac = ["-c:a", "aac", "-b:a", "192k"];

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "cap-audio-format-test-"));
});

afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("audio level correction recording formats", () => {
	test.each([
		{
			name: "screen-mono.mp4",
			inputs: [...video, ...audio()],
			output: [...h264, ...aac],
			expected: "shadow-candidate",
		},
		{
			name: "system-music.m4a",
			inputs: audio(
				"0.01*sin(2*PI*220*t)+0.01*sin(2*PI*880*t)|0.01*sin(2*PI*330*t)+0.01*sin(2*PI*1100*t)",
				44100,
			),
			output: aac,
			expected: "shadow-candidate",
		},
		{
			name: "pcm.mov",
			inputs: [...video, ...audio()],
			output: [...h264, "-c:a", "pcm_s16le"],
			expected: "unchanged",
		},
		{
			name: "silent.mp4",
			inputs: [...video, ...audio("0")],
			output: [...h264, ...aac],
			expected: "unchanged",
		},
		{
			name: "video-only.mp4",
			inputs: video,
			output: h264,
			expected: "unchanged",
		},
		{
			name: "surround.m4a",
			inputs: audio(
				"0.01*sin(2*PI*440*t)|0.01*sin(2*PI*550*t)|0.01*sin(2*PI*660*t)|0.01*sin(2*PI*770*t)|0.01*sin(2*PI*880*t)|0.01*sin(2*PI*990*t)",
			),
			output: aac,
			expected: "unchanged",
		},
		{
			name: "dual-audio.mp4",
			inputs: [...video, ...audio(), ...audio()],
			output: ["-map", "0:v", "-map", "1:a", "-map", "2:a", ...h264, ...aac],
			expected: "unchanged",
		},
		{
			name: "low-rate.m4a",
			inputs: audio(undefined, 32000),
			output: aac,
			expected: "unchanged",
		},
		{
			name: "short.m4a",
			inputs: audio(undefined, 48000, 1),
			output: aac,
			expected: "unchanged",
		},
		{
			name: "loud.m4a",
			inputs: audio("0.8*sin(2*PI*440*t)"),
			output: aac,
			expected: "unchanged",
		},
		{
			name: "mismatched-duration.mp4",
			inputs: [...video, ...audio(undefined, 48000, 4)],
			output: [...h264, ...aac],
			expected: "unchanged",
		},
		{
			name: "browser.webm",
			inputs: [...video, ...audio()],
			output: ["-c:v", "libvpx", "-deadline", "realtime", "-c:a", "libopus"],
			expected: "unchanged",
		},
		{
			name: "legacy.mkv",
			inputs: [...video, ...audio()],
			output: [...h264, "-c:a", "flac"],
			expected: "unchanged",
		},
		{
			name: "legacy.mp3",
			inputs: audio(),
			output: ["-c:a", "libmp3lame"],
			expected: "unchanged",
		},
	])(
		"preserves the source for $name",
		async ({ name, inputs, output, expected }) => {
			const path = await fixture(name, inputs, output);
			const original = await readFile(path);
			const sourceHash = createHash("sha256").update(original).digest("hex");
			const result = await createAudioQualityCandidate(path, {
				mode: "shadow",
				profile: "levels",
			});
			try {
				expect(result.status).toBe(expected);
				if (result.status === "shadow-candidate") {
					expect(result.validationFailures).toEqual([]);
					expect(result.sourceSha256).toBe(sourceHash);
					expect(result.output.truePeak).toBeLessThanOrEqual(-1);
					expect(
						Math.abs(result.output.lra - result.input.lra),
					).toBeLessThanOrEqual(1);
				}
				expect(await readFile(path)).toEqual(original);
			} finally {
				if (result.status === "shadow-candidate") await result.cleanup();
			}
		},
		30_000,
	);

	test("preserves subtitle-bearing recordings without dropping a stream", async () => {
		const subtitle = join(directory, "captions.srt");
		await writeFile(subtitle, "1\n00:00:00,000 --> 00:00:02,000\nSpeech\n");
		const source = await fixture(
			"subtitles.mp4",
			[...video, ...audio(), "-i", subtitle],
			[
				"-map",
				"0:v",
				"-map",
				"1:a",
				"-map",
				"2:s",
				...h264,
				...aac,
				"-c:s",
				"mov_text",
			],
		);
		const before = await readFile(source);
		expect(
			await createAudioQualityCandidate(source, {
				mode: "shadow",
				profile: "levels",
			}),
		).toEqual({ status: "unchanged", reason: "unsupported-streams" });
		expect(await readFile(source)).toEqual(before);
	}, 30_000);

	test("rejects corrupt input without replacing it", async () => {
		const source = join(directory, "corrupt.mp4");
		const original = Buffer.from("not a media container");
		await writeFile(source, original);
		await expect(
			createAudioQualityCandidate(source, {
				mode: "shadow",
				profile: "levels",
			}),
		).rejects.toThrow();
		expect(await readFile(source)).toEqual(original);
	});

	test("rejects playlist input instead of following referenced media", async () => {
		const media = await fixture(
			"playlist-media.mp4",
			[...video, ...audio()],
			[...h264, ...aac],
		);
		const source = join(directory, "playlist.m3u8");
		const original = `#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\n${media}\n#EXT-X-ENDLIST\n`;
		await writeFile(source, original);
		await expect(
			createAudioQualityCandidate(source, {
				mode: "shadow",
				profile: "levels",
			}),
		).rejects.toThrow();
		expect(await readFile(source, "utf8")).toBe(original);
	}, 30_000);
});
