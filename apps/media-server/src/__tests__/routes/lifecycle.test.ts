import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import app from "../../app";
import * as jobManager from "../../lib/job-manager";
import {
	cleanupExpiredJobs,
	createJob,
	deleteJob,
	getActiveVideoProcessCount,
	getJob,
	type VideoMetadata,
} from "../../lib/job-manager";
import {
	DRAINING_DETAILS,
	setDraining,
	waitForDrain,
} from "../../lib/lifecycle";
import * as mediaEdit from "../../lib/media-edit";
import * as mediaProbe from "../../lib/media-probe";
import * as mediaVideo from "../../lib/media-video";
import { createTempFile, type TempFileHandle } from "../../lib/temp-files";
import { getActiveDirectVideoProcessCount } from "../../lib/video-capacity";

const MEDIA_SERVER_SECRET = "test-secret";
const AUTH_HEADERS = {
	"Content-Type": "application/json",
	"x-media-server-secret": MEDIA_SERVER_SECRET,
};
const originalPublicStatus = process.env.MEDIA_SERVER_PUBLIC_STATUS;

process.env.MEDIA_SERVER_WEBHOOK_SECRET = MEDIA_SERVER_SECRET;

const metadata: VideoMetadata = {
	duration: 3 * 60 * 60,
	width: 1920,
	height: 1080,
	fps: 30,
	videoCodec: "h264",
	audioCodec: "aac",
	audioChannels: 2,
	sampleRate: 48_000,
	bitrate: 5_000_000,
	fileSize: 1024 ** 3,
};

const createdJobs: string[] = [];

function post(path: string, body: unknown): Request {
	return new Request(`http://localhost${path}`, {
		method: "POST",
		headers: AUTH_HEADERS,
		body: JSON.stringify(body),
	});
}

function deferred<T = void>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function tempFileWith(extension: string, contents: string) {
	const handle = await createTempFile(extension);
	await writeFile(handle.path, contents);
	return handle;
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("Timed out waiting");
		await Bun.sleep(10);
	}
}

beforeEach(() => {
	spyOn(jobManager, "canAcceptNewVideoProcess").mockReturnValue(true);
});

afterEach(async () => {
	mock.restore();
	setDraining(false);
	if (originalPublicStatus === undefined)
		delete process.env.MEDIA_SERVER_PUBLIC_STATUS;
	else process.env.MEDIA_SERVER_PUBLIC_STATUS = originalPublicStatus;
	await waitForDrain(2_000);
	for (const jobId of createdJobs.splice(0)) deleteJob(jobId);
});

describe("draining", () => {
	const url = "https://example.com/video.mp4";
	const admissions: Array<[string, unknown]> = [
		[
			"/video/process",
			{ videoId: "v", userId: "u", videoUrl: url, outputPresignedUrl: url },
		],
		[
			"/video/import",
			{
				videoId: "v",
				userId: "u",
				videoUrl: url,
				outputPresignedUrl: url,
				sourcePresignedUrl: url,
			},
		],
		[
			"/video/edit",
			{
				videoId: "v",
				userId: "u",
				sourceUrl: url,
				outputPresignedUrl: url,
				keepRanges: [{ start: 0, end: 1 }],
			},
		],
		[
			"/video/mux-segments",
			{
				videoId: "v",
				userId: "u",
				outputPresignedUrl: url,
				videoInitUrl: url,
				videoSegmentUrls: ["https://example.com/segment.m4s"],
			},
		],
		[
			"/video/verify-recording",
			{
				videoId: "v",
				userId: "u",
				videoUrl: url,
				fileSize: 1,
				duration: 1,
				requiredAudio: false,
				objectIdentity: '"etag"',
				webhookUrl: "https://example.com/webhook",
			},
		],
		["/video/convert", { videoUrl: url }],
		["/video/probe", { videoUrl: url }],
		["/video/thumbnail", { videoUrl: url }],
		["/audio/check", { videoUrl: url }],
		["/audio/extract", { videoUrl: url }],
		["/audio/convert", { audioUrl: url }],
	];

	test.each(admissions)("rejects new work on %s", async (path, body) => {
		setDraining(true);
		const response = await app.fetch(post(path, body));

		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe("15");
		const data = await response.json();
		expect(data.code).toBe("SERVER_BUSY");
		expect(data.details).toBe(DRAINING_DETAILS);
	});

	test("fails health checks but keeps status endpoints working", async () => {
		const job = createJob("job-draining-status", "video-id", "user-id");
		createdJobs.push(job.jobId);
		setDraining(true);

		const health = await app.fetch(new Request("http://localhost/health"));
		expect(health.status).toBe(503);
		expect((await health.json()).status).toBe("draining");

		const status = await app.fetch(
			new Request(`http://localhost/video/process/${job.jobId}/status`),
		);
		expect(status.status).toBe(200);
		expect((await status.json()).jobId).toBe(job.jobId);

		const serverStatus = await app.fetch(
			new Request("http://localhost/video/status"),
		);
		expect(serverStatus.status).toBe(200);
	});
});

