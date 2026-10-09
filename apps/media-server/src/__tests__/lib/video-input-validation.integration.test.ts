import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../../app";
import * as jobManager from "../../lib/job-manager";
import { deleteJob, getJob } from "../../lib/job-manager";
import * as mediaVideo from "../../lib/media-video";
import { validateVideoInput } from "../../lib/video-input-validation";

describe("raw recording input validation", () => {
	const directory = mkdtempSync(join(tmpdir(), "cap-input-validation-"));
	const clean = join(directory, "clean.webm");
	const corrupt = join(directory, "corrupt.webm");
	const cleanIvf = join(directory, "clean.ivf");
	const cleanMp4 = join(directory, "clean.mp4");

	beforeAll(() => {
		execFileSync("ffmpeg", [
			"-hide_banner",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=320x180:rate=30:duration=4",
			"-c:v",
			"libvpx-vp9",
			"-deadline",
			"realtime",
			"-cpu-used",
			"8",
			"-threads",
			"2",
			"-g",
			"60",
			"-lag-in-frames",
			"0",
			"-auto-alt-ref",
			"0",
			"-f",
			"ivf",
			cleanIvf,
		]);
		const bytes = readFileSync(cleanIvf);
		let offset = 32;
		for (let frame = 0; frame < 45; frame++)
			offset += 12 + bytes.readUInt32LE(offset);
		const packetSize = bytes.readUInt32LE(offset);
		const header = Buffer.from(bytes.subarray(offset, offset + 12));
		header.writeUInt32LE(32);
		const brokenIvf = join(directory, "corrupt.ivf");
		writeFileSync(
			brokenIvf,
			Buffer.concat([
				bytes.subarray(0, offset),
				header,
				bytes.subarray(offset + 12, offset + 44),
				bytes.subarray(offset + 12 + packetSize),
			]),
		);
		for (const [source, output] of [
			[cleanIvf, clean],
			[brokenIvf, corrupt],
		]) {
			execFileSync("ffmpeg", [
				"-hide_banner",
				"-v",
				"error",
				"-i",
				source,
				"-c",
				"copy",
				output,
			]);
		}
		execFileSync("ffmpeg", [
			"-v",
			"error",
			"-i",
			clean,
			"-c:v",
			"libx264",
			"-preset",
			"ultrafast",
			"-movflags",
			"frag_keyframe+empty_moov",
			cleanMp4,
		]);
	});

	afterAll(() => rmSync(directory, { recursive: true, force: true }));
	afterEach(() => mock.restore());

	test("accepts a clean browser-compatible VP9 stream", async () => {
		await expect(validateVideoInput(clean)).resolves.toBeUndefined();
	});

	test("rejects a damaged reference packet before conversion can hide it", async () => {
		await expect(validateVideoInput(corrupt)).rejects.toThrow(
			"original upload has been preserved",
		);
		expect(readFileSync(corrupt).length).toBeGreaterThan(0);
	});

	for (const [name, source, expectedPhase, extension] of [
		["clean", clean, "complete", ".webm"],
		["damaged", corrupt, "error", ".webm"],
		["fragmented-mp4", cleanMp4, "complete", ".mp4"],
	] as const) {
		test(`processing route handles ${name} source before conversion`, async () => {
			spyOn(jobManager, "canAcceptNewVideoProcess").mockReturnValue(true);
			const original = readFileSync(source);
			const downloaded = join(directory, `${name}-download${extension}`);
			copyFileSync(source, downloaded);
			spyOn(mediaVideo, "downloadVideoToTemp").mockResolvedValue({
				path: downloaded,
				cleanup: async () => rmSync(downloaded, { force: true }),
			});
			const process = spyOn(mediaVideo, "processVideo");
			const upload = spyOn(mediaVideo, "uploadFileToS3").mockResolvedValue({});
			const secret =
				globalThis.process.env.MEDIA_SERVER_WEBHOOK_SECRET ?? "test-secret";
			const previousSecret = globalThis.process.env.MEDIA_SERVER_WEBHOOK_SECRET;
			globalThis.process.env.MEDIA_SERVER_WEBHOOK_SECRET = secret;
			let jobId: string | undefined;
			try {
				const response = await app.fetch(
					new Request("http://localhost/video/process", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"x-media-server-secret": secret,
						},
						body: JSON.stringify({
							videoId: `validate-${name}`,
							userId: "validation-test",
							videoUrl: `https://example.com/raw${extension}`,
							outputPresignedUrl: "https://example.com/result.mp4",
							inputExtension: extension,
							preset: "ultrafast",
						}),
					}),
				);
				expect(response.status).toBe(200);
				const body = await response.json();
				jobId = body.jobId;
				if (!jobId) throw new Error("Missing processing job");
				const deadline = Date.now() + 10_000;
				while (Date.now() < deadline) {
					const phase = getJob(jobId)?.phase;
					if (phase === "complete" || phase === "error") break;
					await Bun.sleep(10);
				}
				expect(getJob(jobId)?.phase).toBe(expectedPhase);
				if (expectedPhase === "error") {
					expect(getJob(jobId)?.error).toContain("damaged or unreadable");
					expect(process).not.toHaveBeenCalled();
					expect(upload).not.toHaveBeenCalled();
				} else {
					expect(process).toHaveBeenCalledTimes(1);
					expect(upload).toHaveBeenCalledTimes(1);
				}
				expect(readFileSync(source)).toEqual(original);
			} finally {
				if (jobId) deleteJob(jobId);
				if (previousSecret === undefined)
					delete globalThis.process.env.MEDIA_SERVER_WEBHOOK_SECRET;
				else
					globalThis.process.env.MEDIA_SERVER_WEBHOOK_SECRET = previousSecret;
			}
		}, 15_000);
	}

	test("rejects missing input", async () => {
		await expect(
			validateVideoInput(join(directory, "missing.webm")),
		).rejects.toThrow("damaged or unreadable");
	});

	test("honours cancellation before launching a decoder", async () => {
		const controller = new AbortController();
		const reason = new Error("Recording cancelled");
		controller.abort(reason);
		await expect(validateVideoInput(clean, controller.signal)).rejects.toBe(
			reason,
		);
	});

	test("terminates a decoder after its deadline", async () => {
		await expect(validateVideoInput(clean, undefined, 1)).rejects.toThrow(
			"timed out",
		);
	});
});
