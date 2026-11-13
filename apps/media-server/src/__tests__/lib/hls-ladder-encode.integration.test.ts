import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type HlsLadderRange,
	hlsSegmentDurations,
	parseHlsLadderMaster,
	planHlsLadderSlices,
	stitchHlsLadderSlices,
} from "../../lib/hls-ladder";
import {
	type EncodedHlsLadder,
	encodeHlsLadder,
} from "../../lib/hls-ladder-encode";
import {
	getMaxConcurrentProbeOperations,
	registerMediaOperation,
	unregisterMediaOperation,
} from "../../lib/media-operations";
import { probeVideoFile } from "../../lib/media-probe";
import { generateThumbnail } from "../../lib/media-video";
import { getActiveSubprocessCount } from "../../lib/subprocess";

const SOURCE_SECONDS = 26;

function videoFrameTimes(playlist: string): number[] {
	const output = execFileSync(
		"ffprobe",
		[
			"-v",
			"error",
			"-allowed_extensions",
			"ALL",
			"-select_streams",
			"v:0",
			"-show_entries",
			"packet=pts_time",
			"-of",
			"csv=p=0",
			playlist,
		],
		{ encoding: "utf8" },
	);
	return output
		.split("\n")
		.map((line) => Number.parseFloat(line))
		.filter((value) => Number.isFinite(value))
		.sort((a, b) => a - b);
}

function streamSeconds(playlist: string, stream: string): number {
	const output = execFileSync(
		"ffprobe",
		[
			"-v",
			"error",
			"-allowed_extensions",
			"ALL",
			"-select_streams",
			stream,
			"-show_entries",
			"packet=pts_time,duration_time",
			"-of",
			"csv=p=0",
			playlist,
		],
		{ encoding: "utf8" },
	);
	const packets = output
		.split("\n")
		.map((line) => line.split(",").map(Number.parseFloat))
		.filter(([pts]) => Number.isFinite(pts));
	const first = Math.min(...packets.map(([pts]) => pts ?? 0));
	const last = Math.max(
		...packets.map(([pts, duration]) => (pts ?? 0) + (duration || 0)),
	);
	return last - first;
}

function fileNamed(ladder: EncodedHlsLadder, name: string) {
	const file = ladder.files.find((candidate) => candidate.name === name);
	if (!file) throw new Error(`missing ${name}`);
	return file;
}

