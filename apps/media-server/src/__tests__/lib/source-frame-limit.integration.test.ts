import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	exceedsSourceFrameLimit,
	MAX_DECODE_PIXELS,
	MediaInputPolicyError,
} from "../../lib/media-input-policy";
import {
	FRAME_TOO_LARGE_MESSAGE,
	isUnreadableMediaInput,
	probeVideoFile,
} from "../../lib/media-probe";
import { limitDecodedFrameSize, spawn } from "../../lib/media-spawn";

const LIMIT = String(MAX_DECODE_PIXELS);

let dir: string;

async function ffmpeg(args: string[]): Promise<{ code: number; log: string }> {
	const proc = spawn({
		cmd: ["ffmpeg", "-hide_banner", "-v", "error", ...args],
		stdout: "ignore",
		stderr: "pipe",
	});
	const [log, code] = await Promise.all([
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, log };
}

async function singleFrame(name: string, size: string): Promise<string> {
	const path = join(dir, name);
	const made = await ffmpeg([
		"-f",
		"lavfi",
		"-i",
		`color=c=black:s=${size}:r=1:d=1`,
		"-frames:v",
		"1",
		"-c:v",
		"mjpeg",
		"-y",
		path,
	]);
	expect(made.log).toBe("");
	return path;
}

// Rewrites the frame size a MOV declares for its video, leaving the picture
// itself untouched, so the container and the stream disagree.
async function declareFrameSize(
	source: string,
	name: string,
	width: number,
	height: number,
): Promise<string> {
	const bytes = new Uint8Array(await readFile(source));
	const view = new DataView(bytes.buffer);
	const find = (tag: string, from = 0) =>
		Buffer.from(bytes.buffer).indexOf(Buffer.from(tag, "latin1"), from);
	const entry = find("jpeg", find("stsd"));
	const header = find("tkhd");
	expect(entry).toBeGreaterThan(0);
	expect(header).toBeGreaterThan(0);
	view.setUint16(entry + 28, width);
	view.setUint16(entry + 30, height);
	const headerEnd = header - 4 + view.getUint32(header - 4);
	view.setUint32(headerEnd - 8, width << 16);
	view.setUint32(headerEnd - 4, height << 16);
	const path = join(dir, name);
	await writeFile(path, bytes);
	return path;
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "frame-limit-"));
});

afterAll(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("source frame limit", () => {
	test.each([
		[7680, 4320],
		[4320, 7680],
		[8192, 4320],
		[4320, 8192],
		[3840, 2160],
		[1, 16000],
		[16000, 2],
		[16384, 2160],
	])("%dx%d is accepted", (width, height) => {
		expect(exceedsSourceFrameLimit(width, height)).toBe(false);
	});

	test.each([
		[16000, 16000],
		[8192, 4336],
		[4336, 8192],
		[8192, 8192],
		[16385, 1],
		[1, 16385],
		[65535, 540],
	])("%dx%d is refused", (width, height) => {
		expect(exceedsSourceFrameLimit(width, height)).toBe(true);
	});

	test("the probe accepts an 8K frame and refuses a larger one as an unusable file", async () => {
		const accepted = await probeVideoFile(
			await singleFrame("8k.mov", "7680x4320"),
		);
		expect([accepted.width, accepted.height]).toEqual([7680, 4320]);

		const error = await probeVideoFile(
			await singleFrame("over.mov", "8192x4896"),
		).catch((caught: unknown) => caught);
		expect((error as Error).message).toBe(FRAME_TOO_LARGE_MESSAGE);
		expect(isUnreadableMediaInput(error)).toBe(true);
		expect(error).not.toBeInstanceOf(MediaInputPolicyError);
	});

	test("the probe refuses a frame only the container declares as oversized", async () => {
		const declared = await declareFrameSize(
			await singleFrame("small.mov", "320x240"),
			"declared-large.mov",
			16000,
			16000,
		);
		await expect(probeVideoFile(declared)).rejects.toThrow(
			FRAME_TOO_LARGE_MESSAGE,
		);
	});

	test("FFmpeg refuses an oversized frame whose container declares a small one", async () => {
		const hidden = await declareFrameSize(
			await singleFrame("over-hidden-source.mov", "8192x4896"),
			"hidden.mov",
			1280,
			720,
		);
		const probed = await probeVideoFile(hidden);
		expect([probed.width, probed.height]).toEqual([1280, 720]);

		const decoded = await ffmpeg(["-i", hidden, "-f", "null", "-"]);
		expect(decoded.code).not.toBe(0);
		expect(decoded.log).toContain("max pixel count");
	});

	test("FFmpeg still decodes an 8K frame", async () => {
		const decoded = await ffmpeg([
			"-i",
			await singleFrame("8k-decode.mov", "7680x4320"),
			"-f",
			"null",
			"-",
		]);
		expect(decoded).toEqual({ code: 0, log: "" });
	});
});

describe("limitDecodedFrameSize", () => {
	test("caps every decoded input and leaves generated ones alone", () => {
		expect(
			limitDecodedFrameSize([
				"ffmpeg",
				"-f",
				"lavfi",
				"-i",
				"anullsrc",
				"-ss",
				"2",
				"-i",
				"/tmp/a.mp4",
				"-i",
				"https://bucket.example/b.webm",
				"-c",
				"copy",
				"/tmp/out.mp4",
			]),
		).toEqual([
			"ffmpeg",
			"-f",
			"lavfi",
			"-i",
			"anullsrc",
			"-ss",
			"2",
			"-max_pixels",
			LIMIT,
			"-i",
			"/tmp/a.mp4",
			"-max_pixels",
			LIMIT,
			"-i",
			"https://bucket.example/b.webm",
			"-c",
			"copy",
			"/tmp/out.mp4",
		]);
	});

	test("caps ffprobe and leaves other commands and explicit limits alone", () => {
		expect(
			limitDecodedFrameSize(["ffprobe", "-v", "error", "/tmp/a.mp4"]),
		).toEqual(["ffprobe", "-max_pixels", LIMIT, "-v", "error", "/tmp/a.mp4"]);
		expect(limitDecodedFrameSize(["nvidia-smi", "-L"])).toEqual([
			"nvidia-smi",
			"-L",
		]);
		const explicit = ["ffmpeg", "-max_pixels", "100", "-i", "a.mp4", "o.mp4"];
		expect(limitDecodedFrameSize(explicit)).toEqual(explicit);
	});
});
