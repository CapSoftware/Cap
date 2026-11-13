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
import * as mediaProbe from "../../lib/media-probe";
import * as mediaVideo from "../../lib/media-video";
import * as videoInputValidation from "../../lib/video-input-validation";
import {
	NO_VIDEO_INPUT_MESSAGE,
	validateVideoInput,
} from "../../lib/video-input-validation";

describe("raw recording input validation", () => {
	const directory = mkdtempSync(join(tmpdir(), "cap-input-validation-"));
	const clean = join(directory, "clean.webm");
	const corrupt = join(directory, "corrupt.webm");
	const cleanIvf = join(directory, "clean.ivf");
	const cleanMp4 = join(directory, "clean.mp4");
	const truncated = join(directory, "truncated.webm");
	const damagedTruncated = join(directory, "damaged-truncated.webm");
	const damagedStreamed = join(directory, "damaged-streamed.webm");
	const audioOnly = join(directory, "audio-only.webm");
	const damagedWithAudio = join(directory, "damaged-with-audio.webm");
	const damagedVideoFullAudio = join(
		directory,
		"damaged-video-full-audio.webm",
	);

	const encodeVp9Ivf = (output: string, keyframeInterval: number) =>
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
			String(keyframeInterval),
			"-lag-in-frames",
			"0",
			"-auto-alt-ref",
			"0",
			"-f",
			"ivf",
			output,
		]);
	const breakIvfPackets = (
		source: string,
		output: string,
		brokenFrames: (frame: number) => boolean,
	) => {
		const bytes = readFileSync(source);
		const chunks = [bytes.subarray(0, 32)];
		for (let offset = 32, frame = 0; offset < bytes.length; frame++) {
			const packetSize = bytes.readUInt32LE(offset);
			if (brokenFrames(frame)) {
				const header = Buffer.from(bytes.subarray(offset, offset + 12));
				header.writeUInt32LE(32);
				chunks.push(header, bytes.subarray(offset + 12, offset + 44));
			} else {
				chunks.push(bytes.subarray(offset, offset + 12 + packetSize));
			}
			offset += 12 + packetSize;
		}
		writeFileSync(output, Buffer.concat(chunks));
	};

	beforeAll(() => {
		encodeVp9Ivf(cleanIvf, 60);
		const brokenIvf = join(directory, "corrupt.ivf");
		breakIvfPackets(cleanIvf, brokenIvf, (frame) => frame === 45);
		execFileSync("ffmpeg", [
			"-hide_banner",
			"-v",
			"error",
			"-i",
			brokenIvf,
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=4",
			"-c:v",
			"copy",
			"-c:a",
			"libopus",
			damagedWithAudio,
		]);
		const singleKeyframeIvf = join(directory, "single-keyframe.ivf");
		const brokenSingleKeyframeIvf = join(
			directory,
			"single-keyframe-corrupt.ivf",
		);
		encodeVp9Ivf(singleKeyframeIvf, 300);
		breakIvfPackets(
			singleKeyframeIvf,
			brokenSingleKeyframeIvf,
			(frame) => frame >= 45,
		);
		execFileSync("ffmpeg", [
			"-hide_banner",
			"-v",
			"error",
			"-i",
			brokenSingleKeyframeIvf,
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=4",
			"-c:v",
			"copy",
			"-c:a",
			"libopus",
			damagedVideoFullAudio,
		]);
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
		const cleanBytes = readFileSync(clean);
		writeFileSync(
			truncated,
			cleanBytes.subarray(0, Math.floor(cleanBytes.length / 2)),
		);
		writeFileSync(
			damagedStreamed,
			execFileSync(
				"ffmpeg",
				[
					"-hide_banner",
					"-v",
					"error",
					"-i",
					corrupt,
					"-c",
					"copy",
					"-f",
					"webm",
					"pipe:1",
				],
				{ maxBuffer: 64 * 1024 * 1024 },
			),
		);
		const corruptBytes = readFileSync(corrupt);
		writeFileSync(
			damagedTruncated,
			corruptBytes.subarray(0, Math.floor(corruptBytes.length * 0.6)),
		);
		execFileSync("ffmpeg", [
			"-hide_banner",
			"-v",
			"error",
			"-f",
			"lavfi",
			"-i",
			"sine=frequency=440:duration=2",
			"-c:a",
			"libopus",
			audioOnly,
		]);
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
		await expect(validateVideoInput(clean)).resolves.toBe("clean");
	});

	test("reports a damaged reference packet so processing can recover around it", async () => {
		await expect(validateVideoInput(corrupt)).resolves.toBe("damaged");
		expect(readFileSync(corrupt).length).toBeGreaterThan(0);
	});

	test("rejects a recording without a video stream", async () => {
		await expect(validateVideoInput(audioOnly)).rejects.toThrow(
			"The recording has no video",
		);
	});

	for (const [
		name,
		source,
		expectedPhase,
		extension,
		importedOriginal,
		expectedError,
		expectedProcessCalls,
	] of [
		["clean", clean, "complete", ".webm", false, null, 1],
		["damaged", corrupt, "complete", ".webm", false, null, 1],
		["damaged-streamed", damagedStreamed, "complete", ".webm", false, null, 1],
		[
			"damaged-with-audio",
			damagedWithAudio,
			"complete",
			".webm",
			false,
			null,
			1,
		],
		[
			"damaged-short-recovered-audio",
			damagedWithAudio,
			"error",
			".webm",
			false,
			"damaged or unreadable",
			1,
		],
		[
			"damaged-unreadable-source-tracks",
			corrupt,
			"complete",
			".webm",
			false,
			null,
			1,
		],
		[
			"damaged-video-full-audio",
			damagedVideoFullAudio,
			"error",
			".webm",
			false,
			"damaged or unreadable",
			1,
		],
		[
			"damaged-busy-output-probe",
			corrupt,
			"error",
			".webm",
			false,
			"Server is busy",
			1,
		],
		[
			"damaged-truncated",
			damagedTruncated,
			"error",
			".webm",
			false,
			"damaged or unreadable",
			1,
		],
		["no-video", audioOnly, "error", ".webm", false, "has no video", 0],
		["imported-damaged", corrupt, "complete", ".webm", true, null, 1],
		[
			"imported-truncated",
			truncated,
			"error",
			".webm",
			true,
			"could not be fully recovered",
			1,
		],
		["fragmented-mp4", cleanMp4, "complete", ".mp4", false, null, 1],
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
			if (name === "damaged-short-recovered-audio") {
				const spans = mediaProbe.probeTrackSpans;
				spyOn(mediaProbe, "probeTrackSpans").mockImplementation(
					async (path) => {
						const measured = await spans(path);
						return path.endsWith(".mp4")
							? { ...measured, audio: (measured.audio ?? 0) / 2 }
							: measured;
					},
				);
			}
			if (name === "damaged-unreadable-source-tracks") {
				const spans = mediaProbe.probeTrackSpans;
				spyOn(mediaProbe, "probeTrackSpans").mockImplementation((path) =>
					path.endsWith(".mp4")
						? spans(path)
						: Promise.reject(new Error("Media input could not be read")),
				);
			}
			if (name === "damaged-busy-output-probe") {
				const probe = mediaProbe.probeVideoFile;
				spyOn(mediaProbe, "probeVideoFile").mockImplementation((path) =>
					path.endsWith(".mp4")
						? Promise.reject(
								new Error("Server is busy, please try again later"),
							)
						: probe(path),
				);
			}
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
							...(importedOriginal ? { importedOriginal } : {}),
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
				expect(process).toHaveBeenCalledTimes(expectedProcessCalls);
				if (expectedError) {
					expect(getJob(jobId)?.error).toContain(expectedError);
					expect(upload).not.toHaveBeenCalled();
				} else {
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

	test("processing route stops the transcode when the source check rejects the recording", async () => {
		spyOn(jobManager, "canAcceptNewVideoProcess").mockReturnValue(true);
		const downloaded = join(directory, "rejected-mid-transcode.webm");
		copyFileSync(clean, downloaded);
		spyOn(mediaVideo, "downloadVideoToTemp").mockResolvedValue({
			path: downloaded,
			cleanup: async () => rmSync(downloaded, { force: true }),
		});
		let rejectCheck: (error: Error) => void = () => {};
		spyOn(videoInputValidation, "validateVideoInput").mockImplementation(
			() =>
				new Promise((_, reject) => {
					rejectCheck = reject;
				}),
		);
		let transcodeSignal: AbortSignal | undefined;
		const process = spyOn(mediaVideo, "processVideo").mockImplementation(
			(_input, _metadata, _options, _onProgress, abortSignal) => {
				if (abortSignal?.aborted)
					return Promise.reject(new Error("Video processing was cancelled"));
				transcodeSignal = abortSignal;
				rejectCheck(new Error(NO_VIDEO_INPUT_MESSAGE));
				return new Promise((_, reject) =>
					abortSignal?.addEventListener(
						"abort",
						() => reject(new Error("Video processing was cancelled")),
						{ once: true },
					),
				);
			},
		);
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
						videoId: "validate-rejected-mid-transcode",
						userId: "validation-test",
						videoUrl: "https://example.com/raw.webm",
						outputPresignedUrl: "https://example.com/result.mp4",
						inputExtension: ".webm",
						preset: "ultrafast",
					}),
				}),
			);
			expect(response.status).toBe(200);
			jobId = (await response.json()).jobId;
			if (!jobId) throw new Error("Missing processing job");
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline && getJob(jobId)?.phase !== "error")
				await Bun.sleep(10);
			expect(getJob(jobId)?.phase).toBe("error");
			expect(getJob(jobId)?.error).toContain("has no video");
			expect(process).toHaveBeenCalled();
			expect(transcodeSignal?.aborted).toBe(true);
			expect(upload).not.toHaveBeenCalled();
		} finally {
			if (jobId) deleteJob(jobId);
			if (previousSecret === undefined)
				delete globalThis.process.env.MEDIA_SERVER_WEBHOOK_SECRET;
			else globalThis.process.env.MEDIA_SERVER_WEBHOOK_SECRET = previousSecret;
		}
	}, 15_000);

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
