import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VideoMetadata } from "../../lib/job-manager";
import { encodeLengthLimit } from "../../lib/media-common";
import { probeVideoFile } from "../../lib/media-probe";
import { stopProbeWorkers } from "../../lib/media-probe-pool";
import { processVideo } from "../../lib/media-video";

// The real length of every file below, whatever its header says.
const SECONDS = 10;

let dir = "";

async function run(cmd: string[]): Promise<string> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (code !== 0) throw new Error(stderr);
	return stdout;
}

async function lengthOf(path: string): Promise<number> {
	return Number(
		(
			await run([
				"ffprobe",
				"-v",
				"error",
				"-show_entries",
				"format=duration",
				"-of",
				"csv=p=0",
				path,
			])
		).trim(),
	);
}

// The Matroska Duration element (0x4489, an 8-byte float).
function durationElement(data: Buffer): number {
	const at = data.indexOf(Buffer.from([0x44, 0x89, 0x88]));
	if (at === -1) throw new Error("No Duration element");
	return at;
}

// What a recorder that never finalises its file leaves: no Duration at all.
// The element becomes a Void element of the same size.
function withoutDuration(bytes: Buffer): Buffer {
	const data = Buffer.from(bytes);
	const at = durationElement(data);
	data[at] = 0xec;
	data[at + 1] = 0x89;
	data.fill(0, at + 2, at + 11);
	return data;
}

function withDurationMs(bytes: Buffer, milliseconds: number): Buffer {
	const data = Buffer.from(bytes);
	data.writeDoubleBE(milliseconds, durationElement(data) + 3);
	return data;
}

// Sets the movie header (mvhd) duration of an MP4, leaving the tracks alone.
function withShortMovieHeader(bytes: Buffer, seconds: number): Buffer {
	const data = Buffer.from(bytes);
	const at = data.indexOf(Buffer.from("mvhd", "latin1"));
	if (at === -1 || data[at + 4] !== 0) throw new Error("No version 0 mvhd");
	const body = at + 4;
	const timescale = data.readUInt32BE(body + 12);
	data.writeUInt32BE(Math.round(seconds * timescale), body + 16);
	return data;
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "encode-length-"));
	const source = [
		"ffmpeg",
		"-v",
		"error",
		"-y",
		"-f",
		"lavfi",
		"-i",
		`testsrc=d=${SECONDS}:s=128x96:r=10`,
		"-f",
		"lavfi",
		"-i",
		`sine=d=${SECONDS}`,
	];
	const webm = join(dir, "recording.webm");
	await run([...source, "-c:v", "libvpx", "-c:a", "libopus", webm]);
	const mp4 = join(dir, "recording.mp4");
	await run([...source, "-c:v", "libx264", "-c:a", "aac", mp4]);
	const recording = await readFile(webm);
	await writeFile(join(dir, "no-duration.webm"), withoutDuration(recording));
	await writeFile(
		join(dir, "short-duration.webm"),
		withDurationMs(recording, 2_000),
	);
	await writeFile(
		join(dir, "short-mvhd.mp4"),
		withShortMovieHeader(await readFile(mp4), 2),
	);
}, 60_000);

afterAll(async () => {
	stopProbeWorkers();
	await rm(dir, { recursive: true, force: true });
});

describe("the encode length limit never cuts a real file short", () => {
	test.each([
		["no-duration.webm", "a WebM with no Duration element"],
		["short-duration.webm", "a WebM whose Duration says less than it plays"],
		["short-mvhd.mp4", "an MP4 whose movie header says less than its tracks"],
	])(
		"%s (%s)",
		async (name) => {
			const path = join(dir, name);
			const metadata = await probeVideoFile(path);
			const limit = encodeLengthLimit(metadata);
			if (limit !== null) expect(limit).toBeGreaterThanOrEqual(SECONDS);

			const output = await processVideo(path, metadata, {});
			try {
				expect(await lengthOf(output.path)).toBeGreaterThanOrEqual(
					SECONDS - 0.2,
				);
			} finally {
				await output.cleanup();
			}
		},
		60_000,
	);

	test("a recovery encode is not held to any length", async () => {
		const path = join(dir, "short-duration.webm");
		const metadata: VideoMetadata = {
			...(await probeVideoFile(path)),
			// A header that is wrong in the way recovery input often is.
			duration: 2,
			timestampSpan: 2,
		};
		const output = await processVideo(
			path,
			metadata,
			{},
			undefined,
			undefined,
			{
				genPts: true,
			},
		);
		try {
			expect(await lengthOf(output.path)).toBeGreaterThanOrEqual(SECONDS - 0.2);
		} finally {
			await output.cleanup();
		}
	}, 60_000);

	test("no limit when the probe did not measure the timestamps", () => {
		expect(encodeLengthLimit({ duration: 10 })).toBeNull();
		expect(encodeLengthLimit({ duration: 10, timestampSpan: null })).toBeNull();
		expect(encodeLengthLimit({ duration: 2, timestampSpan: 10 })).toBe(12);
		expect(encodeLengthLimit({ duration: 10, timestampSpan: 2 })).toBe(12);
	});
});