describe("status access", () => {
	test("requires the secret when public status is disabled", async () => {
		process.env.MEDIA_SERVER_PUBLIC_STATUS = "false";
		for (const path of [
			"/video/status",
			"/audio/status",
			"/video/process/job-missing/status",
		]) {
			const anonymous = await app.fetch(new Request(`http://localhost${path}`));
			expect(anonymous.status).toBe(401);
			const authenticated = await app.fetch(
				new Request(`http://localhost${path}`, { headers: AUTH_HEADERS }),
			);
			expect(authenticated.status).not.toBe(401);
		}
	});

	test("reports runtime counters only to authenticated callers", async () => {
		const job = createJob("job_runtime_report", "video-runtime", "user-id");
		createdJobs.push(job.jobId);
		const anonymous = await app.fetch(new Request("http://localhost/health"));
		expect((await anonymous.json()).runtime).toBeUndefined();

		for (const path of ["/health", "/video/status"]) {
			const response = await app.fetch(
				new Request(`http://localhost${path}`, { headers: AUTH_HEADERS }),
			);
			const { runtime } = await response.json();
			expect(runtime.activeJobs).toBeGreaterThanOrEqual(1);
			expect(runtime.jobTotals.created).toBeGreaterThanOrEqual(1);
			expect(typeof runtime.activeSubprocesses).toBe("number");
			expect(typeof runtime.tempDir.bytes).toBe("number");
			expect(typeof runtime.tempDir.entries).toBe("number");
			expect(typeof runtime.mediaTransferCache.bytes).toBe("number");
			expect(typeof runtime.slots.video.max).toBe("number");
			expect(typeof runtime.slots.directVideo.active).toBe("number");
			expect(typeof runtime.slots.audio.max).toBe("number");
			expect(typeof runtime.slots.probe.max).toBe("number");
			expect(JSON.stringify(runtime)).not.toContain(job.jobId);
			expect(JSON.stringify(runtime)).not.toContain(job.videoId);
		}
	});
});

