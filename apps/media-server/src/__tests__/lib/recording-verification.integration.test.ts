import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxMediaTracksToMp4 } from "../../lib/media-video";
import {
	inspectRecordingSources,
	isRetryableRecordingVerificationError,
	verifyRecording,
	verifyRemoteRecording,
	verifyRemoteRecordingBytes,
} from "../../lib/recording-verification";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
let directory: string;
let silent: string;
let shortAudio: string;
let corruptTail: string;
let truncatedTail: string;
let audioGap: string;
let variableFrameRate: string;
let silentBytes: Uint8Array<ArrayBuffer>;
let corruptBytes: Uint8Array<ArrayBuffer>;
let fragmentInit: Buffer;
let videoFragments: Buffer[];

async function run(command: string[]): Promise<string> {
	const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
	const [output, error, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(error);
	return output;
}

async function generate(path: string, audio: string, filters: string[] = []) {
	await run([
		"ffmpeg",
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=320x180:rate=30:duration=5",
		"-f",
		"lavfi",
		"-i",
		audio,
		...filters,
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-movflags",
		"+faststart",
		path,
	]);
}

function visitFragmentBoxes(
	bytes: Buffer,
	visit: (type: string, offset: number) => void,
	start = 0,
	end = bytes.length,
): void {
	for (let offset = start; offset + 8 <= end; ) {
		const size = bytes.readUInt32BE(offset);
		const type = bytes.toString("ascii", offset + 4, offset + 8);
		if (size < 8 || offset + size > end) {
			throw new Error("Invalid fragmented fixture box");
		}
		if (type === "moof" || type === "traf") {
			visitFragmentBoxes(bytes, visit, offset + 8, offset + size);
		} else {
			visit(type, offset);
		}
		offset += size;
	}
}

function shiftFragmentClocks(bytes: Buffer, offsetTicks: number): void {
	visitFragmentBoxes(bytes, (type, offset) => {
		if (type !== "sidx" && type !== "tfdt") return;
		const version = bytes[offset + 8];
		const position = offset + (type === "tfdt" ? 12 : 20);
		if (version === 1) {
			bytes.writeBigUInt64BE(
				bytes.readBigUInt64BE(position) + BigInt(offsetTicks),
				position,
			);
		} else if (version === 0) {
			bytes.writeUInt32BE(bytes.readUInt32BE(position) + offsetTicks, position);
		} else {
			throw new Error("Unsupported fragmented fixture clock");
		}
	});
}

function changeLastFragmentSampleDuration(bytes: Buffer, offsetTicks: number) {
	let changed = false;
	visitFragmentBoxes(bytes, (type, offset) => {
		if (type !== "trun") return;
		const flags = bytes.readUIntBE(offset + 9, 3);
		const sampleCount = bytes.readUInt32BE(offset + 12);
		if (!(flags & 0x100) || sampleCount === 0) {
			throw new Error("Fragmented fixture has no per-sample durations");
		}
		const sampleSize =
			[0x100, 0x200, 0x400, 0x800].filter((flag) => flags & flag).length * 4;
		const position =
			offset +
			16 +
			(flags & 1 ? 4 : 0) +
			(flags & 4 ? 4 : 0) +
			(sampleCount - 1) * sampleSize;
		bytes.writeUInt32BE(bytes.readUInt32BE(position) + offsetTicks, position);
		changed = true;
	});
	if (!changed) throw new Error("Fragmented fixture has no sample run");
}

async function fragmentedSource(
	offsetTicks: number,
	durationOffsets: { first?: number; last?: number } = {},
): Promise<string> {
	const input = join(
		directory,
		`fragmented-${offsetTicks}-${durationOffsets.first ?? 0}-${durationOffsets.last ?? 0}.mp4`,
	);
	const fragments = videoFragments.map((fragment, index) => {
		const bytes = Buffer.from(fragment);
		if (index > 0) shiftFragmentClocks(bytes, offsetTicks);
		if (index === 0 && durationOffsets.first) {
			changeLastFragmentSampleDuration(bytes, durationOffsets.first);
		}
		if (index === videoFragments.length - 1 && durationOffsets.last) {
			changeLastFragmentSampleDuration(bytes, durationOffsets.last);
		}
		return bytes;
	});
	await writeFile(input, Buffer.concat([fragmentInit, ...fragments]));
	return input;
}

async function videoPackets(input: string) {
	const result: { packets: { pts: number; duration: number }[] } = JSON.parse(
		await run([
			"ffprobe",
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_packets",
			"-show_entries",
			"packet=pts,duration",
			"-of",
			"json",
			input,
		]),
	);
	return result.packets;
}

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "cap-recording-verification-"));
	silent = join(directory, "silent.mp4");
	shortAudio = join(directory, "short-audio.mp4");
	audioGap = join(directory, "audio-gap.mp4");
	variableFrameRate = join(directory, "variable-frame-rate.mp4");
	corruptTail = join(directory, "corrupt-tail.mp4");
	truncatedTail = join(directory, "truncated-tail.mp4");
	await generate(silent, "anullsrc=r=48000:cl=mono:d=5");
	await generate(
		shortAudio,
		"sine=frequency=700:sample_rate=48000:duration=0.1",
	);
	await generate(audioGap, "sine=frequency=700:sample_rate=48000:duration=4", [
		"-af",
		"asetpts=PTS+if(gte(T\\,2)\\,1/TB\\,0)",
	]);
	await generate(variableFrameRate, "anullsrc=r=48000:cl=mono:d=5", [
		"-vf",
		"select=not(mod(n\\,3))+not(mod(n\\,5))",
		"-fps_mode",
		"vfr",
		"-video_track_timescale",
		"90000",
	]);
	const fragmentDirectory = await mkdtemp(join(directory, "dash-"));
	await run([
		"ffmpeg",
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=160x90:rate=30",
		"-frames:v",
		"31",
		"-fps_mode",
		"passthrough",
		"-enc_time_base:v",
		"1:1000000",
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-bf",
		"0",
		"-g",
		"6",
		"-pix_fmt",
		"yuv420p",
		"-threads",
		"1",
		"-f",
		"dash",
		"-seg_duration",
		"0.4",
		"-use_template",
		"1",
		"-use_timeline",
		"1",
		"-init_seg_name",
		"init.mp4",
		"-media_seg_name",
		"fragment-$Number%05d$.m4s",
		join(fragmentDirectory, "manifest.mpd"),
	]);
	fragmentInit = await readFile(join(fragmentDirectory, "init.mp4"));
	const fragmentNames = (await readdir(fragmentDirectory))
		.filter((name) => /^fragment-\d+\.m4s$/.test(name))
		.sort();
	if (fragmentNames.length !== 3) {
		throw new Error("Fragmented fixture must have three video segments");
	}
	videoFragments = await Promise.all(
		fragmentNames.map((name) => readFile(join(fragmentDirectory, name))),
	);
	silentBytes = new Uint8Array(await readFile(silent));
	const packets: {
		packets: { pos: string; size: string; pts_time: string }[];
	} = JSON.parse(
		await run([
			"ffprobe",
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_packets",
			"-show_entries",
			"packet=pos,size,pts_time",
			"-of",
			"json",
			silent,
		]),
	);
	const last = packets.packets.at(-1);
	if (!last || Number(last.pts_time) < 4.5) {
		throw new Error("Fault fixture has no late video packet");
	}
	const damaged = silentBytes.slice();
	damaged.fill(0, Number(last.pos), Number(last.pos) + Number(last.size));
	corruptBytes = damaged;
	await writeFile(corruptTail, damaged);
	await writeFile(
		truncatedTail,
		silentBytes.subarray(0, Math.floor(silentBytes.length * 0.9)),
	);
}, 30_000);

