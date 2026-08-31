import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import type { JobProgress, VideoMetadata } from "../../lib/job-manager";
import * as jobManager from "../../lib/job-manager";
import * as mediaProbe from "../../lib/media-probe";
import type { RemoteRecordingVerificationResult } from "../../lib/recording-verification";
import * as recordingVerification from "../../lib/recording-verification";
import video from "../../routes/video";

const originalFetch = globalThis.fetch;
const originalSecret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
const realVerifyRemoteRecording = recordingVerification.verifyRemoteRecording;
const secret = "isolated-recording-verification-test";
const headers = {
	"Content-Type": "application/json",
	"x-media-server-secret": secret,
};
const body = {
	videoId: "owned-verification-video",
	userId: "owned-verification-user",
	videoUrl: "https://storage.example.test/recording.mp4",
	fileSize: 128,
	duration: 5,
	requiredAudio: false,
	objectIdentity: '"uploaded-generation"',
	webhookUrl: "https://webhook.example.test/progress",
	webhookSecret: secret,
};
const metadata: VideoMetadata = {
	duration: 5,
	width: 320,
	height: 180,
	fps: 30,
	videoCodec: "h264",
	audioCodec: "aac",
	audioChannels: 1,
	sampleRate: 48_000,
	bitrate: 200_000,
	fileSize: 128,
};
const evidence: RemoteRecordingVerificationResult = {
	fullDecode: true,
	objectIdentity: body.objectIdentity,
	fileSize: body.fileSize,
	video: { frameCount: 148, startTime: 0, endTime: 4.95, duration: 4.95 },
	audio: null,
};
const jobs: string[] = [];
let webhooks: JobProgress[] = [];
let requests: { url: string; method: string }[] = [];
let identityResponse: Response | undefined;
const probe = spyOn(mediaProbe, "probeVideo");
const verify = spyOn(recordingVerification, "verifyRemoteRecording");
const capacity = spyOn(jobManager, "canAcceptNewVideoProcess");
const memoryPressure = spyOn(jobManager, "hasCriticalMemoryPressure");

async function waitFor(predicate: () => boolean) {
	const deadline = performance.now() + 2_500;
	while (!predicate()) {
		if (performance.now() >= deadline) {
			throw new Error("Verification job did not settle within the test budget");
		}
		await Bun.sleep(5);
	}
}

