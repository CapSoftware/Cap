import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type EncodedHlsLadder,
	encodeHlsLadder,
} from "../../lib/hls-ladder-encode";
import { probeVideoFile } from "../../lib/media-probe";
import {
	generateThumbnail,
	probeVideoSourceTraits,
	processVideo,
} from "../../lib/media-video";

const directory = mkdtempSync(join(tmpdir(), "hdr-to-sdr-"));
const standard = join(directory, "standard.mp4");
// A flat, saturated mid-tone: dark enough that the tone curve passes it through
// untouched, so the converted picture has to match the standard range one, and
// coloured enough that leaving the wide colour range in place shows.
const PATCH = "color=c=0x903050:size=320x180:rate=10:duration=1";
const JPEG_TO_VIDEO_RANGE = "scale=in_range=pc:out_range=tv,format=yuv420p,";
const DOLBY_VISION_PROFILE_5 = join(
	import.meta.dir,
	"..",
	"fixtures",
	"test-dolby-vision-p5.mp4",
);

function ffmpeg(args: string[]): boolean {
	return spawnSync("ffmpeg", ["-v", "error", "-y", ...args]).status === 0;
}

interface HdrSourceColor {
	primaries: string;
	matrix: string;
	primariesCode: number;
	matrixCode: number;
}

const UNSPECIFIED = 2;
const BT2020: HdrSourceColor = {
	primaries: "bt2020",
	matrix: "bt2020nc",
	primariesCode: 9,
	matrixCode: 9,
};

function writeHdr(
	name: string,
	transfer: string,
	code: number,
	color: HdrSourceColor = BT2020,
): string | null {
	const path = join(directory, name);
	const written = ffmpeg([
		"-f",
		"lavfi",
		"-i",
		PATCH,
		"-vf",
		`zscale=tin=bt709:pin=bt709:min=bt709:rin=tv:p=${color.primaries}:m=${color.matrix}:r=tv:npl=203:t=${transfer},format=yuv420p10le`,
		"-c:v",
		"libx264",
		"-bsf:v",
		`h264_metadata=colour_primaries=${color.primariesCode}:transfer_characteristics=${code}:matrix_coefficients=${color.matrixCode}`,
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
			pqBt709: writeHdr("pq-bt709.mp4", "smpte2084", 16, {
				primaries: "bt709",
				matrix: "bt709",
				primariesCode: 1,
				matrixCode: 1,
			}),
			pqDisplayP3: writeHdr("pq-p3.mp4", "smpte2084", 16, {
				primaries: "smpte432",
				matrix: "bt2020nc",
				primariesCode: 12,
				matrixCode: 9,
			}),
			pqUntagged: writeHdr("pq-untagged.mp4", "smpte2084", 16, {
				...BT2020,
				primariesCode: UNSPECIFIED,
				matrixCode: UNSPECIFIED,
			}),
		}
	: {
			hlg: null,
			pq: null,
			pqBt709: null,
			pqDisplayP3: null,
			pqUntagged: null,
		};
const canConvert = Object.values(sources).every((source) => source !== null);

function picture(path: string, prepare = "") {
	const stats = spawnSync("ffmpeg", [
		"-v",
		"error",
		"-i",
		path,
		"-frames:v",
		"1",
		"-vf",
		`${prepare}signalstats,metadata=print:file=-`,
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
		{
			name: "HLG",
			key: "hlg" as const,
			transfer: "arib-std-b67",
			color: { primaries: "bt2020", matrix: "bt2020nc" },
		},
		{
			name: "PQ",
			key: "pq" as const,
			transfer: "smpte2084",
			color: { primaries: "bt2020", matrix: "bt2020nc" },
		},
		{
			name: "PQ with BT.709 primaries",
			key: "pqBt709" as const,
			transfer: "smpte2084",
			color: { primaries: "bt709", matrix: "bt709" },
		},
		{
			name: "PQ with Display P3 primaries",
			key: "pqDisplayP3" as const,
			transfer: "smpte2084",
			color: { primaries: "smpte432", matrix: "bt2020nc" },
		},
		{
			name: "PQ without primaries or matrix tags",
			key: "pqUntagged" as const,
			transfer: "smpte2084",
			color: { primaries: "unknown", matrix: "unknown" },
		},
	])(
		"$name video comes out of the MP4 and HLS encoders with the colours of the standard range original",
		async ({ key, transfer, color }) => {
			const source = sources[key] as string;
			const original = picture(standard);
			expect(await probeVideoSourceTraits(source)).toEqual({
				rotation: 0,
				hdr: transfer,
				hdrColor: color,
			});
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

			const poster = join(directory, `${key}-poster.jpg`);
			writeFileSync(
				poster,
				await generateThumbnail(
					ladder.poster.path,
					ladder.poster.durationSeconds,
				),
			);
			const posterPicture = picture(poster, JPEG_TO_VIDEO_RANGE);
			expect(Math.abs(posterPicture.luma - original.luma)).toBeLessThan(4);
			expect(Math.abs(posterPicture.blue - original.blue)).toBeLessThan(4);
			expect(Math.abs(posterPicture.red - original.red)).toBeLessThan(4);
		},
		120_000,
	);

	test("Dolby Vision profile 5 is refused by both encoders instead of encoded with the wrong colours", async () => {
		const metadata = await probeVideoFile(DOLBY_VISION_PROFILE_5);
		await expect(
			processVideo(DOLBY_VISION_PROFILE_5, metadata, {}),
		).rejects.toThrow("Dolby Vision profile 5");
		await expect(
			encodeHlsLadder(DOLBY_VISION_PROFILE_5, metadata),
		).rejects.toThrow("Dolby Vision profile 5");
	}, 60_000);
});