describe("process jobs", () => {
	test("heartbeats a slow output upload and derives the lifetime from the input", async () => {
		const intervals: Array<{
			callback: () => void;
			delay?: number;
			handle: ReturnType<typeof setInterval>;
		}> = [];
		const cleared = new Set<unknown>();
		const originalSetInterval = globalThis.setInterval;
		const originalClearInterval = globalThis.clearInterval;
		spyOn(globalThis, "setInterval").mockImplementation(((
			callback: () => void,
			delay?: number,
		) => {
			const handle = originalSetInterval(callback, delay);
			intervals.push({ callback, delay, handle });
			return handle;
		}) as unknown as typeof setInterval);
		spyOn(globalThis, "clearInterval").mockImplementation(((
			handle: ReturnType<typeof setInterval>,
		) => {
			cleared.add(handle);
			originalClearInterval(handle);
		}) as unknown as typeof clearInterval);
		const files: TempFileHandle[] = [];
		spyOn(mediaVideo, "downloadVideoToTemp").mockImplementation(async () => {
			const input = await tempFileWith(".mp4", "input");
			files.push(input);
			return input;
		});
		spyOn(mediaProbe, "probeVideoFile").mockResolvedValue(metadata);
		spyOn(mediaVideo, "processVideo").mockImplementation(async () => {
			const output = await tempFileWith(".mp4", "output");
			files.push(output);
			return output;
		});
		const uploadStarted = deferred();
		const upload = deferred<mediaVideo.StorageUploadReceipt>();
		spyOn(mediaVideo, "uploadFileToS3").mockImplementation(async () => {
			uploadStarted.resolve();
			return await upload.promise;
		});

		const response = await app.fetch(
			post("/video/process", {
				videoId: "video-slow-upload",
				userId: "user-id",
				videoUrl: "https://example.com/input.mp4",
				outputPresignedUrl: "https://example.com/output.mp4",
			}),
		);
		const { jobId } = await response.json();
		createdJobs.push(jobId);
		await uploadStarted.promise;

		const job = getJob(jobId);
		expect(job?.phase).toBe("uploading");
		if (!job) throw new Error("Job missing");
		expect(job.lifetimeDeadlineAt).toBeGreaterThan(
			job.createdAt + 2 * 60 * 60 * 1000,
		);
		expect(job.lifetimeDeadlineAt).toBeLessThanOrEqual(
			job.createdAt + 4 * 60 * 60 * 1000,
		);

		job.updatedAt = Date.now() - 16 * 60 * 1000;
		const heartbeats = intervals.filter(
			({ delay, handle }) => delay === 60_000 && !cleared.has(handle),
		);
		expect(heartbeats).toHaveLength(1);
		heartbeats[0]?.callback();
		expect(cleanupExpiredJobs()).toBe(0);
		expect(job.phase).toBe("uploading");

		upload.resolve({});
		await waitFor(() => job.phase === "complete");
		await waitForDrain(2_000);
		expect(files.every((handle) => !existsSync(handle.path))).toBe(true);
	});

	function previewJob(videoId: string) {
		return post("/video/process", {
			videoId,
			userId: "user-id",
			videoUrl: "https://example.com/input.mp4",
			outputPresignedUrl: "https://example.com/output.mp4",
			thumbnailPresignedUrl: "https://example.com/screenshot.jpg",
			previewGifPresignedUrl: "https://example.com/preview.gif",
		});
	}

	function mockPreviewJob() {
		const events: string[] = [];
		const signals: AbortSignal[] = [];
		const gifs: TempFileHandle[] = [];
		spyOn(mediaVideo, "downloadVideoToTemp").mockImplementation(() =>
			tempFileWith(".mp4", "input"),
		);
		spyOn(mediaProbe, "probeVideoFile").mockResolvedValue({
			...metadata,
			duration: 10,
		});
		spyOn(mediaVideo, "processVideo").mockImplementation(() =>
			tempFileWith(".mp4", "output"),
		);
		spyOn(mediaVideo, "generateThumbnail").mockImplementation(
			async (_path, _duration, _options, signal) => {
				events.push("thumbnail rendered");
				if (signal) signals.push(signal);
				return new Uint8Array([1]);
			},
		);
		spyOn(mediaVideo, "generatePreviewGif").mockImplementation(
			async (_path, _duration, _options, signal) => {
				events.push("gif rendered");
				if (signal) signals.push(signal);
				const gif = await tempFileWith(".gif", "gif");
				gifs.push(gif);
				return gif;
			},
		);
		spyOn(mediaVideo, "uploadToS3").mockImplementation(async () => {
			events.push("thumbnail uploaded");
		});
		const output = deferred<mediaVideo.StorageUploadReceipt>();
		const outputStarted = deferred();
		const outputFailure = deferred<Error | null>();
		spyOn(mediaVideo, "uploadFileToS3").mockImplementation(
			async (_path, _url, contentType) => {
				if (contentType === "image/gif") {
					events.push("gif uploaded");
					return {};
				}
				events.push("output upload started");
				outputStarted.resolve();
				const failure = await Promise.race([
					output.promise.then(() => null),
					outputFailure.promise,
				]);
				if (failure) throw failure;
				events.push("output uploaded");
				return {};
			},
		);
		return { events, signals, gifs, output, outputStarted, outputFailure };
	}

	test("renders previews while the output uploads and uploads them after it", async () => {
		const preview = mockPreviewJob();
		const response = await app.fetch(previewJob("video-preview-overlap"));
		const { jobId } = await response.json();
		createdJobs.push(jobId);
		await preview.outputStarted.promise;
		await waitFor(() => preview.events.includes("gif rendered"));
		expect(preview.events).toContain("thumbnail rendered");
		expect(preview.events).not.toContain("thumbnail uploaded");
		expect(preview.events).not.toContain("gif uploaded");

		preview.output.resolve({});
		await waitFor(() => getJob(jobId)?.phase === "complete");
		const uploaded = preview.events.indexOf("output uploaded");
		expect(preview.events.indexOf("thumbnail uploaded")).toBeGreaterThan(
			uploaded,
		);
		expect(preview.events.indexOf("gif uploaded")).toBeGreaterThan(uploaded);
		await waitForDrain(2_000);
		expect(preview.gifs.every((gif) => !existsSync(gif.path))).toBe(true);
	});

	test("reports an upload failure only after the thumbnail render has stopped", async () => {
		const preview = mockPreviewJob();
		let thumbnailStopped = false;
		spyOn(mediaVideo, "generateThumbnail").mockImplementation(
			(_path, _duration, _options, signal) =>
				new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => {
						setTimeout(() => {
							thumbnailStopped = true;
							reject(new Error("Thumbnail render stopped"));
						}, 100);
					});
				}),
		);
		const response = await app.fetch(previewJob("video-preview-thumb-stop"));
		const { jobId } = await response.json();
		createdJobs.push(jobId);
		await preview.outputStarted.promise;

		preview.outputFailure.resolve(new Error("Storage upload failed: 403"));
		await waitFor(() => getJob(jobId)?.phase === "error");
		expect(thumbnailStopped).toBe(true);
		expect(await waitForDrain(2_000)).toBe(true);
	});

	test("uploads no previews and stops rendering when the output upload fails", async () => {
		const preview = mockPreviewJob();
		const response = await app.fetch(previewJob("video-preview-upload-fails"));
		const { jobId } = await response.json();
		createdJobs.push(jobId);
		await preview.outputStarted.promise;
		await waitFor(() => preview.events.includes("gif rendered"));

		preview.outputFailure.resolve(new Error("Storage upload failed: 403"));
		expect(await waitForDrain(2_000)).toBe(true);
		expect(getJob(jobId)?.phase).toBe("error");
		expect(preview.events).not.toContain("thumbnail uploaded");
		expect(preview.events).not.toContain("gif uploaded");
		expect(preview.signals.length).toBe(2);
		expect(preview.signals.every((signal) => signal.aborted)).toBe(true);
		expect(preview.gifs.every((gif) => !existsSync(gif.path))).toBe(true);
	});

	test("does not wait on slow progress webhooks and still delivers completion last", async () => {
		const received: string[] = [];
		const hook = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				const { phase } = (await request.json()) as { phase: string };
				received.push(phase);
				await new Promise((resolve) => setTimeout(resolve, 500));
				return Response.json({ success: true });
			},
		});
		try {
			spyOn(mediaVideo, "downloadVideoToTemp").mockImplementation(() =>
				tempFileWith(".mp4", "input"),
			);
			spyOn(mediaProbe, "probeVideoFile").mockResolvedValue({
				...metadata,
				duration: 10,
			});
			spyOn(mediaVideo, "processVideo").mockImplementation(() =>
				tempFileWith(".mp4", "output"),
			);
			spyOn(mediaVideo, "uploadFileToS3").mockResolvedValue({});
			const started = Date.now();
			const response = await app.fetch(
				post("/video/process", {
					videoId: "video-slow-webhooks",
					userId: "user-id",
					videoUrl: "https://example.com/input.mp4",
					outputPresignedUrl: "https://example.com/output.mp4",
					webhookUrl: `http://127.0.0.1:${hook.port}/webhook`,
				}),
			);
			const { jobId } = await response.json();
			createdJobs.push(jobId);
			await waitFor(() => getJob(jobId)?.phase === "complete", 5_000);
			await waitFor(() => received.at(-1) === "complete", 5_000);
			// Waiting on each 500 ms progress webhook delays completion by about 2 s; without waiting it lands in about 0.5 s.
			expect(Date.now() - started).toBeLessThan(1_500);
			const job = getJob(jobId);
			await waitFor(
				() =>
					Boolean(job?.terminalWebhookAcknowledgedAt) && !job?.webhookInFlight,
				5_000,
			);
			expect(received[0]).toBe("downloading");
			expect(received.filter((phase) => phase === "complete")).toHaveLength(1);
			expect(received.at(-1)).toBe("complete");
		} finally {
			hook.stop(true);
		}
	});

	test("releases the job slot and temp files when processing fails", async () => {
		const before = getActiveVideoProcessCount();
		let input: TempFileHandle | undefined;
		spyOn(mediaVideo, "downloadVideoToTemp").mockImplementation(async () => {
			input = await tempFileWith(".mp4", "input");
			return input;
		});
		spyOn(mediaProbe, "probeVideoFile").mockResolvedValue({
			...metadata,
			duration: 10,
		});
		spyOn(mediaVideo, "processVideo").mockRejectedValue(
			new Error("FFmpeg exited with code 1"),
		);

		const response = await app.fetch(
			post("/video/process", {
				videoId: "video-failed-process",
				userId: "user-id",
				videoUrl: "https://example.com/input.mp4",
				outputPresignedUrl: "https://example.com/output.mp4",
			}),
		);
		const { jobId } = await response.json();
		createdJobs.push(jobId);

		expect(await waitForDrain(2_000)).toBe(true);
		expect(getJob(jobId)?.phase).toBe("error");
		expect(getActiveVideoProcessCount()).toBe(before);
		expect(input && existsSync(input.path)).toBe(false);
	});
});