afterAll(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
});

describe("complete recording decode", () => {
	test("counts real decoded frames and samples, including valid silent audio", async () => {
		const evidence = await verifyRecording(silent, {
			expectedDuration: 5,
			requireAudio: true,
		});
		expect(evidence.fullDecode).toBe(true);
		expect(evidence.video.frameCount).toBe(150);
		expect(evidence.video.duration).toBeCloseTo(5, 3);
		expect(evidence.audio?.sampleCount).toBeGreaterThanOrEqual(240_000);
		expect(evidence.audio?.sampleRate).toBe(48_000);
		expect(evidence.audio?.decodedDuration).toBeCloseTo(5, 1);
		const hashes = await run([
			"ffmpeg",
			"-v",
			"error",
			"-i",
			silent,
			"-map",
			"0:v:0",
			"-map",
			"0:a:0",
			"-c:v",
			"rawvideo",
			"-c:a",
			"pcm_f64le",
			"-f",
			"streamhash",
			"-hash",
			"sha256",
			"-",
		]);
		expect(hashes).toContain(
			`0,v,SHA256=${evidence.integrity?.video.contentSha256}`,
		);
		expect(hashes).toContain(
			`1,a,SHA256=${evidence.integrity?.audio?.contentSha256}`,
		);
	});

	test("accepts legacy video without audio only when audio was not requested", async () => {
		const input = join(FIXTURES, "test-no-audio.mp4");
		const evidence = await verifyRecording(input, {
			expectedDuration: 1,
			requireAudio: false,
		});
		expect(evidence.video.frameCount).toBe(25);
		expect(evidence.audio).toBeNull();
		await expect(
			verifyRecording(input, { expectedDuration: 1, requireAudio: true }),
		).rejects.toThrow("missing required audio coverage");
	});

	test("preserves the source timebase for variable frame rate video", async () => {
		const evidence = await verifyRecording(variableFrameRate, {
			expectedDuration: 5,
			requireAudio: true,
		});
		expect(evidence.video.frameCount).toBe(70);
		expect(evidence.video.duration).toBeGreaterThan(4.8);
	});

	test.each(["corrupt", "truncated"])(
		"rejects a %s tail even with a readable complete-duration header",
		async (damage) => {
			const input = damage === "corrupt" ? corruptTail : truncatedTail;
			const header = await run([
				"ffprobe",
				"-v",
				"error",
				"-show_entries",
				"format=duration",
				"-of",
				"json",
				input,
			]);
			expect(Number(JSON.parse(header).format.duration)).toBe(5);
			const error = await verifyRecording(input, {
				expectedDuration: 5,
				requireAudio: true,
			}).catch((error: unknown) => error);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain(
				"Recording full decode failed",
			);
			expect(isRetryableRecordingVerificationError(error)).toBe(false);
		},
	);

	test("rejects a readable short audio track and a missing middle interval", async () => {
		for (const input of [shortAudio, audioGap]) {
			await expect(
				verifyRecording(input, { expectedDuration: 5, requireAudio: true }),
			).rejects.toThrow("missing required audio coverage");
		}
	});

	test("rejects a completely decodable video that is shorter than expected", async () => {
		await expect(
			verifyRecording(join(FIXTURES, "test-with-audio.mp4"), {
				expectedDuration: 5,
				requireAudio: true,
			}),
		).rejects.toThrow("does not cover its expected duration");
	});

	test("does not follow local symlinks", async () => {
		const link = join(directory, "linked.mp4");
		await symlink(silent, link);
		await expect(
			verifyRecording(link, { expectedDuration: 5, requireAudio: true }),
		).rejects.toThrow("regular MP4 file");
	});
});

