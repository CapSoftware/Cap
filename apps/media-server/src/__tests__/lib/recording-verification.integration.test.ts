import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync } from "node:fs";
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
import { Readable } from "node:stream";
import { EncodedPacketSink, FilePathSource, Input, MP4 } from "mediabunny";
import { muxMediaTracksToMp4 } from "../../lib/media-video";
import {
	RecordingTimingError,
	readRecordingVideoTiming,
} from "../../lib/recording-timing";
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
let bFrameInit: Buffer;
let bFrameSamples: VideoSample[];

interface VideoSample {
	pts: number;
	dts: number;
	duration: number;
	flags: number;
	data: Buffer;
}

function mp4Box(type: string, ...payload: Buffer[]): Buffer {
	const header = Buffer.alloc(8);
	header.writeUInt32BE(
		8 + payload.reduce((size, bytes) => size + bytes.length, 0),
	);
	header.write(type, 4, "ascii");
	return Buffer.concat([header, ...payload]);
}

function sampleFragment(
	samples: VideoSample[],
	sequence: number,
	durationSource: "trun" | "tfhd" | "trex" = "trun",
): Buffer {
	const first = samples[0];
	if (!first) throw new Error("Fixture fragment is empty");
	const mfhd = Buffer.alloc(8);
	mfhd.writeUInt32BE(sequence, 4);
	const tfhd = Buffer.alloc(durationSource === "tfhd" ? 12 : 8);
	tfhd.writeUInt32BE(durationSource === "tfhd" ? 0x20008 : 0x20000);
	tfhd.writeUInt32BE(1, 4);
	if (durationSource === "tfhd") tfhd.writeUInt32BE(first.duration, 8);
	const tfdt = Buffer.alloc(12);
	tfdt.writeUInt32BE(0x1000000);
	tfdt.writeBigUInt64BE(BigInt(first.dts), 4);
	const stride = durationSource === "trun" ? 16 : 12;
	const trun = Buffer.alloc(12 + stride * samples.length);
	trun.writeUInt32BE(durationSource === "trun" ? 0x1000f01 : 0x1000e01);
	trun.writeUInt32BE(samples.length, 4);
	for (const [index, sample] of samples.entries()) {
		let offset = 12 + index * stride;
		if (durationSource === "trun") {
			trun.writeUInt32BE(sample.duration, offset);
			offset += 4;
		}
		trun.writeUInt32BE(sample.data.length, offset);
		trun.writeUInt32BE(sample.flags, offset + 4);
		trun.writeInt32BE(sample.pts - sample.dts, offset + 8);
	}
	const fragment = () =>
		mp4Box(
			"moof",
			mp4Box("mfhd", mfhd),
			mp4Box(
				"traf",
				mp4Box("tfhd", tfhd),
				mp4Box("tfdt", tfdt),
				mp4Box("trun", trun),
			),
		);
	trun.writeInt32BE(fragment().length + 8, 8);
	return Buffer.concat([
		fragment(),
		mp4Box("mdat", ...samples.map((sample) => sample.data)),
	]);
}