describe("edit jobs", () => {
	test("cancellation aborts the upload and skips preview work", async () => {
		const files: TempFileHandle[] = [];
		spyOn(mediaVideo, "downloadVideoToTemp").mockImplementation(async () => {
			const input = await tempFileWith(".mp4", "input");
			files.push(input);
			return input;
		});
		spyOn(mediaProbe, "probeVideoFile").mockResolvedValue({
			...metadata,
			duration: 10,
		});
		spyOn(mediaEdit, "renderEditedVideo").mockImplementation(async () => {
			const output = await tempFileWith(".mp4", "edited");
			files.push(output);
			return output;
		});
		const thumbnail = spyOn(mediaVideo, "generateThumbnail");
		const uploadStarted = deferred();
		let uploadSignal: AbortSignal | undefined;
		spyOn(mediaVideo, "uploadFileToS3").mockImplementation(
			(_path, _url, _contentType, signal) => {
				uploadSignal = signal;
				uploadStarted.resolve();
				return new Promise((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				});
			},
		);

		const response = await app.fetch(
			post("/video/edit", {
				videoId: "video-cancelled-edit",
				userId: "user-id",
				sourceUrl: "https://example.com/source.mp4",
				outputPresignedUrl: "https://example.com/output.mp4",
				thumbnailPresignedUrl: "https://example.com/thumbnail.jpg",
				keepRanges: [{ start: 0, end: 5 }],
			}),
		);
		const { jobId } = await response.json();
		createdJobs.push(jobId);
		await uploadStarted.promise;

		const cancel = await app.fetch(post(`/video/process/${jobId}/cancel`, {}));
		expect(cancel.status).toBe(200);
		expect(uploadSignal?.aborted).toBe(true);

		expect(await waitForDrain(2_000)).toBe(true);
		expect(getJob(jobId)?.phase).toBe("cancelled");
		expect(thumbnail).not.toHaveBeenCalled();
		expect(files).toHaveLength(2);
		expect(files.every((handle) => !existsSync(handle.path))).toBe(true);
	});
});