describe("HLS ladder encode", () => {
	const directory = mkdtempSync(join(tmpdir(), "cap-hls-ladder-"));
	const source = join(directory, "source.mp4");
	const ladders: EncodedHlsLadder[] = [];

	function writeSource(path: string, extraOutputArgs: string[] = []) {
		execFileSync("ffmpeg", [
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			`testsrc2=size=1280x720:rate=30000/1001:duration=${SOURCE_SECONDS}`,
			"-f",
			"lavfi",
			"-i",
			`sine=frequency=440:duration=${SOURCE_SECONDS}`,
			"-c:v",
			"libx264",
			"-preset",
			"ultrafast",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			...extraOutputArgs,
			"-y",
			path,
		]);
	}

	beforeAll(() => {
		writeSource(source);
	});

	afterAll(async () => {
		await Promise.all(ladders.map((ladder) => ladder.cleanup()));
		rmSync(directory, { recursive: true, force: true });
	});

	async function encode(
		range?: HlsLadderRange,
		includeAudio = true,
		path = source,
	) {
		const metadata = await probeVideoFile(path);
		const ladder = await encodeHlsLadder(path, metadata, {
			range,
			includeAudio,
		});
		ladders.push(ladder);
		return ladder;
	}

	function stitch(slices: EncodedHlsLadder[], name: string) {
		const stitched = stitchHlsLadderSlices(
			slices.map((slice) => ({
				master: readFileSync(fileNamed(slice, "master.m3u8").path, "utf8"),
				playlists: Object.fromEntries(
					slice.result.renditions.map((rendition) => [
						rendition.name,
						readFileSync(fileNamed(slice, rendition.playlist).path, "utf8"),
					]),
				),
			})),
			{ hasAudio: true },
		);
		const output = join(directory, name);
		mkdirSync(output);
		writeFileSync(join(output, "master.m3u8"), stitched.master);
		for (const [playlist, text] of Object.entries(stitched.playlists)) {
			writeFileSync(join(output, playlist), text);
		}
		for (const media of stitched.media) {
			const slice = slices[media.slice];
			if (!slice) throw new Error("missing slice");
			copyFileSync(
				fileNamed(slice, media.source).path,
				join(output, media.name),
			);
		}
		const [first] = slices;
		if (!first) throw new Error("missing slice");
		for (const audio of ["audio.m3u8", "audio.m4s"]) {
			copyFileSync(fileNamed(first, audio).path, join(output, audio));
		}
		return output;
	}

	function expectSameFrames(stitched: number[], whole: number[]) {
		expect(stitched.length).toBe(whole.length);
		expect(new Set(stitched).size).toBe(stitched.length);
		const stitchedStart = stitched[0] ?? Number.NaN;
		const wholeStart = whole[0] ?? Number.NaN;
		const frame = 1001 / 30000;
		for (const [index, time] of stitched.entries()) {
			const expected = (whole[index] ?? Number.NaN) - wholeStart;
			expect(Math.abs(time - stitchedStart - expected)).toBeLessThan(0.001);
			if (index > 0) {
				const gap = time - (stitched[index - 1] ?? 0);
				expect(Math.abs(gap - frame)).toBeLessThan(0.001);
			}
		}
	}

	test("encodes every rendition with shared audio and aligned segments", async () => {
		const ladder = await encode();
		expect(ladder.result.encoder).toBe("libx264");
		expect(ladder.result.renditions.map((rendition) => rendition.name)).toEqual(
			["720p", "360p"],
		);
		expect(ladder.result.renditions[0]).toMatchObject({
			width: 1280,
			height: 720,
		});
		expect(ladder.result.audio?.media).toBe("audio.m4s");
		expect(ladder.files.map((file) => file.name).sort()).toEqual([
			"360p.m3u8",
			"360p.m4s",
			"720p.m3u8",
			"720p.m4s",
			"audio.m3u8",
			"audio.m4s",
			"master.m3u8",
		]);
		const master = readFileSync(fileNamed(ladder, "master.m3u8").path, "utf8");
		expect(parseHlsLadderMaster(master).audio?.playlist).toBe("audio.m3u8");
		const top = hlsSegmentDurations(
			readFileSync(fileNamed(ladder, "720p.m3u8").path, "utf8"),
		);
		const low = hlsSegmentDurations(
			readFileSync(fileNamed(ladder, "360p.m3u8").path, "utf8"),
		);
		expect(top).toEqual(low);
		expect(Math.max(...top)).toBeLessThanOrEqual(4.1);
		const playlist = readFileSync(fileNamed(ladder, "720p.m3u8").path, "utf8");
		expect(playlist).toContain("#EXT-X-BYTERANGE:");
		expect(playlist).toContain("#EXT-X-ENDLIST");
	}, 120_000);

	test("slices encoded separately stitch into the same frames as one encode", async () => {
		const whole = await encode();
		const wholeFrames = videoFrameTimes(fileNamed(whole, "720p.m3u8").path);

		const ranges = planHlsLadderSlices(SOURCE_SECONDS, 2, 8);
		expect(ranges).toEqual([
			{ startSeconds: 0, durationSeconds: 16 },
			{ startSeconds: 16 },
		]);
		const slices = await Promise.all(
			ranges.map((range, index) => encode(range, index === 0)),
		);
		expect(slices[0]?.result.audio).not.toBeNull();
		expect(slices[1]?.result.audio).toBeNull();

		const output = stitch(slices, "stitched");
		expectSameFrames(videoFrameTimes(join(output, "720p.m3u8")), wholeFrames);
		expect(videoFrameTimes(join(output, "360p.m3u8")).length).toBe(
			wholeFrames.length,
		);

		const audioSeconds = streamSeconds(join(output, "master.m3u8"), "a:0");
		const videoSeconds = streamSeconds(join(output, "master.m3u8"), "v:0");
		expect(audioSeconds).toBeGreaterThan(SOURCE_SECONDS - 1);
		expect(Math.abs(audioSeconds - videoSeconds)).toBeLessThan(0.5);
	}, 180_000);

	test("a slice leaves out the audio unless it asks for it", async () => {
		const slice = await encodeHlsLadder(source, await probeVideoFile(source), {
			range: { startSeconds: 16 },
		});
		ladders.push(slice);
		expect(slice.result.audio).toBeNull();
		expect(slice.files.map((file) => file.name)).not.toContain("audio.m4s");
	}, 120_000);

	test("slices line up when the source does not start at zero", async () => {
		const offset = join(directory, "offset.mp4");
		writeSource(offset, ["-output_ts_offset", "10"]);
		const whole = await encode(undefined, true, offset);
		const wholeFrames = videoFrameTimes(fileNamed(whole, "720p.m3u8").path);
		const slices = await Promise.all(
			planHlsLadderSlices(SOURCE_SECONDS, 2, 8).map((range, index) =>
				encode(range, index === 0, offset),
			),
		);
		const output = stitch(slices, "stitched-offset");
		expectSameFrames(videoFrameTimes(join(output, "720p.m3u8")), wholeFrames);
	}, 180_000);

	function writeFiltered(path: string, seconds: number, select: string) {
		execFileSync("ffmpeg", [
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			`testsrc2=size=640x360:rate=30:duration=${seconds}`,
			"-vf",
			`select='${select}'`,
			"-fps_mode",
			"vfr",
			"-c:v",
			"libx264",
			"-preset",
			"ultrafast",
			"-pix_fmt",
			"yuv420p",
			"-y",
			path,
		]);
	}

	function framesBetween(times: number[], start: number, end: number) {
		return times.filter((time) => time >= start - 0.001 && time < end - 0.001)
			.length;
	}

	test("keeps every frame of a source that starts slowly and speeds up", async () => {
		const variable = join(directory, "variable.mp4");
		writeFiltered(variable, 20, "if(lt(t,12),not(mod(n,15)),1)");
		const sourceFrames = videoFrameTimes(variable);
		expect(framesBetween(sourceFrames, 0, 12)).toBe(24);
		expect(framesBetween(sourceFrames, 12, 20)).toBe(240);
		expect((await probeVideoFile(variable)).fps).toBeLessThan(10);

		const whole = await encode(undefined, true, variable);
		for (const rendition of whole.result.renditions) {
			const frames = videoFrameTimes(fileNamed(whole, rendition.playlist).path);
			expect(framesBetween(frames, 12, 20)).toBe(240);
			expect(frames.length).toBe(600);
		}

		const slices = await Promise.all(
			planHlsLadderSlices(20, 2, 8).map((range) =>
				encode(range, false, variable),
			),
		);
		const sliced = slices.flatMap((slice) =>
			videoFrameTimes(fileNamed(slice, "360p.m3u8").path),
		);
		expect(sliced.length).toBe(600);
		expect(new Set(sliced.map((time) => Math.round(time * 30))).size).toBe(600);
		expect(framesBetween(sliced, 12, 20)).toBe(240);
	}, 180_000);

	test("fails instead of guessing the frame rate when the probe pool is full", async () => {
		const metadata = await probeVideoFile(source);
		const subprocesses = getActiveSubprocessCount();
		const running = Array.from(
			{ length: getMaxConcurrentProbeOperations() },
			() => registerMediaOperation("probe", () => {}),
		);
		try {
			await expect(encodeHlsLadder(source, metadata)).rejects.toThrow(
				"Server is busy",
			);
			expect(getActiveSubprocessCount()).toBe(subprocesses);
		} finally {
			for (const operation of running) unregisterMediaOperation(operation);
		}
	}, 60_000);

	test("starts a slice on time when it begins inside a still stretch", async () => {
		const still = join(directory, "still.mp4");
		writeFiltered(still, SOURCE_SECONDS, "not(between(t,13,20))");
		expect(framesBetween(videoFrameTimes(still), 13.1, 20)).toBe(0);
		const whole = videoFrameTimes(
			fileNamed(await encode(undefined, true, still), "360p.m3u8").path,
		);
		expect(whole.length).toBe(SOURCE_SECONDS * 30);

		const ranges = planHlsLadderSlices(SOURCE_SECONDS, 2, 8);
		expect(ranges[1]).toEqual({ startSeconds: 16 });
		const [first, second] = await Promise.all(
			ranges.map((range) => encode(range, false, still)),
		);
		if (!first || !second) throw new Error("missing slice");
		const firstFrames = videoFrameTimes(fileNamed(first, "360p.m3u8").path);
		const secondFrames = videoFrameTimes(fileNamed(second, "360p.m3u8").path);
		expect(firstFrames.length).toBe(16 * 30);
		expect(secondFrames.length).toBe((SOURCE_SECONDS - 16) * 30);
		expect(secondFrames[0]).toBeCloseTo(16, 3);
		expect(firstFrames.length + secondFrames.length).toBe(whole.length);

		const bounded = videoFrameTimes(
			fileNamed(
				await encode({ startSeconds: 16, durationSeconds: 4 }, false, still),
				"360p.m3u8",
			).path,
		);
		const wholeBetween = whole.filter(
			(time) => time >= 16 - 0.001 && time < 20 - 0.001,
		);
		expect(bounded.length).toBe(4 * 30);
		expect(bounded.length).toBe(wholeBetween.length);
		expect(bounded[0]).toBeCloseTo(wholeBetween[0] ?? Number.NaN, 3);
		expect(bounded.at(-1)).toBeCloseTo(wholeBetween.at(-1) ?? Number.NaN, 3);
	}, 180_000);

	test("keeps audio in a codec the probe cannot name", async () => {
		const lossless = join(directory, "lossless.mov");
		execFileSync("ffmpeg", [
			"-v",
			"error",
			"-i",
			source,
			"-t",
			"6",
			"-c:v",
			"copy",
			"-c:a",
			"alac",
			"-y",
			lossless,
		]);
		const metadata = await probeVideoFile(lossless);
		expect(metadata.audioCodec).toBeNull();
		expect(metadata.audioChannels).toBe(1);

		const ladder = await encode(undefined, true, lossless);
		expect(ladder.result.audio?.media).toBe("audio.m4s");
		const master = fileNamed(ladder, "master.m3u8").path;
		expect(streamSeconds(master, "a:0")).toBeGreaterThan(5.5);

		const slice = await encode({ startSeconds: 0 }, true, lossless);
		expect(slice.result.audio?.media).toBe("audio.m4s");
	}, 120_000);

	test("offers its largest rendition as the source of the poster", async () => {
		const ladder = await encode();
		expect(ladder.poster.path).toBe(fileNamed(ladder, "720p.m4s").path);
		expect(ladder.poster.durationSeconds).toBeCloseTo(SOURCE_SECONDS, 0);
		const poster = await generateThumbnail(
			ladder.poster.path,
			ladder.poster.durationSeconds,
		);
		expect(poster[0]).toBe(0xff);
		expect(poster[1]).toBe(0xd8);

		const slice = await encode({ startSeconds: 16 }, false);
		expect(slice.poster.durationSeconds).toBeCloseTo(SOURCE_SECONDS - 16, 0);
		const slicePoster = await generateThumbnail(
			slice.poster.path,
			slice.poster.durationSeconds,
		);
		expect(slicePoster[1]).toBe(0xd8);
	}, 180_000);

	test("keeps a rotated source in the orientation it plays in", async () => {
		const rotated = join(directory, "rotated.mp4");
		execFileSync("ffmpeg", [
			"-v",
			"error",
			"-display_rotation",
			"90",
			"-i",
			source,
			"-c",
			"copy",
			"-t",
			"6",
			"-y",
			rotated,
		]);
		const ladder = await encode(undefined, true, rotated);
		expect(ladder.result.renditions[0]).toMatchObject({
			name: "720p",
			width: 720,
			height: 1280,
		});
	}, 120_000);
});