describe("source-preserving recording mux", () => {
	test.each([-1, 1, 100_000])(
		"preserves fragment boundary clock offsets of %d microseconds",
		async (offsetTicks) => {
			const input = await fragmentedSource(offsetTicks);
			const sourceEvidence = await inspectRecordingSources(input, null);
			const output = join(directory, `preserved-fragmented-${offsetTicks}.mp4`);
			await muxMediaTracksToMp4(input, null, output);
			const [sourcePackets, outputPackets] = await Promise.all([
				videoPackets(input),
				videoPackets(output),
			]);
			const sourceBoundary = sourcePackets[11];
			const outputBoundary = outputPackets[11];
			if (!sourceBoundary || !outputBoundary) {
				throw new Error("Fragmented fixture has no boundary packet");
			}
			expect(outputPackets.map((packet) => packet.pts)).toEqual(
				sourcePackets.map((packet) => packet.pts),
			);
			expect(outputBoundary.duration).toBe(
				sourceBoundary.duration + offsetTicks,
			);
			const verified = await verifyRecording(output, {
				requireAudio: false,
				sourceEvidence,
			});
			expect(verified.sourcePreserved).toBe(true);
			expect(verified.video).toEqual(sourceEvidence.video);
			expect(verified.integrity).toEqual(sourceEvidence.integrity);
		},
	);

	test.each(["dropped-frame", "retimed-frame", "shortened-tail"])(
		"rejects a real %s change in a fully decodable fragmented recording",
		async (damage) => {
			const input = await fragmentedSource(0);
			const sourceEvidence = await inspectRecordingSources(input, null);
			const output = join(directory, `fragmented-${damage}.mp4`);
			const modification =
				damage === "dropped-frame"
					? ["-frames:v", "30"]
					: [
							"-bsf:v",
							damage === "retimed-frame"
								? "setts=ts=TS+if(eq(N\\,15)\\,1000\\,0)"
								: "setts=duration=if(eq(N\\,30)\\,10000\\,DURATION)",
						];
			await run([
				"ffmpeg",
				"-v",
				"error",
				"-copyts",
				"-i",
				input,
				"-map",
				"0:v:0",
				"-c:v",
				"copy",
				"-an",
				"-movie_timescale",
				"1000000",
				...modification,
				output,
			]);
			const outputEvidence = await inspectRecordingSources(output, null);
			if (damage === "dropped-frame") {
				expect(outputEvidence.video.frameCount).toBe(
					sourceEvidence.video.frameCount - 1,
				);
			} else {
				expect(outputEvidence.video.frameCount).toBe(
					sourceEvidence.video.frameCount,
				);
				expect(outputEvidence.integrity.video.contentSha256).toBe(
					sourceEvidence.integrity.video.contentSha256,
				);
				const [sourcePackets, outputPackets] = await Promise.all([
					videoPackets(input),
					videoPackets(output),
				]);
				if (damage === "retimed-frame") {
					expect(outputEvidence.video.endTime).toBe(
						sourceEvidence.video.endTime,
					);
					expect(outputPackets.map((packet) => packet.pts)).not.toEqual(
						sourcePackets.map((packet) => packet.pts),
					);
				} else {
					expect(outputPackets.map((packet) => packet.pts)).toEqual(
						sourcePackets.map((packet) => packet.pts),
					);
					expect(outputEvidence.video.endTime).toBeLessThan(
						sourceEvidence.video.endTime,
					);
				}
			}
			await expect(
				verifyRecording(output, { requireAudio: false, sourceEvidence }),
			).rejects.toThrow(
				damage === "dropped-frame"
					? "does not preserve source video: frame count"
					: "does not preserve source video: presentation timeline",
			);
		},
	);

	test("preserves sub-frame timestamps after a two-hour absolute clock shift", async () => {
		const original = await fragmentedSource(0);
		const input = join(directory, "fractional-timestamps.mp4");
		await run([
			"ffmpeg",
			"-v",
			"error",
			"-copyts",
			"-i",
			original,
			"-map",
			"0:v:0",
			"-c:v",
			"copy",
			"-an",
			"-bsf:v",
			"setts=ts=if(eq(N\\,1)\\,586\\,TS)",
			"-video_track_timescale",
			"15360",
			"-movie_timescale",
			"1000000",
			input,
		]);
		const output = join(directory, "shifted-fractional-timestamps.mp4");
		await run([
			"ffmpeg",
			"-v",
			"error",
			"-copyts",
			"-itsoffset",
			"7200",
			"-i",
			input,
			"-map",
			"0:v:0",
			"-c:v",
			"copy",
			"-an",
			"-video_track_timescale",
			"15360",
			"-movie_timescale",
			"1000000",
			"-avoid_negative_ts",
			"disabled",
			output,
		]);
		const sourceEvidence = await inspectRecordingSources(input, null);
		const [sourcePackets, outputPackets] = await Promise.all([
			videoPackets(input),
			videoPackets(output),
		]);
		expect(sourcePackets[1]?.pts).toBe(9);
		expect(outputPackets.map((packet) => packet.pts - 7_200 * 15_360)).toEqual(
			sourcePackets.map((packet) => packet.pts),
		);
		const verified = await verifyRecording(output, {
			requireAudio: false,
			sourceEvidence,
		});
		expect(verified.sourcePreserved).toBe(true);
		expect(verified.integrity).toEqual(sourceEvidence.integrity);
		expect(verified.video.duration).toBeCloseTo(
			sourceEvidence.video.duration,
			6,
		);
	});

	test.each([-1, 1])(
		"rejects a %d tick final-duration change without changed frames or PTS",
		async (offsetTicks) => {
			const input = await fragmentedSource(0);
			const output = await fragmentedSource(0, { last: offsetTicks });
			const sourceEvidence = await inspectRecordingSources(input, null);
			const outputEvidence = await inspectRecordingSources(output, null);
			expect(outputEvidence.video.frameCount).toBe(
				sourceEvidence.video.frameCount,
			);
			expect(outputEvidence.integrity.video.contentSha256).toBe(
				sourceEvidence.integrity.video.contentSha256,
			);
			const [sourcePackets, outputPackets] = await Promise.all([
				videoPackets(input),
				videoPackets(output),
			]);
			expect(outputPackets.map((packet) => packet.pts)).toEqual(
				sourcePackets.map((packet) => packet.pts),
			);
			expect(
				outputEvidence.video.endTime - sourceEvidence.video.endTime,
			).toBeCloseTo(offsetTicks / 1_000_000, 12);
			await expect(
				verifyRecording(output, { requireAudio: false, sourceEvidence }),
			).rejects.toThrow(
				"does not preserve source video: presentation timeline",
			);
		},
	);

	test("rejects a shortened final frame hidden by an earlier fragment's endpoint", async () => {
		const input = await fragmentedSource(0, { first: 2_000_000 });
		const output = await fragmentedSource(0, { first: 2_000_000, last: -1 });
		const sourceEvidence = await inspectRecordingSources(input, null);
		const outputEvidence = await inspectRecordingSources(output, null);
		expect(outputEvidence.video).toEqual(sourceEvidence.video);
		expect(outputEvidence.integrity.video.contentSha256).toBe(
			sourceEvidence.integrity.video.contentSha256,
		);
		const [sourcePackets, outputPackets] = await Promise.all([
			videoPackets(input),
			videoPackets(output),
		]);
		expect(outputPackets.map((packet) => packet.pts)).toEqual(
			sourcePackets.map((packet) => packet.pts),
		);
		await expect(
			verifyRecording(output, { requireAudio: false, sourceEvidence }),
		).rejects.toThrow("does not preserve source video: presentation timeline");
	});

	test("preserves sparse screenshot timestamps without inventing missing frames", async () => {
		const input = join(directory, "sparse-video.mp4");
		await generate(input, "anullsrc=r=48000:cl=mono:d=5", [
			"-vf",
			"select=eq(n\\,0)+eq(n\\,149)",
			"-fps_mode",
			"vfr",
		]);
		const sourceEvidence = await inspectRecordingSources(input, input);
		const output = join(directory, "preserved-sparse-video.mp4");
		await muxMediaTracksToMp4(input, input, output);
		const verified = await verifyRecording(output, {
			requireAudio: true,
			sourceEvidence,
		});
		expect(verified.sourcePreserved).toBe(true);
		expect(verified.video.frameCount).toBe(2);
		expect(verified.video.duration).toBeCloseTo(5, 3);
	});

	test("refuses source truth when the source itself does not decode completely", async () => {
		await expect(inspectRecordingSources(corruptTail, silent)).rejects.toThrow(
			"full decode failed",
		);
	});

	test.each(["vfr", "short-audio", "audio-gap"])(
		"preserves actual %s media despite an inaccurate legacy duration",
		async (kind) => {
			const input =
				kind === "vfr"
					? variableFrameRate
					: kind === "short-audio"
						? shortAudio
						: audioGap;
			const sourceEvidence = await inspectRecordingSources(input, input);
			const output = join(directory, `preserved-${kind}.mp4`);
			await muxMediaTracksToMp4(input, input, output);
			const verified = await verifyRecording(output, {
				expectedDuration: 0.5,
				requireAudio: true,
				sourceEvidence,
			});
			expect(verified.sourcePreserved).toBe(true);
			expect(verified.video.frameCount).toBe(sourceEvidence.video.frameCount);
			expect(verified.audio?.sampleCount).toBe(
				sourceEvidence.audio?.sampleCount,
			);
			expect(verified.integrity).toEqual(sourceEvidence.integrity);
		},
	);

	test("preserves an audio tail beyond the video and rejects the old shortest mux", async () => {
		const input = join(directory, "long-audio.mp4");
		await generate(input, "sine=frequency=700:sample_rate=48000:duration=6");
		const sourceEvidence = await inspectRecordingSources(input, input);
		const output = join(directory, "preserved-audio-tail.mp4");
		await muxMediaTracksToMp4(input, input, output);
		const verified = await verifyRecording(output, {
			requireAudio: true,
			sourceEvidence,
		});
		expect(verified.audio?.decodedDuration).toBeGreaterThan(5.9);
		expect(verified.sourcePreserved).toBe(true);
		const truncated = join(directory, "shortest-audio-tail.mp4");
		await run([
			"ffmpeg",
			"-v",
			"error",
			"-i",
			input,
			"-map",
			"0:v:0",
			"-map",
			"0:a:0",
			"-c",
			"copy",
			"-shortest",
			truncated,
		]);
		await expect(
			verifyRecording(truncated, {
				requireAudio: true,
				sourceEvidence,
			}),
		).rejects.toThrow("does not preserve source audio");
	});

	test("preserves AAC priming and a nonzero audio offset", async () => {
		const input = join(directory, "offset-source.mp4");
		await generate(input, "sine=frequency=700:sample_rate=48000:duration=5", [
			"-af",
			"asetpts=PTS+0.137/TB",
			"-movie_timescale",
			"1000000",
		]);
		const sourceEvidence = await inspectRecordingSources(input, input);
		const output = join(directory, "offset-output.mp4");
		await muxMediaTracksToMp4(input, input, output);
		const verified = await verifyRecording(output, {
			requireAudio: true,
			sourceEvidence,
		});
		expect(verified.sourcePreserved).toBe(true);
		expect(verified.audio?.startTime).toBeCloseTo(
			sourceEvidence.audio?.startTime ?? 0,
			6,
		);
		const shifted = join(directory, "offset-lost.mp4");
		await run([
			"ffmpeg",
			"-v",
			"error",
			"-i",
			output,
			"-itsoffset",
			"0.25",
			"-i",
			output,
			"-map",
			"0:v:0",
			"-map",
			"1:a:0",
			"-c",
			"copy",
			shifted,
		]);
		await expect(
			verifyRecording(shifted, { requireAudio: true, sourceEvidence }),
		).rejects.toThrow("source A/V sync");
	});

	test("compares audio samples independently of PCM packetization", async () => {
		const input = join(directory, "pcm-source.mp4");
		const output = join(directory, "pcm-repacketized.mp4");
		await run([
			"ffmpeg",
			"-v",
			"error",
			"-i",
			silent,
			"-c:v",
			"copy",
			"-c:a",
			"pcm_s16le",
			"-f",
			"mov",
			input,
		]);
		await run([
			"ffmpeg",
			"-v",
			"error",
			"-copyts",
			"-i",
			input,
			"-c:v",
			"copy",
			"-af",
			"asetnsamples=n=777:p=0",
			"-c:a",
			"pcm_s16le",
			"-f",
			"mov",
			output,
		]);
		const sourceEvidence = await inspectRecordingSources(input, input);
		const verified = await verifyRecording(output, {
			requireAudio: true,
			sourceEvidence,
		});
		expect(verified.sourcePreserved).toBe(true);
		expect(verified.audio?.sampleCount).toBe(sourceEvidence.audio?.sampleCount);
	});

	test("rejects changed video order and changed audio with unchanged durations", async () => {
		const sourceEvidence = await inspectRecordingSources(silent, silent);
		const reversed = join(directory, "reversed.mp4");
		await run([
			"ffmpeg",
			"-v",
			"error",
			"-i",
			silent,
			"-vf",
			"reverse",
			"-c:v",
			"libx264",
			"-preset",
			"ultrafast",
			"-c:a",
			"copy",
			reversed,
		]);
		await expect(
			verifyRecording(reversed, { requireAudio: true, sourceEvidence }),
		).rejects.toThrow("does not preserve source video: decoded content");
		const changedAudio = join(directory, "changed-audio.mp4");
		await run([
			"ffmpeg",
			"-v",
			"error",
			"-i",
			silent,
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=300:sample_rate=48000:duration=5",
			"-map",
			"0:v:0",
			"-map",
			"1:a:0",
			"-c:v",
			"copy",
			"-c:a",
			"aac",
			changedAudio,
		]);
		await expect(
			verifyRecording(changedAudio, { requireAudio: true, sourceEvidence }),
		).rejects.toThrow("does not preserve source audio");
	});

	test("preserves video-only sources without inventing audio", async () => {
		const sourceEvidence = await inspectRecordingSources(
			variableFrameRate,
			null,
		);
		const output = join(directory, "preserved-video-only.mp4");
		await muxMediaTracksToMp4(variableFrameRate, null, output);
		const verified = await verifyRecording(output, {
			requireAudio: false,
			sourceEvidence,
		});
		expect(verified.sourcePreserved).toBe(true);
		expect(verified.audio).toBeNull();
	});
});