async function startJob() {
	const response = await video.request("/verify-recording", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
	expect(response.status).toBe(200);
	const accepted = (await response.json()) as { jobId: string };
	expect(Object.keys(accepted)).toEqual(["jobId"]);
	expect(typeof accepted.jobId).toBe("string");
	jobs.push(accepted.jobId);
	return accepted.jobId;
}

async function status(jobId: string): Promise<JobProgress> {
	const response = await video.request(`/process/${jobId}/status`);
	expect(response.status).toBe(200);
	return response.json();
}

async function terminalWebhook(jobId: string): Promise<JobProgress> {
	await waitFor(() => webhooks.some((payload) => payload.jobId === jobId));
	const payload = webhooks.find((item) => item.jobId === jobId);
	if (!payload) throw new Error("Missing terminal webhook");
	return payload;
}

function waitForDecoderCancellation() {
	let joined = false;
	verify.mockImplementation(async (_input, options) => {
		await new Promise<void>((_resolve, reject) => {
			const abort = () =>
				reject(new Error("Recording verification was cancelled"));
			if (options.abortSignal?.aborted) abort();
			else
				options.abortSignal?.addEventListener("abort", abort, { once: true });
		}).finally(() => {
			joined = true;
		});
		return evidence;
	});
	return () => joined;
}

beforeEach(() => {
	process.env.MEDIA_SERVER_WEBHOOK_SECRET = secret;
	webhooks = [];
	requests = [];
	identityResponse = undefined;
	probe.mockReset().mockResolvedValue(metadata);
	verify.mockReset().mockResolvedValue(evidence);
	capacity.mockReset().mockReturnValue(true);
	memoryPressure.mockReset().mockReturnValue(false);
	globalThis.fetch = (async (input, init) => {
		const request = new Request(input, init);
		requests.push({ url: request.url, method: request.method });
		if (request.url === body.webhookUrl && request.method === "POST") {
			expect(request.headers.get("x-media-server-secret")).toBe(secret);
			webhooks.push((await request.json()) as JobProgress);
			return new Response(null, { status: 200 });
		}
		if (
			request.url === body.videoUrl &&
			request.method === "GET" &&
			identityResponse
		) {
			return identityResponse;
		}
		throw new Error(
			`Unexpected test request: ${request.method} ${request.url}`,
		);
	}) as typeof fetch;
});

afterEach(async () => {
	for (const jobId of jobs.splice(0)) {
		jobManager.getJob(jobId)?.abortController?.abort();
		await waitFor(() => webhooks.some((payload) => payload.jobId === jobId));
		jobManager.deleteJob(jobId);
	}
	globalThis.fetch = originalFetch;
});

afterAll(() => {
	mock.restore();
	if (originalSecret === undefined)
		delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	else process.env.MEDIA_SERVER_WEBHOOK_SECRET = originalSecret;
});

describe("asynchronous recording verification", () => {
	test("acceptance is not proof and completed metadata comes from decoded evidence", async () => {
		let finish:
			| ((value: RemoteRecordingVerificationResult) => void)
			| undefined;
		verify.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const jobId = await startJob();
		await waitFor(() => verify.mock.calls.length === 1);
		try {
			const pending = await status(jobId);
			expect(pending.phase).toBe("processing");
			expect(pending.recordingVerification).toBeUndefined();
			expect(webhooks).toHaveLength(0);
			expect(verify.mock.calls[0]?.[1]).toMatchObject({
				expectedDuration: body.duration,
				requireAudio: body.requiredAudio,
				expectedObjectIdentity: body.objectIdentity,
			});
		} finally {
			finish?.(evidence);
		}
		const completed = await terminalWebhook(jobId);
		expect(completed.phase).toBe("complete");
		expect(completed.metadata?.duration).toBe(evidence.video.duration);
		expect(completed.metadata?.audioCodec).toBeNull();
		expect(completed.recordingVerification).toEqual({
			request: {
				version: 1,
				artifact: {
					kind: "mp4",
					fileSize: body.fileSize,
					duration: body.duration,
					objectIdentity: body.objectIdentity,
				},
				requiredAudio: false,
			},
			fullDecode: true,
			objectIdentity: evidence.objectIdentity,
		});
		expect((await status(jobId)).recordingVerification).toEqual(
			completed.recordingVerification,
		);
	});

	test("probe unavailability publishes a retryable error without issuing proof or storage writes", async () => {
		probe.mockRejectedValue(new Error("Media input is not accessible (503)"));
		const jobId = await startJob();
		const failed = await terminalWebhook(jobId);
		expect(failed.phase).toBe("error");
		expect(failed.error).toBe(
			"Recording verification temporarily unavailable (503)",
		);
		expect(failed.recordingVerification).toBeUndefined();
		expect(verify).not.toHaveBeenCalled();
		expect(requests).toEqual([{ url: body.webhookUrl, method: "POST" }]);
		expect((await status(jobId)).recordingVerification).toBeUndefined();
	});

	test("typed remote storage503 remains retryable after a successful probe", async () => {
		identityResponse = new Response("Unavailable", { status: 503 });
		verify.mockImplementation(realVerifyRemoteRecording);
		const failed = await terminalWebhook(await startJob());
		expect(failed.phase).toBe("error");
		expect(failed.error).toBe(
			"Recording verification temporarily unavailable (503)",
		);
		expect(failed.recordingVerification).toBeUndefined();
		expect(requests).toEqual([
			{ url: body.videoUrl, method: "GET" },
			{ url: body.webhookUrl, method: "POST" },
		]);
	});

	test("memory pressure joins cancelled decoding and remains a retryable error", async () => {
		const joined = waitForDecoderCancellation();
		memoryPressure.mockReturnValue(true);
		const failed = await terminalWebhook(await startJob());
		expect(joined()).toBe(true);
		expect(failed.phase).toBe("error");
		expect(failed.error).toBe(
			"Recording verification temporarily unavailable (503)",
		);
		expect(failed.recordingVerification).toBeUndefined();
	});

	test("explicit owner cancellation is not classified as a transient storage failure", async () => {
		const joined = waitForDecoderCancellation();
		const jobId = await startJob();
		await waitFor(() => verify.mock.calls.length === 1);
		jobManager.getJob(jobId)?.abortController?.abort();
		const cancelled = await terminalWebhook(jobId);
		expect(joined()).toBe(true);
		expect(cancelled.phase).toBe("cancelled");
		expect(cancelled.error).not.toContain("503");
		expect(cancelled.recordingVerification).toBeUndefined();
	});

	test.each([
		"Recording object changed during verification",
		"Recording decoding failed: corrupt input packet",
	])(
		"withholds proof after permanent verification failure: %s",
		async (message) => {
			verify.mockRejectedValue(new Error(message));
			const failed = await terminalWebhook(await startJob());
			expect(failed.phase).toBe("error");
			expect(failed.error).toBe(
				"Uploaded recording content could not be verified; retain the local recording",
			);
			expect(failed.recordingVerification).toBeUndefined();
			expect(failed.metadata).toBeUndefined();
		},
	);
});