async function tiedTimestampSource(
	name: string,
	terminalTies: number,
	tailChange = 0,
	swapTailDurations = false,
): Promise<string> {
	const samples = bFrameSamples.map((sample) => ({ ...sample }));
	const interior = samples[13];
	const next = samples[17];
	const final = samples[37];
	const beforeLast = samples[38];
	const last = samples[39];
	if (!interior || !next || !final || !beforeLast || !last) {
		throw new Error("B-frame fixture is incomplete");
	}
	interior.pts = next.pts;
	if (terminalTies > 1) {
		final.duration = 6000 + tailChange;
		beforeLast.dts += 3000;
		beforeLast.pts += 3000;
		last.dts += 3000;
		last.pts += 3000;
		last.duration = 1;
		if (terminalTies === 3) beforeLast.pts = final.pts;
		if (swapTailDurations) {
			[final.duration, last.duration] = [last.duration, final.duration];
		}
	}
	const output = join(directory, name);
	await writeFile(
		output,
		Buffer.concat(
			tailChange || swapTailDurations
				? [
						bFrameInit,
						sampleFragment(samples.slice(0, 38), 1),
						sampleFragment(samples.slice(38), 2),
					]
				: [bFrameInit, sampleFragment(samples, 1)],
		),
	);
	return output;
}

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
		if (
			["moof", "traf", "moov", "mvex", "trak", "mdia", "minf", "stbl"].includes(
				type,
			)
		) {
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
	const source = new Input({
		formats: [MP4],
		source: new FilePathSource(input),
	});
	try {
		const [track] = await source.getVideoTracks();
		if (!track) throw new Error("Fixture has no video track");
		const resolution = await track.getTimeResolution();
		const sink = new EncodedPacketSink(track);
		const packets: { pts: number; duration: number }[] = [];
		for await (const packet of sink.packets(undefined, undefined, {
			metadataOnly: true,
			skipLiveWait: true,
		})) {
			packets.push({
				pts: Math.round(packet.timestamp * resolution),
				duration: Math.round(packet.duration * resolution),
			});
		}
		return packets;
	} finally {
		source.dispose();
	}
}

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "cap-recording-verification-"));
	silent = join(directory, "silent.mp4");
	shortAudio = join(directory, "short-audio.mp4");
	audioGap = join(directory, "audio-gap.mp4");
	variableFrameRate = join(directory, "variable-frame-rate.mp4");
	corruptTail = join(directory, "corrupt-tail.mp4");
	truncatedTail = join(directory, "truncated-tail.mp4");
	const bFrameSource = join(directory, "b-frame-fragments.mp4");
	await run([
		"ffmpeg",
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=160x90:rate=30",
		"-frames:v",
		"40",
		"-an",
		"-c:v",
		"libx264",
		"-preset",
		"fast",
		"-bf",
		"2",
		"-x264-params",
		"b-adapt=0:b-pyramid=none:scenecut=0:keyint=60:min-keyint=60",
		"-video_track_timescale",
		"90000",
		"-movflags",
		"empty_moov+frag_keyframe+default_base_moof+delay_moov",
		bFrameSource,
	]);
	const bFrameBytes = await readFile(bFrameSource);
	const initBoxes: Buffer[] = [];
	for (let offset = 0; offset < bFrameBytes.length; ) {
		const size = bFrameBytes.readUInt32BE(offset);
		const type = bFrameBytes.toString("ascii", offset + 4, offset + 8);
		if (type === "ftyp" || type === "moov") {
			initBoxes.push(bFrameBytes.subarray(offset, offset + size));
		}
		if (size < 8) throw new Error("B-frame fixture box is invalid");
		offset += size;
	}
	bFrameInit = Buffer.concat(initBoxes);
	const bFramePackets: {
		packets: {
			pts: number;
			dts: number;
			pos: string;
			size: string;
			flags: string;
		}[];
	} = JSON.parse(
		await run([
			"ffprobe",
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"packet=pts,dts,pos,size,flags",
			"-of",
			"json",
			bFrameSource,
		]),
	);
	bFrameSamples = bFramePackets.packets.map((packet) => ({
		pts: packet.pts + 3000,
		dts: packet.dts + 3000,
		duration: 3000,
		flags: packet.flags.includes("K") ? 0x2000000 : 0x1010000,
		data: bFrameBytes.subarray(
			Number(packet.pos),
			Number(packet.pos) + Number(packet.size),
		),
	}));
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
	test.each([
		{ audio: true, hasAudio: true },
		{ audio: false, hasAudio: false },
	])(
		"binds the audio-presence hint %j to decoded streams",
		async ({ audio, hasAudio }) => {
			const input = audio ? silent : join(FIXTURES, "test-no-audio.mp4");
			const options = { expectedDuration: audio ? 5 : 1, requireAudio: false };
			const stock = await verifyRecording(input, options);
			const streamed = await verifyRecording(input, { ...options, hasAudio });
			expect(streamed).toEqual(stock);
			if (!audio) {
				await expect(
					verifyRecording(input, { ...options, hasAudio, requireAudio: true }),
				).rejects.toThrow("missing required audio coverage");
			}
		},
	);
	test.skipIf(process.platform === "win32").each([
		{ audio: true, hasAudio: false },
		{ audio: false, hasAudio: true },
	])(
		"rejects a mismatched accelerated audio-presence hint %j",
		async ({ audio, hasAudio }) => {
			const input = audio ? silent : join(FIXTURES, "test-no-audio.mp4");
			await expect(
				verifyRecording(input, {
					expectedDuration: audio ? 5 : 1,
					requireAudio: false,
					hasAudio,
				}),
			).rejects.toThrow();
		},
	);

	test.each(["audio", "video-only"])(
		"matches FFmpeg streamhash for every streamed %s byte",
		async (kind) => {
			const audio = kind === "audio" ? silent : null;
			const evidence = await inspectRecordingSources(silent, audio);
			const hashes = await run([
				"ffmpeg",
				"-v",
				"error",
				"-threads",
				"1",
				"-i",
				silent,
				"-map",
				"0:v:0",
				...(audio ? ["-map", "0:a:0"] : []),
				"-c:v",
				"rawvideo",
				"-c:a",
				"pcm_f64le",
				"-threads",
				"1",
				"-f",
				"streamhash",
				"-hash",
				"sha256",
				"-",
			]);
			expect(hashes).toContain(
				`0,v,SHA256=${evidence.integrity.video.contentSha256}`,
			);
			if (audio) {
				expect(hashes).toContain(
					`1,a,SHA256=${evidence.integrity.audio?.contentSha256}`,
				);
				const verified = await verifyRecording(silent, {
					requireAudio: false,
					sourceEvidence: evidence,
				});
				expect(verified.sourcePreserved).toBe(true);
				expect(verified.integrity).toEqual(evidence.integrity);
			} else {
				expect(evidence.audio).toBeNull();
				await expect(
					verifyRecording(silent, {
						requireAudio: false,
						sourceEvidence: evidence,
					}),
				).rejects.toThrow();
			}
		},
	);

	test.skipIf(
		process.platform === "win32" ||
			process.env.MEDIA_SERVER_RECORDING_PERFORMANCE_TESTS !== "1",
	)(
		"streams a complete long recording within a bounded decode budget",
		async () => {
			const seed = join(directory, "long-recording-seed.mp4");
			const input = join(directory, "long-recording.mp4");
			await run([
				"ffmpeg",
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"testsrc2=size=1920x1080:rate=30:duration=2",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=700:sample_rate=48000:duration=2",
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				"-threads",
				"1",
				"-c:a",
				"aac",
				seed,
			]);
			await run([
				"ffmpeg",
				"-v",
				"error",
				"-stream_loop",
				"59",
				"-i",
				seed,
				"-c",
				"copy",
				input,
			]);
			const baseline = process.memoryUsage().rss;
			let peak = baseline;
			const memory = setInterval(() => {
				peak = Math.max(peak, process.memoryUsage().rss);
			}, 25);
			try {
				const started = performance.now();
				const source = await inspectRecordingSources(input, input, {
					timeoutMs: 30_000,
				});
				const elapsed = performance.now() - started;
				const sourcePeak = peak;
				expect(elapsed).toBeLessThan(30_000);
				expect(source.fullDecode).toBe(true);
				expect(source.video.frameCount).toBe(3_600);
				expect(source.audio?.sampleCount).toBeGreaterThanOrEqual(5_760_000);
				expect(sourcePeak - baseline).toBeLessThan(256 * 1_024 * 1_024);
				const stockStarted = performance.now();
				const stock = await verifyRecording(input, {
					expectedDuration: source.video.duration,
					requireAudio: false,
					timeoutMs: 110_000,
				});
				expect(stock.integrity?.video.contentSha256).toBe(
					source.integrity.video.contentSha256,
				);
				expect(source.integrity.audio?.contentSha256).toBe(
					stock.integrity?.audio?.contentSha256,
				);
				expect(source.video).toEqual(stock.video);
				expect(source.audio).toEqual(stock.audio);
				console.info(
					`Recording decode: ${elapsed.toFixed(0)} ms, stock ${(performance.now() - stockStarted).toFixed(0)} ms, ${((sourcePeak - baseline) / 1_024 / 1_024).toFixed(1)} MiB peak RSS increase`,
				);
			} finally {
				clearInterval(memory);
			}
		},
		150_000,
	);

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
	test.each([1, 2])(
		"preserves interior tied timestamps and %d terminal packets with real B-frames",
		async (terminalTies) => {
			const input = await tiedTimestampSource(
				`tied-${terminalTies}.mp4`,
				terminalTies,
			);
			const sourceEvidence = await inspectRecordingSources(input, silent);
			const stockHash = await run([
				"ffmpeg",
				"-v",
				"error",
				"-copyts",
				"-threads",
				"1",
				"-i",
				input,
				"-map",
				"0:v:0",
				"-fps_mode",
				"passthrough",
				"-enc_time_base:v",
				"-1",
				"-c:v",
				"rawvideo",
				"-threads",
				"1",
				"-f",
				"streamhash",
				"-hash",
				"sha256",
				"-",
			]);
			expect(stockHash).toContain(
				`0,v,SHA256=${sourceEvidence.integrity.video.contentSha256}`,
			);
			const output = join(directory, `tied-${terminalTies}-output.mp4`);
			await muxMediaTracksToMp4(input, silent, output);
			const verified = await verifyRecording(output, {
				requireAudio: true,
				sourceEvidence,
			});
			expect(verified.sourcePreserved).toBe(true);
			expect(verified.video.frameCount).toBe(40);
			expect(verified.integrity).toEqual(sourceEvidence.integrity);
			expect(verified.audio?.sampleCount).toBe(
				sourceEvidence.audio?.sampleCount,
			);
			const sourceTiming = await readRecordingVideoTiming(input, {
				timeoutMs: 5000,
			});
			const outputTiming = await readRecordingVideoTiming(output, {
				timeoutMs: 5000,
			});
			expect(sourceTiming.terminalPacketCount).toBe(terminalTies);
			expect(outputTiming.terminalPacketSha256).toBe(
				sourceTiming.terminalPacketSha256,
			);
		},
	);

	test("refuses tied timestamps when the decoder changes their presentation times", async () => {
		const input = await tiedTimestampSource("tied-three.mp4", 3);
		const timing = await readRecordingVideoTiming(input, { timeoutMs: 5000 });
		expect(timing.terminalPacketCount).toBe(3);
		await expect(inspectRecordingSources(input, null)).rejects.toThrow(
			"Recording container timing does not match decoded video",
		);
	});

	test("keeps standalone verification strict without source-bound timing evidence", async () => {
		const input = await tiedTimestampSource("standalone-tied.mp4", 1);
		await expect(
			verifyRecording(input, { requireAudio: false, expectedDuration: 4 / 3 }),
		).rejects.toThrow("Decoded recording timestamps are invalid");
	});

	test("binds interior container timestamps even when the decoded evidence is unchanged", async () => {
		const input = await tiedTimestampSource("tied-container-clock.mp4", 1);
		const sourceEvidence = await inspectRecordingSources(input, null);
		const originalNext = EncodedPacketSink.prototype.getNextPacket;
		let calls = 0;
		const next = spyOn(
			EncodedPacketSink.prototype,
			"getNextPacket",
		).mockImplementation(async function (
			this: EncodedPacketSink,
			...args: Parameters<typeof originalNext>
		) {
			const packet = await originalNext.apply(this, args);
			if (packet && ++calls === 17)
				Object.defineProperty(packet, "timestamp", {
					value: packet.timestamp + 1 / 90000,
				});
			return packet;
		});
		let alteredEvidence: Awaited<ReturnType<typeof inspectRecordingSources>>;
		try {
			alteredEvidence = await inspectRecordingSources(input, null);
		} finally {
			next.mockRestore();
		}
		expect(alteredEvidence.video).toEqual(sourceEvidence.video);
		expect(alteredEvidence.integrity.video.contentSha256).toBe(
			sourceEvidence.integrity.video.contentSha256,
		);
		await expect(
			verifyRecording(input, {
				requireAudio: false,
				sourceEvidence: alteredEvidence,
			}),
		).rejects.toThrow("does not preserve source video: presentation timeline");
	});

	test.each(["tfhd", "trex"] as const)(
		"binds tied final packets with %s default durations",
		async (durationSource) => {
			const samples = bFrameSamples.map((sample) => ({ ...sample }));
			samples[39].pts = samples[37].pts;
			const init = Buffer.from(bFrameInit);
			visitFragmentBoxes(init, (type, offset) => {
				if (type === "trex") init.writeUInt32BE(3000, offset + 20);
			});
			const input = join(directory, `tied-default-${durationSource}.mp4`);
			await writeFile(
				input,
				Buffer.concat([
					init,
					...samples.map((sample, index) =>
						sampleFragment([sample], index + 1, durationSource),
					),
				]),
			);
			const sourceEvidence = await inspectRecordingSources(input, null);
			const output = join(
				directory,
				`tied-default-${durationSource}-output.mp4`,
			);
			await muxMediaTracksToMp4(input, null, output);
			const verified = await verifyRecording(output, {
				requireAudio: false,
				sourceEvidence,
			});
			expect(verified.sourcePreserved).toBe(true);
			expect(verified.video.frameCount).toBe(40);
			expect(verified.integrity).toEqual(sourceEvidence.integrity);
			const invalid = await readFile(input);
			visitFragmentBoxes(invalid, (type, offset) => {
				if (durationSource === "trex" && type === "trex")
					invalid.writeUInt32BE(0, offset + 20);
				if (durationSource === "tfhd" && type === "tfhd")
					invalid.writeUInt32BE(0, offset + 16);
			});
			await writeFile(input, invalid);
			await expect(
				readRecordingVideoTiming(input, { timeoutMs: 5000 }),
			).rejects.toThrow();
		},
	);

	test("refuses a truncated sample-time table on a remuxed tied-tail recording", async () => {
		const input = await tiedTimestampSource("tied-stts-input.mp4", 2);
		const sourceEvidence = await inspectRecordingSources(input, null);
		const output = join(directory, "tied-stts-output.mp4");
		await muxMediaTracksToMp4(input, null, output);
		const bytes = await readFile(output);
		visitFragmentBoxes(bytes, (type, offset) => {
			if (type === "stts")
				bytes.writeUInt32BE(bytes.readUInt32BE(offset + 12) + 1, offset + 12);
		});
		await writeFile(output, bytes);
		await expect(
			verifyRecording(output, { requireAudio: false, sourceEvidence }),
		).rejects.toThrow();
	});

	test("handles a zero-sized trailing box without reading beyond the recording", async () => {
		const input = await tiedTimestampSource("tied-zero-box.mp4", 2);
		const expected = await readRecordingVideoTiming(input, { timeoutMs: 5000 });
		const trailing = Buffer.alloc(8);
		trailing.write("free", 4, "ascii");
		await writeFile(input, Buffer.concat([await readFile(input), trailing]));
		expect(await readRecordingVideoTiming(input, { timeoutMs: 5000 })).toEqual(
			expected,
		);
	});

	test("refuses an unsafe extended box size without allocating its claimed payload", async () => {
		const input = await tiedTimestampSource("tied-large-box.mp4", 2);
		const trailing = Buffer.alloc(16);
		trailing.writeUInt32BE(1);
		trailing.write("moof", 4, "ascii");
		trailing.writeBigUInt64BE(1n << 63n, 8);
		await writeFile(input, Buffer.concat([await readFile(input), trailing]));
		await expect(
			readRecordingVideoTiming(input, { timeoutMs: 5000 }),
		).rejects.toThrow();
	});

	test.each([
		"unknown-trun-flags",
		"trun-count-overflow",
		"zero-terminal-duration",
	])("refuses ambiguous tied-tail metadata: %s", async (damage) => {
		const input = await tiedTimestampSource(`tied-malformed-${damage}.mp4`, 2);
		const bytes = await readFile(input);
		visitFragmentBoxes(bytes, (type, offset) => {
			if (type !== "trun") return;
			if (damage === "unknown-trun-flags")
				bytes.writeUIntBE(bytes.readUIntBE(offset + 9, 3) | 2, offset + 9, 3);
			else if (damage === "trun-count-overflow")
				bytes.writeUInt32BE(0xffffffff, offset + 12);
			else bytes.writeUInt32BE(0, offset + 20 + 39 * 16);
		});
		await writeFile(input, bytes);
		await expect(inspectRecordingSources(input, null)).rejects.toThrow();
	});

	test.each([-1, 1])(
		"rejects a %d tick change hidden by another packet at the same final timestamp",
		async (tailChange) => {
			const input = await tiedTimestampSource(
				`tied-tail-source-${tailChange}.mp4`,
				2,
			);
			const changed = await tiedTimestampSource(
				`tied-tail-change-${tailChange}.mp4`,
				2,
				tailChange,
			);
			const sourceEvidence = await inspectRecordingSources(input, null);
			const alteredEvidence = await inspectRecordingSources(changed, null);
			expect(alteredEvidence.video.frameCount).toBe(40);
			expect(alteredEvidence.integrity.video.contentSha256).toBe(
				sourceEvidence.integrity.video.contentSha256,
			);
			expect((await videoPackets(changed)).map((packet) => packet.pts)).toEqual(
				(await videoPackets(input)).map((packet) => packet.pts),
			);
			await expect(
				verifyRecording(changed, { requireAudio: false, sourceEvidence }),
			).rejects.toThrow(
				"does not preserve source video: presentation timeline",
			);
		},
	);

	test("rejects exchanging durations between packets with tied final timestamps", async () => {
		const input = await tiedTimestampSource("tied-duration-source.mp4", 2);
		const changed = await tiedTimestampSource(
			"tied-duration-swapped.mp4",
			2,
			0,
			true,
		);
		const sourceEvidence = await inspectRecordingSources(input, null);
		await expect(
			verifyRecording(changed, { requireAudio: false, sourceEvidence }),
		).rejects.toThrow("does not preserve source video: presentation timeline");
	});

	test("continues rejecting backwards presentation timestamps without B-frames", async () => {
		const input = await fragmentedSource(-33_334);
		const timing = await readRecordingVideoTiming(input, { timeoutMs: 5000 });
		expect(timing.videoPacketCount).toBe(31);
		await expect(inspectRecordingSources(input, null)).rejects.toThrow(
			"Recording container timing does not match decoded video",
		);
	});

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

	test.each([-1, 1, -23_333])(
		"preserves a true partial final frame with duration offset %d ticks when muxing",
		async (offsetTicks) => {
			const input = await fragmentedSource(0, { last: offsetTicks });
			const sourceEvidence = await inspectRecordingSources(input, null);
			const output = join(
				directory,
				`preserved-partial-tail-${offsetTicks}.mp4`,
			);
			await muxMediaTracksToMp4(input, null, output);
			const [sourcePackets, outputPackets] = await Promise.all([
				videoPackets(input),
				videoPackets(output),
			]);
			expect(outputPackets.map((packet) => packet.pts)).toEqual(
				sourcePackets.map((packet) => packet.pts),
			);
			const sourceTail = sourcePackets.at(-1);
			const outputTail = outputPackets.at(-1);
			if (!sourceTail || !outputTail)
				throw new Error("Fixture has no final packet");
			expect(sourceTail.duration).toBe(33_333 + offsetTicks);
			expect(outputTail.duration).toBe(sourceTail.duration);
			const verified = await verifyRecording(output, {
				requireAudio: false,
				sourceEvidence,
			});
			expect(verified.sourcePreserved).toBe(true);
			expect(verified.video.frameCount).toBe(31);
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
			const sourceTail = sourcePackets.at(-1);
			const outputTail = outputPackets.at(-1);
			if (!sourceTail || !outputTail)
				throw new Error("Fixture has no final packet");
			expect(outputTail.duration).toBe(sourceTail.duration + offsetTicks);
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
		const sourceTail = sourcePackets.at(-1);
		const outputTail = outputPackets.at(-1);
		if (!sourceTail || !outputTail)
			throw new Error("Fixture has no final packet");
		expect(outputTail.duration).toBe(sourceTail.duration - 1);
		await expect(
			verifyRecording(output, { requireAudio: false, sourceEvidence }),
		).rejects.toThrow("does not preserve source video: presentation timeline");
	});

	test("preserves presentation order and terminal duration for real B-frames", async () => {
		const input = join(directory, "b-frame-source.mp4");
		await generate(input, "anullsrc=r=48000:cl=mono:d=5", [
			"-bf",
			"2",
			"-g",
			"30",
			"-video_track_timescale",
			"90000",
		]);
		const probe: { streams: { has_b_frames: number }[] } = JSON.parse(
			await run([
				"ffprobe",
				"-v",
				"error",
				"-select_streams",
				"v:0",
				"-show_entries",
				"stream=has_b_frames",
				"-of",
				"json",
				input,
			]),
		);
		expect(probe.streams[0]?.has_b_frames).toBeGreaterThan(0);
		const sourceEvidence = await inspectRecordingSources(input, input);
		const output = join(directory, "b-frame-output.mp4");
		await muxMediaTracksToMp4(input, input, output);
		const verified = await verifyRecording(output, {
			requireAudio: true,
			sourceEvidence,
		});
		expect(verified.sourcePreserved).toBe(true);
		expect(verified.video.frameCount).toBe(150);
		expect(verified.integrity).toEqual(sourceEvidence.integrity);
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

	test("preserves a short audio track that ends before the video starts", async () => {
		const input = join(directory, "early-audio.mp4");
		await run([
			"ffmpeg",
			"-v",
			"error",
			"-i",
			silent,
			"-map",
			"0:v:0",
			"-c:v",
			"copy",
			"-video_track_timescale",
			"90000",
			"-movflags",
			"empty_moov+frag_keyframe+default_base_moof",
			input,
		]);
		const bytes = await readFile(input);
		shiftFragmentClocks(bytes, 450000);
		await writeFile(input, bytes);
		const timing = await readRecordingVideoTiming(input, { timeoutMs: 5000 });
		expect(timing.firstTimestampTicks).toBe(450000n);
		expect(timing.lastTimestampTicks).toBe(897000n);
		expect(timing.lastDurationTicks).toBe(3000n);
		const sourceEvidence = await inspectRecordingSources(input, shortAudio);
		expect(sourceEvidence.audio?.endTime).toBeLessThan(
			sourceEvidence.video.startTime,
		);
		const output = join(directory, "preserved-early-audio.mp4");
		await muxMediaTracksToMp4(input, shortAudio, output);
		const verified = await verifyRecording(output, {
			requireAudio: true,
			sourceEvidence,
		});
		expect(verified.sourcePreserved).toBe(true);
		expect(verified.video.frameCount).toBe(150);
		expect(verified.integrity).toEqual(sourceEvidence.integrity);
	});

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

describe("recording timing metadata lifetime", () => {
	test.each(["cancel", "timeout"])(
		"joins a stalled raw terminal-duration read after %s",
		async (cause) => {
			const input = await tiedTimestampSource(`tied-raw-${cause}.mp4`, 2);
			const bytes = await readFile(input);
			const identity = '"tied-terminal-read"';
			let walked = false;
			const originalNext = EncodedPacketSink.prototype.getNextPacket;
			const next = spyOn(
				EncodedPacketSink.prototype,
				"getNextPacket",
			).mockImplementation(async function (
				this: EncodedPacketSink,
				...args: Parameters<typeof originalNext>
			) {
				const packet = await originalNext.apply(this, args);
				if (!packet) walked = true;
				return packet;
			});
			let began: (() => void) | undefined;
			const requested = new Promise<void>((resolve) => {
				began = resolve;
			});
			let ended: (() => void) | undefined;
			const closed = new Promise<void>((resolve) => {
				ended = resolve;
			});
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					expect(request.headers.get("if-match")).toBe(identity);
					const range = request.headers
						.get("range")
						?.match(/^bytes=(\d+)-(\d+)$/);
					if (!range) throw new Error("Fixture request has no range");
					const start = Number(range[1]);
					const end = Number(range[2]) + 1;
					const body = bytes.subarray(start, end);
					return new Response(
						walked
							? new ReadableStream({
									start(controller) {
										controller.enqueue(body.subarray(0, 1));
										began?.();
									},
									cancel() {
										ended?.();
									},
								})
							: body,
						{
							status: 206,
							headers: {
								ETag: identity,
								"Content-Length": String(end - start),
								"Content-Range": `bytes ${start}-${end - 1}/${bytes.length}`,
							},
						},
					);
				},
			});
			const controller = new AbortController();
			try {
				const outcome = readRecordingVideoTiming(
					`http://127.0.0.1:${server.port}/tied.mp4`,
					{
						timeoutMs: cause === "timeout" ? 1000 : 5000,
						abortSignal: controller.signal,
						remoteObject: { objectIdentity: identity, fileSize: bytes.length },
					},
				).catch((error: unknown) => error);
				await requested;
				if (cause === "cancel") controller.abort();
				const error = await outcome;
				expect(error).toBeInstanceOf(RecordingTimingError);
				if (!(error instanceof RecordingTimingError))
					throw new Error("Stalled raw read unexpectedly succeeded");
				expect(error.message).toContain(
					cause === "cancel" ? "cancelled" : "timed out",
				);
				expect(error.retryable).toBe(cause === "timeout");
				await closed;
			} finally {
				controller.abort();
				await server.stop(true);
				next.mockRestore();
			}
		},
		10_000,
	);

	test.each(["pre-format", "post-format"])(
		"joins a cancelled %s metadata read without leaking a rejected read",
		async (stage) => {
			const identity = '"metadata-cancellation"';
			const getFormat = Input.prototype.getFormat;
			let formatReady = false;
			const format = spyOn(Input.prototype, "getFormat").mockImplementation(
				async function (this: Input) {
					const result = await getFormat.call(this);
					formatReady = true;
					return result;
				},
			);
			let started: (() => void) | undefined;
			const request = new Promise<void>((resolve) => {
				started = resolve;
			});
			let stopped: (() => void) | undefined;
			const closed = new Promise<void>((resolve) => {
				stopped = resolve;
			});
			const requests: Request[] = [];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					requests.push(request);
					const range = request.headers
						.get("range")
						?.match(/^bytes=(\d+)-(\d+)$/);
					if (!range) throw new Error("Metadata request has no bounded range");
					const start = Number(range[1]);
					const end = Number(range[2]) + 1;
					const body = silentBytes.subarray(start, end);
					const stalled = stage === "pre-format" || formatReady;
					return new Response(
						stalled
							? new ReadableStream({
									start(controller) {
										controller.enqueue(body.subarray(0, 1));
										started?.();
									},
									cancel() {
										stopped?.();
									},
								})
							: body,
						{
							status: 206,
							headers: {
								ETag: identity,
								"Content-Length": String(end - start),
								"Content-Range": `bytes ${start}-${end - 1}/${silentBytes.length}`,
							},
						},
					);
				},
			});
			const controller = new AbortController();
			try {
				const outcome = readRecordingVideoTiming(
					`http://127.0.0.1:${server.port}/recording.mp4?signature=private-value`,
					{
						timeoutMs: 5_000,
						abortSignal: controller.signal,
						remoteObject: {
							objectIdentity: identity,
							fileSize: silentBytes.length,
						},
					},
				).catch((error: unknown) => error);
				await request;
				await new Promise<void>((resolve) => setImmediate(resolve));
				controller.abort();
				const error = await outcome;
				expect(error).toBeInstanceOf(RecordingTimingError);
				if (!(error instanceof RecordingTimingError)) {
					throw new Error("Cancelled metadata read unexpectedly succeeded");
				}
				expect(error.message).toContain("cancelled");
				expect(error.message).not.toContain("private-value");
				expect(error.retryable).toBe(false);
				expect(formatReady).toBe(stage === "post-format");
				await closed;
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(requests.length).toBeGreaterThan(0);
				for (const request of requests) {
					expect(request.headers.get("if-match")).toBe(identity);
				}
			} finally {
				controller.abort();
				await server.stop(true);
				format.mockRestore();
			}
		},
		10_000,
	);

	test.each([412, 503])(
		"classifies metadata HTTP %d failures without exposing provider details",
		async (status) => {
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch() {
					return new Response("Synthetic provider failure", { status });
				},
			});
			try {
				const error = await readRecordingVideoTiming(
					`http://127.0.0.1:${server.port}/recording.mp4?signature=private-value`,
					{
						timeoutMs: 1_000,
						remoteObject: {
							objectIdentity: '"metadata-failure"',
							fileSize: silentBytes.length,
						},
					},
				).catch((error: unknown) => error);
				expect(error).toBeInstanceOf(RecordingTimingError);
				if (!(error instanceof RecordingTimingError)) {
					throw new Error("Failed metadata request unexpectedly succeeded");
				}
				expect(error.message).toContain(`HTTP ${status}`);
				expect(error.message).not.toContain("private-value");
				expect(error.retryable).toBe(status === 503);
				await new Promise<void>((resolve) => setImmediate(resolve));
			} finally {
				await server.stop(true);
			}
		},
	);
});