async function decoderPids(input: string): Promise<number[]> {
	if (process.platform === "linux") {
		const processes = (await readdir("/proc")).filter((name) =>
			/^\d+$/.test(name),
		);
		const matches = await Promise.all(
			processes.map(async (pid) => {
				try {
					const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
					return command.includes("ffmpeg") && command.includes(input)
						? Number(pid)
						: null;
				} catch (error) {
					if (
						error instanceof Error &&
						"code" in error &&
						(error.code === "ENOENT" || error.code === "ESRCH")
					)
						return null;
					throw error;
				}
			}),
		);
		return matches.filter((pid): pid is number => pid !== null);
	}
	const output = await run(["ps", "-axo", "pid=,command="]);
	return output
		.split("\n")
		.filter((line) => line.includes("ffmpeg") && line.includes(input))
		.map((line) => Number.parseInt(line.trim(), 10));
}

function expectExited(pid: number) {
	expect(() => process.kill(pid, 0)).toThrow();
}

describe("recording verification lifetime", () => {
	test("does not start work for an already cancelled request", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			verifyRecording(silent, {
				expectedDuration: 5,
				requireAudio: true,
				abortSignal: controller.signal,
			}),
		).rejects.toThrow("cancelled");
	});

	test.each(["cancel", "timeout"])(
		"joins its real decoder after %s while the input is stalled",
		async (cause) => {
			let received: (() => void) | undefined;
			const request = new Promise<void>((resolve) => {
				received = resolve;
			});
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch() {
					received?.();
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(silentBytes.subarray(0, 16_384));
							},
						}),
						{ headers: { "Content-Type": "video/mp4" } },
					);
				},
			});
			const controller = new AbortController();
			const input = `http://127.0.0.1:${server.port}/${crypto.randomUUID()}.mp4`;
			try {
				const outcome = verifyRecording(input, {
					expectedDuration: 5,
					requireAudio: true,
					abortSignal: controller.signal,
					timeoutMs: cause === "timeout" ? 1_000 : 5_000,
				}).then(
					() => new Error("Unexpected successful verification"),
					(error: unknown) => error,
				);
				await request;
				const pids = await decoderPids(input);
				expect(pids.length).toBe(1);
				if (cause === "cancel") controller.abort();
				const error = await outcome;
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain(
					cause === "cancel" ? "cancelled" : "timed out",
				);
				for (const pid of pids) expectExited(pid);
			} finally {
				controller.abort();
				await server.stop(true);
			}
		},
		10_000,
	);

	test("decodes remote output and never includes signed query values in failures", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				return new URL(request.url).pathname === "/valid.mp4"
					? new Response(silentBytes, {
							headers: { "Content-Type": "video/mp4" },
						})
					: new Response("Missing", { status: 404 });
			},
		});
		try {
			const evidence = await verifyRecording(
				`http://127.0.0.1:${server.port}/valid.mp4`,
				{ expectedDuration: 5, requireAudio: true },
			);
			expect(evidence.video.frameCount).toBe(150);
			const result = await verifyRecording(
				`http://127.0.0.1:${server.port}/missing.mp4?signature=private-value`,
				{ expectedDuration: 5, requireAudio: true },
			).catch((error: unknown) => error);
			expect(result).toBeInstanceOf(Error);
			expect((result as Error).message).not.toContain("private-value");
		} finally {
			await server.stop(true);
		}
	});
});

