import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeVideoFile } from "../../lib/media-probe";
import { stopProbeWorkers } from "../../lib/media-probe-pool";
import { spawn } from "../../lib/media-spawn";

// Older codecs a regular Cap import can carry, in the containers the probe
// reads (Matroska, MP4 and 3GP). Each fixture is made with the local FFmpeg,
// then probed and transcoded to H.264 and AAC through the same hardened spawn
// the server uses, so the codec and decoder lists are what decides. A family
// whose encoder this FFmpeg lacks is skipped here.
type Fixture = {
	name: string;
	file: string;
	video: string[];
	audio: string[] | null;
	encoders: string[];
};

const FIXTURES: Fixture[] = [
	{
		name: "MPEG-1 video with MPEG audio layer 2",
		file: "mpeg1.mkv",
		video: ["-c:v", "mpeg1video"],
		audio: ["-c:a", "mp2"],
		encoders: ["mpeg1video", "mp2"],
	},
	{
		name: "MPEG-2 video with MPEG audio layer 2",
		file: "mpeg2.mkv",
		video: ["-c:v", "mpeg2video"],
		audio: ["-c:a", "mp2"],
		encoders: ["mpeg2video", "mp2"],
	},
	{
		name: "Windows Media video 7 with Windows Media audio 1",
		file: "wmv1.mkv",
		video: ["-c:v", "wmv1"],
		audio: ["-c:a", "wmav1"],
		encoders: ["wmv1", "wmav1"],
	},
	{
		name: "Windows Media video 8 with Windows Media audio 2",
		file: "wmv2.mkv",
		video: ["-c:v", "wmv2"],
		audio: ["-c:a", "wmav2"],
		encoders: ["wmv2", "wmav2"],
	},
	{
		name: "early MPEG-4 (DivX 3) with Microsoft ADPCM",
		file: "msmpeg4v3.mkv",
		video: ["-c:v", "msmpeg4"],
		audio: ["-c:a", "adpcm_ms"],
		encoders: ["msmpeg4", "adpcm_ms"],
	},
	{
		name: "early MPEG-4 version 2 with IMA ADPCM",
		file: "msmpeg4v2.mkv",
		video: ["-c:v", "msmpeg4v2"],
		audio: ["-c:a", "adpcm_ima_wav"],
		encoders: ["msmpeg4v2", "adpcm_ima_wav"],
	},
	{
		name: "Flash video",
		file: "flv1.mkv",
		video: ["-c:v", "flv"],
		audio: ["-c:a", "aac"],
		encoders: ["flv", "aac"],
	},
	{
		name: "H.263 from a phone",
		file: "phone.3gp",
		video: ["-c:v", "h263"],
		audio: ["-c:a", "aac", "-ar", "8000", "-ac", "1"],
		encoders: ["h263", "aac"],
	},
	{
		name: "H.263 with AMR narrowband audio",
		file: "amrnb.3gp",
		video: ["-c:v", "h263"],
		audio: ["-c:a", "libopencore_amrnb", "-ar", "8000", "-ac", "1"],
		encoders: ["h263", "libopencore_amrnb"],
	},
	{
		name: "H.263 with AMR wideband audio",
		file: "amrwb.3gp",
		video: ["-c:v", "h263"],
		audio: ["-c:a", "libvo_amrwbenc", "-ar", "16000", "-ac", "1"],
		encoders: ["h263", "libvo_amrwbenc"],
	},
	{
		name: "Theora with Vorbis",
		file: "theora.mkv",
		video: ["-c:v", "libtheora"],
		audio: ["-c:a", "libvorbis"],
		encoders: ["libtheora", "libvorbis"],
	},
	{
		name: "H.264 with MPEG audio layer 2",
		file: "h264-mp2.mkv",
		video: ["-c:v", "libx264"],
		audio: ["-c:a", "mp2"],
		encoders: ["libx264", "mp2"],
	},
	{
		name: "H.264 with Windows Media audio 2",
		file: "h264-wma.mkv",
		video: ["-c:v", "libx264"],
		audio: ["-c:a", "wmav2"],
		encoders: ["libx264", "wmav2"],
	},
];

let dir = "";
// Read when the file loads: skipIf decides before beforeAll runs.
const encoders = new Set(
	Bun.spawnSync(["ffmpeg", "-hide_banner", "-encoders"])
		.stdout.toString()
		.split("\n")
		.map((line) => line.trim().split(/\s+/)[1] ?? ""),
);

async function run(cmd: string[]): Promise<{ code: number; stderr: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { code, stderr: stderr || stdout };
}

const available = (fixture: Fixture) =>
	fixture.encoders.every((name) => encoders.has(name));

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "legacy-codecs-"));
	for (const fixture of FIXTURES) {
		if (!available(fixture)) continue;
		const made = await run([
			"ffmpeg",
			"-v",
			"error",
			"-y",
			"-f",
			"lavfi",
			"-i",
			"testsrc=d=1:s=176x144:r=25",
			...(fixture.audio ? ["-f", "lavfi", "-i", "sine=d=1:r=44100"] : []),
			...fixture.video,
			...(fixture.audio ?? []),
			join(dir, fixture.file),
		]);
		if (made.code !== 0)
			throw new Error(`could not make ${fixture.file}: ${made.stderr}`);
	}
}, 120_000);

afterAll(async () => {
	stopProbeWorkers();
	await rm(dir, { recursive: true, force: true });
});

describe("older formats a regular import can carry", () => {
	for (const fixture of FIXTURES) {
		test.skipIf(!available(fixture))(
			`${fixture.name} probes and transcodes`,
			async () => {
				const input = join(dir, fixture.file);
				const metadata = await probeVideoFile(input);
				expect(metadata.width).toBe(176);
				expect(metadata.height).toBe(144);

				const output = join(dir, `${fixture.file}.mp4`);
				const transcode = spawn({
					cmd: [
						"ffmpeg",
						"-v",
						"error",
						"-y",
						"-i",
						input,
						"-c:v",
						"libx264",
						"-preset",
						"ultrafast",
						"-c:a",
						"aac",
						output,
					],
					stdout: "ignore",
					stderr: "pipe",
				});
				const [code, stderr] = await Promise.all([
					transcode.exited,
					new Response(transcode.stderr).text(),
				]);
				expect(stderr).not.toContain("not on whitelist");
				expect(code).toBe(0);

				const streams = await run([
					"ffprobe",
					"-v",
					"error",
					"-show_entries",
					"stream=codec_type,codec_name",
					"-of",
					"csv=p=0",
					output,
				]);
				expect(streams.stderr).toContain("h264,video");
				if (fixture.audio) expect(streams.stderr).toContain("aac,audio");
			},
			60_000,
		);
	}
});