describe("recording verification lifetime", () => {
	test.skipIf(process.platform === "win32")(
		"reclaims repeated decoder pipes without closing reused descriptors",
		async () => {
			for (let attempt = 0; attempt < 12; attempt++) {
				const source = await inspectRecordingSources(silent, silent);
				expect(source.fullDecode).toBe(true);
				const replacements = Array.from({ length: 32 }, () =>
					openSync(silent, "r"),
				);
				try {
					await new Promise<void>((resolve) => setImmediate(resolve));
					Bun.gc(true);
					for (const descriptor of replacements) {
						expect(fstatSync(descriptor).isFile()).toBe(true);
					}
				} finally {
					for (const descriptor of replacements) closeSync(descriptor);
				}
			}
		},
	);

	test.skipIf(process.platform === "win32").each(["truncated", "read-error"])(
		"rejects a %s decoded-content pipe and joins its decoder",
		async (fault) => {
			const original = Readable.prototype[Symbol.asyncIterator];
			let modified = false;
			const iterator = spyOn(
				Readable.prototype,
				Symbol.asyncIterator,
			).mockImplementation(function (this: Readable) {
				const source = original.call(this);
				if (modified) return source;
				modified = true;
				return Readable.from(
					(async function* () {
						let first = true;
						for await (const chunk of source) {
							if (!Buffer.isBuffer(chunk))
								throw new Error("Invalid fixture pipe bytes");
							if (fault === "read-error")
								throw new Error("Fixture pipe read failed");
							yield first ? chunk.subarray(1) : chunk;
							first = false;
						}
					})(),
				)[Symbol.asyncIterator]();
			});
			try {
				await expect(inspectRecordingSources(silent, silent)).rejects.toThrow(
					fault === "truncated"
						? "content is incomplete"
						: "Fixture pipe read failed",
				);
				expect(modified).toBe(true);
				expect(await decoderPids(silent)).toEqual([]);
			} finally {
				iterator.mockRestore();
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"cancels content pipes without closing a subsequently reused descriptor",
		async () => {
			const controller = new AbortController();
			const original = Readable.prototype[Symbol.asyncIterator];
			const streams: Readable[] = [];
			const iterator = spyOn(
				Readable.prototype,
				Symbol.asyncIterator,
			).mockImplementation(function (this: Readable) {
				streams.push(this);
				setImmediate(() => controller.abort());
				return original.call(this);
			});
			try {
				await expect(
					inspectRecordingSources(silent, silent, {
						abortSignal: controller.signal,
					}),
				).rejects.toThrow("cancelled");
				expect(streams.length).toBe(2);
				expect(streams.every((stream) => stream.destroyed)).toBe(true);
				expect(await decoderPids(silent)).toEqual([]);
				const replacement = openSync(silent, "r");
				try {
					Bun.gc(true);
					expect(fstatSync(replacement).isFile()).toBe(true);
				} finally {
					closeSync(replacement);
				}
			} finally {
				iterator.mockRestore();
			}
		},
	);

	test.skipIf(process.platform === "win32")(
		"joins a decoder and its backpressured content reader after timeout",
		async () => {
			const original = Readable.prototype[Symbol.asyncIterator];
			let modified = false;
			const iterator = spyOn(
				Readable.prototype,
				Symbol.asyncIterator,
			).mockImplementation(function (this: Readable) {
				const source = original.call(this);
				if (modified) return source;
				modified = true;
				return Readable.from(
					(async function* () {
						let first = true;
						for await (const chunk of source) {
							if (first)
								await new Promise((resolve) => setTimeout(resolve, 2_500));
							first = false;
							yield chunk;
						}
					})(),
				)[Symbol.asyncIterator]();
			});
			try {
				await expect(
					inspectRecordingSources(silent, silent, { timeoutMs: 2_000 }),
				).rejects.toThrow("timed out");
				expect(modified).toBe(true);
				expect(await decoderPids(silent)).toEqual([]);
			} finally {
				iterator.mockRestore();
			}
		},
	);

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
