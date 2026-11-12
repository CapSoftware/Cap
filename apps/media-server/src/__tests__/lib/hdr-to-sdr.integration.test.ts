import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type EncodedHlsLadder,
	encodeHlsLadder,
} from "../../lib/hls-ladder-encode";
import { probeVideoFile } from "../../lib/media-probe";
import { probeVideoSourceTraits, processVideo } from "../../lib/media-video";

const directory = mkdtempSync(join(tmpdir(), "hdr-to-sdr-"));
const standard = join(directory, "standard.mp4");
// A flat, saturated mid-tone: dark enough that the tone curve passes it through
// untouched, so the converted picture has to match the standard range one, and
// coloured enough that leaving the wide colour range in place shows.
const PATCH = "color=c=0x903050:size=320x180:rate=10:duration=1";

function ffmpeg(args: string[]): boolean {
	return spawnSync("ffmpeg", ["-v", "error", "-y", ...args]).status === 0;
}

function writeHdr(name: string, transfer: string, code: number): string | null {
	const path = join(directory, name);
	const written = ffmpeg([
		"-f",
		"lavfi",
		"-i",
		PATCH,
		"-vf",
		`zscale=tin=bt709:pin=bt709:min=bt709:rin=tv:p=bt2020:m=bt2020nc:r=tv:npl=203:t=${transfer},format=yuv420p10le`,
		"-c:v",
		"libx264",
		"-bsf:v",
		`h264_metadata=colour_primaries=9:transfer_characteristics=${code}:matrix_coefficients=9`,
		path,
	]);
	return written ? path : null;
}

const wroteStandard = ffmpeg([
	"-f",
	"lavfi",
	"-i",
	PATCH,
	"-pix_fmt",
	"yuv420p",
	"-c:v",
	"libx264",
	standard,
]);
// The conversion needs an ffmpeg with zscale and a 10-bit x264. The encoder
// image has both; a machine without them cannot make the sources.
const sources = wroteStandard
	? {
			hlg: writeHdr("hlg.mp4", "arib-std-b67", 18),
			pq: writeHdr("pq.mp4", "smpte2084", 16),
		}
	: { hlg: null, pq: null };
const canConvert = sources.hlg !== null && sources.pq !== null;

function picture(path: string) {
	const stats = spawnSync("ffmpeg", [
		"-v",
		"error",
		"-i",
		path,
		"-frames:v",
		"1",
		"-vf",
		"signalstats,metadata=print:file=-",
		"-f",
		"null",
		"-",
	]).stdout.toString();
	const average = (name: string) =>
		Number(stats.match(new RegExp(`signalstats\\.${name}=([0-9.]+)`))?.[1]);
	const tags = spawnSync("ffprobe", [
		"-v",
		"error",
		"-select_streams",
		"v:0",
		"-count_frames",
		"-show_entries",
		"stream=pix_fmt,color_transfer,color_primaries,color_space,nb_read_frames",
		"-of",
		"default=noprint_wrappers=1",
		path,
	]).stdout.toString();
	const tag = (name: string) =>
		tags.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
	return {
		luma: average("YAVG"),
		blue: average("UAVG"),
		red: average("VAVG"),
		pixelFormat: tag("pix_fmt"),
		transfer: tag("color_transfer"),
		primaries: tag("color_primaries"),
		matrix: tag("color_space"),
		frames: Number(tag("nb_read_frames")),
	};
}

function expectStandardRange(
	output: ReturnType<typeof picture>,
	original: ReturnType<typeof picture>,
) {
	expect(output.pixelFormat).toBe("yuv420p");
	expect(output.transfer).toBe("bt709");
	expect(output.primaries).toBe("bt709");
	expect(output.matrix).toBe("bt709");
	expect(output.frames).toBe(original.frames);
	expect(Math.abs(output.luma - original.luma)).toBeLessThan(4);
	expect(Math.abs(output.blue - original.blue)).toBeLessThan(4);
	expect(Math.abs(output.red - original.red)).toBeLessThan(4);
}

describe("HDR to standard range", () => {
	const ladders: EncodedHlsLadder[] = [];

	afterAll(async () => {
		await Promise.all(ladders.map((ladder) => ladder.cleanup()));
		rmSync(directory, { recursive: true, force: true });
	});

	test.skipIf(!canConvert).each([
		{ name: "HLG", key: "hlg" as const, transfer: "arib-std-b67" },
		{ name: "PQ", key: "pq" as const, transfer: "smpte2084" },
	])(
		"$name video comes out of the MP4 and HLS encoders with the colours of the standard range original",
		async ({ key, transfer }) => {
			const source = sources[key] as string;
			const original = picture(standard);
			expect((await probeVideoSourceTraits(source)).hdr).toBe(transfer);
			// Decoded as it is, the HDR file is nowhere near the original, so a
			// conversion that did nothing would fail the comparisons below.
			const untouched = picture(source);
			expect(
				Math.abs(untouched.luma / 4 - original.luma) +
					Math.abs(untouched.blue / 4 - original.blue) +
					Math.abs(untouched.red / 4 - original.red),
			).toBeGreaterThan(20);

			const metadata = await probeVideoFile(source);
			const mp4 = await processVideo(source, metadata, {
				maxWidth: 320,
				maxHeight: 320,
			});
			try {
				expectStandardRange(picture(mp4.path), original);
			} finally {
				await mp4.cleanup();
			}

			const ladder = await encodeHlsLadder(source, metadata);
			ladders.push(ladder);
			const [rendition] = ladder.result.renditions;
			const playlist = ladder.files.find(
				(file) => file.name === rendition?.playlist,
			);
			expect(playlist).toBeDefined();
			expectStandardRange(picture(playlist?.path ?? ""), original);
		},
		120_000,
	);
});
