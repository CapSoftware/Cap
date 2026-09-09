import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAudioQualityCandidate,
	measureAudioQuality,
} from "../../lib/audio-quality";

let directory: string;

async function command(args: string[]) {
	const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).arrayBuffer(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(stderr);
	return stdout;
}

async function fixture(
	name: string,
	rate = 48000,
	channels = 1,
	options: {
		silence?: boolean;
		offset?: number;
		gap?: boolean;
		duration?: number;
		videoDuration?: number;
		scale?: number;
	} = {},
) {
	const duration = options.duration ?? 3;
	const samples = Math.round(rate * duration);
	const bytes = samples * channels * 2;
	const wav = Buffer.alloc(44 + bytes);
	wav.write("RIFF", 0);
	wav.writeUInt32LE(36 + bytes, 4);
	wav.write("WAVEfmt ", 8);
	wav.writeUInt32LE(16, 16);
	wav.writeUInt16LE(1, 20);
	wav.writeUInt16LE(channels, 22);
	wav.writeUInt32LE(rate, 24);
	wav.writeUInt32LE(rate * channels * 2, 28);
	wav.writeUInt16LE(channels * 2, 32);
	wav.writeUInt16LE(16, 34);
	wav.write("data", 36);
	wav.writeUInt32LE(bytes, 40);
	for (let index = 0; index < samples; index++) {
		const t = index / rate;
		const envelope = [0.005, 0.15, 1.5, duration - 0.01].reduce(
			(sum, center) => sum + Math.exp(-(((t - center) / 0.003) ** 2)),
			0,
		);
		for (let channel = 0; channel < channels; channel++) {
			const value = options.silence
				? 0
				: (options.scale ?? 1) *
					(0.005 + envelope * 0.055) *
					Math.cos(2 * Math.PI * (1000 + channel * 900) * t);
			wav.writeInt16LE(
				Math.round(value * 32767),
				44 + (index * channels + channel) * 2,
			);
		}
	}
	const wavPath = join(directory, `${name}.wav`);
	const source = join(directory, `${name}.mp4`);
	await writeFile(wavPath, wav);
	await command([
		"ffmpeg",
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		`testsrc2=size=160x90:rate=15:duration=${options.videoDuration ?? 3}`,
		"-i",
		wavPath,
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-c:a",
		"aac",
		"-b:a",
		"192k",
		...(options.gap ? ["-af", "asetpts=PTS+if(gte(T\\,1)\\,0.05/TB\\,0)"] : []),
		...(options.offset ? ["-output_ts_offset", String(options.offset)] : []),
		source,
	]);
	return source;
}

async function decode(path: string, rate: number) {
	const bytes = await command([
		"ffmpeg",
		"-v",
		"error",
		"-i",
		path,
		"-map",
		"0:a:0",
		"-ac",
		"1",
		"-ar",
		String(rate),
		"-f",
		"f32le",
		"-",
	]);
	return new Float32Array(bytes);
}

function peakPosition(samples: Float32Array, center: number, rate: number) {
	const start = Math.max(0, Math.floor((center - 0.04) * rate));
	const end = Math.min(samples.length, Math.ceil((center + 0.04) * rate));
	let peak = start;
	for (let index = start; index < end; index++) {
		if (Math.abs(samples[index]) > Math.abs(samples[peak])) peak = index;
	}
	return peak / rate;
}

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "cap-audio-quality-test-"));
});

afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe("audio quality derivative", () => {
	test.each([3.8, 4.2])(
		"corrects very quiet audio while preserving its %s-second timeline",
		async (duration) => {
			const source = await fixture(`quiet-tail-${duration}`, 48000, 1, {
				duration,
				videoDuration: 4,
				scale: 0.4,
			});
			const before = await readFile(source);
			const measured = await measureAudioQuality(
				source,
				AbortSignal.timeout(30_000),
			);
			expect(measured.lufs).toBeGreaterThanOrEqual(-55);
			expect(measured.lufs).toBeLessThan(-50);
			const result = await createAudioQualityCandidate(source, {
				mode: "shadow",
				profile: "levels",
			});
			expect(result).toMatchObject({ status: "shadow-candidate" });
			if (result.status !== "shadow-candidate") return;
			try {
				expect(result.validationFailures).toEqual([]);
				expect(result.input.lufs).toBeLessThan(-50);
				expect(result.output.lufs - result.input.lufs).toBeGreaterThan(20);
				expect(result.output.truePeak).toBeLessThanOrEqual(-1);
				const original = await decode(source, 48000);
				const processed = await decode(result.path, 48000);
				for (const position of [0.005, 0.15, 1.5, duration - 0.01]) {
					expect(
						Math.abs(
							peakPosition(original, position, 48000) -
								peakPosition(processed, position, 48000),
						),
					).toBeLessThan(0.003);
				}
				expect(await readFile(source)).toEqual(before);
			} finally {
				await result.cleanup();
			}
		},
		30_000,
	);

	test("enforces the duration limit when video outlasts audio", async () => {
		const source = await fixture("longer-video-limit", 48000, 1, {
			duration: 3.8,
			videoDuration: 4,
		});
		expect(
			await createAudioQualityCandidate(source, {
				mode: "shadow",
				profile: "levels",
				maxDurationSeconds: 3.9,
			}),
		).toEqual({ status: "unchanged", reason: "duration" });
	});

	test("retains the duration mismatch gate for experimental voice processing", async () => {
		const source = await fixture("voice-duration", 48000, 1, { duration: 4 });
		expect(
			await createAudioQualityCandidate(source, {
				mode: "shadow",
				profile: "voice",
				speechOnlyConfirmed: true,
			}),
		).toEqual({ status: "unchanged", reason: "source-duration-mismatch" });
	});

	for (const rate of [44100, 48000]) {
		for (const channels of [1, 2]) {
			for (const profile of ["levels", "voice"] as const) {
				test(`${profile} preserves video, channels, timing, and boundary pulses at ${rate}/${channels}`, async () => {
					const source = await fixture(
						`${profile}-${rate}-${channels}`,
						rate,
						channels,
					);
					const before = await readFile(source);
					const result = await createAudioQualityCandidate(source, {
						mode: "shadow",
						profile,
						speechOnlyConfirmed: true,
					});
					expect(result.status).toBe("shadow-candidate");
					if (result.status !== "shadow-candidate") return;
					try {
						expect(result.validationFailures).toEqual([]);
						expect(result.output.channels).toBe(channels);
						expect(result.output.truePeak).toBeLessThanOrEqual(-1);
						const original = await decode(source, rate);
						const processed = await decode(result.path, rate);
						for (const position of [0.005, 0.15, 1.5, 2.99]) {
							expect(
								Math.abs(
									peakPosition(original, position, rate) -
										peakPosition(processed, position, rate),
								),
							).toBeLessThan(0.003);
						}
						expect(await readFile(source)).toEqual(before);
					} finally {
						await result.cleanup();
					}
				}, 30_000);
			}
		}
	}

	test("leaves nonzero source starts untouched", async () => {
		const source = await fixture("offset", 48000, 1, { offset: 2 });
		const result = await createAudioQualityCandidate(source, {
			mode: "shadow",
			profile: "levels",
		});
		expect(result).toEqual({
			status: "unchanged",
			reason: "source-start-offset",
		});
	}, 30_000);

	test("does not rewrite discontinuous source audio", async () => {
		const source = await fixture("gap", 48000, 1, { gap: true });
		expect(
			await createAudioQualityCandidate(source, {
				mode: "shadow",
				profile: "levels",
			}),
		).toEqual({ status: "unchanged", reason: "source-timeline-discontinuous" });
	}, 30_000);

	test("preserves silence and does no work when disabled", async () => {
		expect(
			await createAudioQualityCandidate("/does-not-exist", {
				mode: "off",
				profile: "voice",
			}),
		).toEqual({ status: "unchanged", reason: "disabled" });
		const source = await fixture("silence", 48000, 1, { silence: true });
		expect(
			await createAudioQualityCandidate(source, {
				mode: "shadow",
				profile: "levels",
			}),
		).toEqual({ status: "unchanged", reason: "unsafe-levels" });
	}, 30_000);

	test("handles cancellation without modifying the source", async () => {
		const source = await fixture("cancel");
		const before = await readFile(source);
		await expect(
			createAudioQualityCandidate(source, {
				mode: "shadow",
				profile: "voice",
				speechOnlyConfirmed: true,
				abortSignal: AbortSignal.abort(),
			}),
		).rejects.toThrow();
		await expect(
			createAudioQualityCandidate(source, {
				mode: "shadow",
				profile: "voice",
				speechOnlyConfirmed: true,
				timeoutMs: 20,
			}),
		).rejects.toThrow();
		expect(await readFile(source)).toEqual(before);
	}, 30_000);
});