describe("direct conversions", () => {
	test("release the slot when the download fails", async () => {
		spyOn(mediaVideo, "downloadVideoToTemp").mockRejectedValue(
			new Error("Failed to download video: 404"),
		);

		const response = await app.fetch(
			post("/video/convert", { videoUrl: "https://example.com/missing.mp4" }),
		);

		expect(response.status).toBe(500);
		expect(getActiveDirectVideoProcessCount()).toBe(0);
	});

	test("release the slot and temp files when the client cancels the body", async () => {
		const files: TempFileHandle[] = [];
		spyOn(mediaVideo, "downloadVideoToTemp").mockImplementation(async () => {
			const input = await tempFileWith(".webm", "input");
			files.push(input);
			return input;
		});
		spyOn(mediaProbe, "probeVideoFile").mockResolvedValue({
			...metadata,
			duration: 10,
		});
		spyOn(mediaVideo, "processVideo").mockImplementation(async () => {
			const output = await tempFileWith(".mp4", "x".repeat(1024 * 1024));
			files.push(output);
			return output;
		});

		const response = await app.fetch(
			post("/video/convert", { videoUrl: "https://example.com/input.webm" }),
		);
		expect(response.status).toBe(200);
		expect(getActiveDirectVideoProcessCount()).toBe(1);

		await response.body?.cancel();
		await waitFor(() => getActiveDirectVideoProcessCount() === 0);
		await waitFor(() => files.every((handle) => !existsSync(handle.path)));
	});

	test("release the slot after the body is fully read", async () => {
		spyOn(mediaVideo, "downloadVideoToTemp").mockImplementation(() =>
			tempFileWith(".webm", "input"),
		);
		spyOn(mediaProbe, "probeVideoFile").mockResolvedValue({
			...metadata,
			duration: 10,
		});
		spyOn(mediaVideo, "processVideo").mockImplementation(() =>
			tempFileWith(".mp4", "converted"),
		);

		const response = await app.fetch(
			post("/video/convert", { videoUrl: "https://example.com/input.webm" }),
		);

		expect(await response.text()).toBe("converted");
		await waitFor(() => getActiveDirectVideoProcessCount() === 0);
	});
});