function objectResponse(
	request: Request,
	identity?: string,
	honorCondition = true,
	bytes = silentBytes,
) {
	if (
		honorCondition &&
		request.headers.has("if-match") &&
		request.headers.get("if-match") !== identity
	) {
		return new Response("Object changed", { status: 412 });
	}
	const headers: Record<string, string> = {
		"Content-Type": "video/mp4",
	};
	if (identity !== undefined) headers.ETag = identity;
	if (request.headers.get("range") === "bytes=0-0") {
		headers["Content-Range"] = `bytes 0-0/${bytes.byteLength}`;
		return new Response(bytes.subarray(0, 1), { status: 206, headers });
	}
	return new Response(bytes, { headers });
}

describe("remote recording object identity", () => {
	test("binds remote bytes without manufacturing decoded evidence", async () => {
		const identity = '"byte-bound-output"';
		const sha256 = createHash("sha256").update(silentBytes).digest("hex");
		const requests: Request[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				requests.push(request);
				return objectResponse(request, identity);
			},
		});
		try {
			const result = await verifyRemoteRecordingBytes(
				`http://127.0.0.1:${server.port}/recording.mp4`,
				{
					expectedObjectIdentity: identity,
					expectedSha256: sha256,
					expectedFileSize: silentBytes.byteLength,
				},
			);
			expect(result).toEqual({
				objectIdentity: identity,
				fileSize: silentBytes.byteLength,
				remoteSha256: sha256,
			});
			expect(requests.map((request) => request.headers.get("range"))).toEqual([
				"bytes=0-0",
				null,
				"bytes=0-0",
			]);
			for (const request of requests) {
				expect(request.headers.get("if-match")).toBe(identity);
				expect(request.headers.get("x-cap-recording-verification")).toBe("1");
			}
		} finally {
			await server.stop(true);
		}
	});

	test.each(["changed", "oversized", "truncated", "post-identity"])(
		"refuses bytes-only proof for %s storage",
		async (fault) => {
			const identity = '"byte-bound-output"';
			const changed = silentBytes.slice();
			changed[changed.length - 1] ^= 1;
			let bodyRead = false;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					if (request.headers.has("range")) {
						return objectResponse(
							request,
							fault === "post-identity" && bodyRead ? '"changed"' : identity,
						);
					}
					bodyRead = true;
					const bytes =
						fault === "changed"
							? changed
							: fault === "oversized"
								? new Uint8Array(silentBytes.byteLength + 1)
								: fault === "truncated"
									? silentBytes.subarray(0, -1)
									: silentBytes;
					return new Response(bytes, { headers: { ETag: identity } });
				},
			});
			try {
				await expect(
					verifyRemoteRecordingBytes(
						`http://127.0.0.1:${server.port}/recording.mp4`,
						{
							expectedObjectIdentity: identity,
							expectedSha256: createHash("sha256")
								.update(silentBytes)
								.digest("hex"),
							expectedFileSize: silentBytes.byteLength,
						},
					),
				).rejects.toThrow(
					fault === "changed"
						? "bytes do not match"
						: fault === "post-identity"
							? "changed during verification"
							: "size changed",
				);
			} finally {
				await server.stop(true);
			}
		},
	);

	test.each(["cancel", "timeout"])(
		"stops bytes-only readback on %s",
		async (cause) => {
			let started: (() => void) | undefined;
			const reading = new Promise<void>((resolve) => {
				started = resolve;
			});
			const identity = '"stalled-byte-output"';
			const controller = new AbortController();
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					if (request.headers.has("range"))
						return objectResponse(request, identity);
					started?.();
					return new Response(
						new ReadableStream({
							start(stream) {
								stream.enqueue(silentBytes.subarray(0, 32));
							},
						}),
						{ headers: { ETag: identity } },
					);
				},
			});
			try {
				const result = verifyRemoteRecordingBytes(
					`http://127.0.0.1:${server.port}/recording.mp4`,
					{
						expectedObjectIdentity: identity,
						expectedSha256: createHash("sha256")
							.update(silentBytes)
							.digest("hex"),
						expectedFileSize: silentBytes.byteLength,
						abortSignal: controller.signal,
						timeoutMs: cause === "timeout" ? 100 : 5_000,
					},
				).catch((error: unknown) => error);
				await reading;
				if (cause === "cancel") controller.abort();
				const error = await result;
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain(
					cause === "cancel" ? "cancelled" : "timed out",
				);
				expect(isRetryableRecordingVerificationError(error)).toBe(
					cause === "timeout",
				);
			} finally {
				controller.abort();
				await server.stop(true);
			}
		},
	);

	test.each(["cancel", "timeout"])(
		"stops a stalled byte readback after %s without a receipt",
		async (cause) => {
			let started: (() => void) | undefined;
			const reading = new Promise<void>((resolve) => {
				started = resolve;
			});
			const identity = '"stalled-readback"';
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					if (request.headers.has("range"))
						return objectResponse(request, identity);
					started?.();
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(silentBytes.subarray(0, 32));
							},
						}),
						{ headers: { ETag: identity } },
					);
				},
			});
			const controller = new AbortController();
			try {
				const outcome = verifyRemoteRecording(
					`http://127.0.0.1:${server.port}/recording.mp4`,
					{
						expectedDuration: 5,
						requireAudio: true,
						expectedSha256: createHash("sha256")
							.update(silentBytes)
							.digest("hex"),
						expectedFileSize: silentBytes.byteLength,
						abortSignal: controller.signal,
						timeoutMs: cause === "timeout" ? 500 : 5_000,
					},
				).catch((error: unknown) => error);
				await reading;
				if (cause === "cancel") controller.abort();
				const error = await outcome;
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain(
					cause === "cancel" ? "cancelled" : "timed out",
				);
				expect(isRetryableRecordingVerificationError(error)).toBe(
					cause === "timeout",
				);
			} finally {
				controller.abort();
				await server.stop(true);
			}
		},
		10_000,
	);

	test.each(["changed", "oversized"])(
		"rejects %s readback bytes even when storage reuses the ETag",
		async (fault) => {
			const identity = '"dishonest-storage"';
			const sha256 = createHash("sha256").update(silentBytes).digest("hex");
			const changed = silentBytes.slice();
			changed[changed.length - 1] ^= 1;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					if (request.headers.has("range")) {
						return objectResponse(request, identity);
					}
					return new Response(
						fault === "changed"
							? changed
							: new Uint8Array(silentBytes.byteLength + 1),
						{ headers: { ETag: identity } },
					);
				},
			});
			try {
				await expect(
					verifyRemoteRecording(
						`http://127.0.0.1:${server.port}/recording.mp4`,
						{
							expectedDuration: 5,
							requireAudio: true,
							expectedObjectIdentity: identity,
							expectedFileSize: silentBytes.byteLength,
							expectedSha256: sha256,
						},
					),
				).rejects.toThrow(
					fault === "changed" ? "bytes do not match" : "size changed",
				);
			} finally {
				await server.stop(true);
			}
		},
	);

	test("checks exact remote bytes as well as a stable object identity", async () => {
		const identity = '"verified-content"';
		const sha256 = createHash("sha256").update(silentBytes).digest("hex");
		const sourceEvidence = await inspectRecordingSources(silent, silent);
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				return objectResponse(request, identity);
			},
		});
		try {
			const options = {
				requireAudio: true,
				sourceEvidence,
				expectedObjectIdentity: identity,
				expectedFileSize: silentBytes.byteLength,
				expectedSha256: sha256,
			};
			const url = `http://127.0.0.1:${server.port}/recording.mp4`;
			const verified = await verifyRemoteRecording(url, options);
			expect(verified.remoteSha256).toBe(sha256);
			expect(verified.sourcePreserved).toBe(true);
			await expect(
				verifyRemoteRecording(url, {
					...options,
					expectedSha256: "0".repeat(64),
				}),
			).rejects.toThrow("bytes do not match");
			await expect(
				verifyRemoteRecording(url, {
					...options,
					expectedFileSize: silentBytes.byteLength + 1,
				}),
			).rejects.toThrow("size does not match");
		} finally {
			await server.stop(true);
		}
	});

	test("binds the decode and receipt to a strong opaque object version", async () => {
		const requests: { match: string | null; optIn: string | null }[] = [];
		const identity = '"drive-file:42"';
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				requests.push({
					match: request.headers.get("if-match"),
					optIn: request.headers.get("x-cap-recording-verification"),
				});
				return objectResponse(request, identity);
			},
		});
		try {
			const evidence = await verifyRemoteRecording(
				`http://127.0.0.1:${server.port}/recording.mp4`,
				{
					expectedDuration: 5,
					requireAudio: true,
					expectedObjectIdentity: identity,
				},
			);
			expect(evidence.fullDecode).toBe(true);
			expect(evidence.video.frameCount).toBe(150);
			expect(evidence.objectIdentity).toBe(identity);
			expect(evidence.fileSize).toBe(silentBytes.byteLength);
			expect(requests.length).toBeGreaterThanOrEqual(3);
			expect(requests.every((request) => request.match === identity)).toBe(
				true,
			);
			expect(requests.every((request) => request.optIn === "1")).toBe(true);
		} finally {
			await server.stop(true);
		}
	});

	test.each([undefined, 'W/"weak-version"'])(
		"refuses a missing or weak object identity (%s) before decoding",
		async (identity) => {
			let decoderRequests = 0;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					if (request.headers.get("range") !== "bytes=0-0") decoderRequests++;
					return objectResponse(request, identity);
				},
			});
			try {
				await expect(
					verifyRemoteRecording(
						`http://127.0.0.1:${server.port}/recording.mp4`,
						{
							expectedDuration: 5,
							requireAudio: true,
						},
					),
				).rejects.toThrow("does not expose a strong object identity");
				expect(decoderRequests).toBe(0);
			} finally {
				await server.stop(true);
			}
		},
	);

	test.each(["before-decode", "after-decode", "ignored-condition"])(
		"rejects same-size corrupt replacement of a valid object (%s)",
		async (when) => {
			let probes = 0;
			let decoderRequests = 0;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					const probe = request.headers.get("range") === "bytes=0-0";
					if (probe) probes++;
					else decoderRequests++;
					const changed = probes > 1 || (when === "before-decode" && !probe);
					return objectResponse(
						request,
						changed ? '"new-version"' : '"original-version"',
						when !== "ignored-condition",
						changed ? corruptBytes : silentBytes,
					);
				},
			});
			try {
				const error = await verifyRemoteRecording(
					`http://127.0.0.1:${server.port}/recording.mp4`,
					{ expectedDuration: 5, requireAudio: true },
				).catch((error: unknown) => error);
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain(
					when === "before-decode" ? "full decode failed" : "object changed",
				);
				expect(isRetryableRecordingVerificationError(error)).toBe(false);
				expect(decoderRequests).toBeGreaterThan(0);
				if (when !== "before-decode") expect(probes).toBe(2);
			} finally {
				await server.stop(true);
			}
		},
	);

	test.each(["cancel", "timeout"])(
		"keeps decoder cleanup effective across remote identity checks on %s",
		async (cause) => {
			let started: (() => void) | undefined;
			const decoding = new Promise<void>((resolve) => {
				started = resolve;
			});
			let probes = 0;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					if (request.headers.get("range") === "bytes=0-0") {
						probes++;
						return objectResponse(request, '"original-version"');
					}
					started?.();
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(silentBytes.subarray(0, 16_384));
							},
						}),
						{ headers: { "Content-Type": "video/mp4" } },
					);
				},
			});
			const controller = new AbortController();
			const input = `http://127.0.0.1:${server.port}/${crypto.randomUUID()}.mp4`;
			try {
				const outcome = verifyRemoteRecording(input, {
					expectedDuration: 5,
					requireAudio: true,
					abortSignal: controller.signal,
					timeoutMs: cause === "timeout" ? 1_000 : 5_000,
				}).then(
					() => new Error("Unexpected successful verification"),
					(error: unknown) => error,
				);
				await decoding;
				const pids = await decoderPids(input);
				expect(pids.length).toBe(1);
				if (cause === "cancel") controller.abort();
				const error = await outcome;
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain(
					cause === "cancel" ? "cancelled" : "timed out",
				);
				expect(probes).toBe(1);
				expect(isRetryableRecordingVerificationError(error)).toBe(
					cause === "timeout",
				);
				for (const pid of pids) expectExited(pid);
			} finally {
				controller.abort();
				await server.stop(true);
			}
		},
		10_000,
	);

	test.each(["identity-read", "decoder-read"])(
		"classifies HTTP503 during %s as retryable without a receipt",
		async (stage) => {
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					if (
						stage === "identity-read" ||
						request.headers.get("range") !== "bytes=0-0"
					) {
						return new Response("Unavailable", { status: 503 });
					}
					return objectResponse(request, '"original-version"');
				},
			});
			try {
				const error = await verifyRemoteRecording(
					`http://127.0.0.1:${server.port}/recording.mp4`,
					{ expectedDuration: 5, requireAudio: true },
				).catch((error: unknown) => error);
				expect(error).toBeInstanceOf(Error);
				expect(isRetryableRecordingVerificationError(error)).toBe(true);
			} finally {
				await server.stop(true);
			}
		},
	);
});
