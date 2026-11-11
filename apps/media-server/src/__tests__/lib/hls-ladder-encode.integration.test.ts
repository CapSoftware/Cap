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
import { probeVideoFile } from "../../lib/media-probe";

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

function fileNamed(ladder: EncodedHlsLadder, name: string) {
	const file = ladder.files.find((candidate) => candidate.name === name);
	if (!file) throw new Error(`missing ${name}`);
	return file;
}

describe("HLS ladder encode", () => {
	const directory = mkdtempSync(join(tmpdir(), "cap-hls-ladder-"));
	const source = join(directory, "source.mp4");
	const ladders: EncodedHlsLadder[] = [];

	beforeAll(() => {
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
			"-y",
			source,
		]);
	});

	afterAll(async () => {
		await Promise.all(ladders.map((ladder) => ladder.cleanup()));
		rmSync(directory, { recursive: true, force: true });
	});

	async function encode(range?: HlsLadderRange, includeAudio = true) {
		const metadata = await probeVideoFile(source);
		const ladder = await encodeHlsLadder(source, metadata, {
			range,
			includeAudio,
		});
		ladders.push(ladder);
		return ladder;
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

		const output = join(directory, "stitched");
		mkdirSync(output);
		writeFileSync(join(output, "master.m3u8"), stitched.master);
		for (const [name, text] of Object.entries(stitched.playlists)) {
			writeFileSync(join(output, name), text);
		}
		for (const media of stitched.media) {
			const slice = slices[media.slice];
			if (!slice) throw new Error("missing slice");
			copyFileSync(
				fileNamed(slice, media.source).path,
				join(output, media.name),
			);
		}

		const stitchedFrames = videoFrameTimes(join(output, "720p.m3u8"));
		expect(stitchedFrames.length).toBe(wholeFrames.length);
		expect(new Set(stitchedFrames).size).toBe(stitchedFrames.length);
		const stitchedStart = stitchedFrames[0] ?? Number.NaN;
		const wholeStart = wholeFrames[0] ?? Number.NaN;
		for (const [index, time] of stitchedFrames.entries()) {
			const expected = (wholeFrames[index] ?? Number.NaN) - wholeStart;
			expect(Math.abs(time - stitchedStart - expected)).toBeLessThan(0.001);
		}
		const frame = 1001 / 30000;
		for (let index = 1; index < stitchedFrames.length; index++) {
			const gap =
				(stitchedFrames[index] ?? 0) - (stitchedFrames[index - 1] ?? 0);
			expect(Math.abs(gap - frame)).toBeLessThan(0.001);
		}
		expect(videoFrameTimes(join(output, "360p.m3u8")).length).toBe(
			wholeFrames.length,
		);
	}, 180_000);
});
