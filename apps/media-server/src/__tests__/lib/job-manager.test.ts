import { afterEach, describe, expect, test } from "bun:test";
import {
	beginRecordingProcessing,
	beginRecordingVerification,
	cleanupExpiredJobs,
	createJob,
	deleteJob,
	getJob,
	sendWebhook,
	touchJob,
	updateJob,
} from "../../lib/job-manager";

const createdJobs: string[] = [];

function createTrackedJob(jobId: string) {
	createdJobs.push(jobId);
	return createJob(jobId, "video-id", "user-id");
}

afterEach(() => {
	for (const jobId of createdJobs.splice(0)) {
		deleteJob(jobId);
	}
});

describe("job cleanup", () => {
	test("budgets the complete recording pipeline from execution without extending its deadline", () => {
		const job = createTrackedJob("job-complete-recording-budget");
		job.createdAt = Date.now() - 55 * 60 * 1000;
		job.abortController = new AbortController();
		const startedAt = Date.now();
		expect(beginRecordingProcessing(job.jobId, 170 * 60 * 1000)).toBe(true);
		expect(job.recordingProcessingDeadlineAt).toBeGreaterThanOrEqual(
			startedAt + 170 * 60 * 1000,
		);
		job.phase = "processing";
		job.createdAt -= 80 * 60 * 1000;
		expect(cleanupExpiredJobs()).toBe(0);
		const deadline = job.recordingProcessingDeadlineAt;
		expect(beginRecordingProcessing(job.jobId, 170 * 60 * 1000)).toBe(false);
		expect(job.recordingProcessingDeadlineAt).toBe(deadline);
		job.recordingProcessingDeadlineAt = Date.now() + 15 * 60 * 1000;
		expect(beginRecordingVerification(job.jobId, 50 * 60 * 1000)).toBe(true);
		expect(job.recordingVerificationDeadlineAt).toBe(
			job.recordingProcessingDeadlineAt,
		);
		job.recordingVerificationDeadlineAt = Date.now() - 1;
		touchJob(job.jobId);
		expect(cleanupExpiredJobs()).toBe(1);
		expect(job.error).toBe("Recording verification timed out");
		expect(job.abortController.signal.aborted).toBe(true);
	});

	test("bounds queued, cancelled, stale, and oversized recording processing budgets", () => {
		const queued = createTrackedJob("job-recording-queue-expired");
		queued.createdAt = Date.now() - 61 * 60 * 1000;
		expect(beginRecordingProcessing(queued.jobId, 170 * 60 * 1000)).toBe(false);
		const cancelled = createTrackedJob("job-recording-aborted");
		cancelled.abortController = new AbortController();
		cancelled.abortController.abort();
		expect(beginRecordingProcessing(cancelled.jobId, 170 * 60 * 1000)).toBe(
			false,
		);
		const stale = createTrackedJob("job-recording-stale");
		stale.abortController = new AbortController();
		expect(beginRecordingProcessing(stale.jobId, 181 * 60 * 1000)).toBe(false);
		expect(beginRecordingProcessing(stale.jobId, 170 * 60 * 1000)).toBe(true);
		stale.phase = "processing";
		stale.updatedAt = Date.now() - 16 * 60 * 1000;
		cleanupExpiredJobs();
		expect(getJob(stale.jobId)?.phase).toBe("error");
		expect(stale.error).toContain("Job stale");
		expect(stale.abortController.signal.aborted).toBe(true);
	});

	test("retains and redelivers unacknowledged terminal proof with its generation fence", async () => {
		const job = createTrackedJob("job-terminal-retry");
		job.webhookUrl = "https://webhook.example.test/progress";
		updateJob(job.jobId, {
			generation: "generation-a",
			attemptId: "attempt-a",
			phase: "complete",
			progress: 100,
		});
		const originalFetch = globalThis.fetch;
		let available = false;
		const payloads: Record<string, unknown>[] = [];
		globalThis.fetch = (async (_input, init) => {
			payloads.push(JSON.parse(String(init?.body)));
			return new Response(null, { status: available ? 200 : 503 });
		}) as typeof fetch;
		try {
			await sendWebhook(job);
			expect(job.terminalWebhookAcknowledgedAt).toBeUndefined();
			job.terminalAt = Date.now() - 2 * 60 * 60 * 1000;
			job.updatedAt = job.terminalAt;
			job.webhookLastAttemptAt = Date.now() - 61_000;
			available = true;
			expect(cleanupExpiredJobs()).toBe(0);
			expect(getJob(job.jobId)).toBe(job);
			await Bun.sleep(10);
			expect(job.terminalWebhookAcknowledgedAt).toBeNumber();
			expect(payloads.at(-1)).toMatchObject({
				generation: "generation-a",
				attemptId: "attempt-a",
				phase: "complete",
			});
			expect(cleanupExpiredJobs()).toBe(1);
			expect(getJob(job.jobId)).toBeUndefined();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("bounds unacknowledged terminal retention and retains expired active jobs for delivery", () => {
		const terminal = createTrackedJob("job-terminal-expired");
		terminal.phase = "complete";
		terminal.webhookUrl = "https://webhook.example.test/progress";
		terminal.terminalAt = Date.now() - 25 * 60 * 60 * 1000;
		expect(cleanupExpiredJobs()).toBe(1);
		expect(getJob(terminal.jobId)).toBeUndefined();
		const active = createTrackedJob("job-active-expired");
		active.phase = "processing";
		active.updatedAt = Date.now() - 61 * 60 * 1000;
		expect(cleanupExpiredJobs()).toBe(1);
		expect(getJob(active.jobId)?.phase).toBe("error");
	});

	test("gives verification a separate finite budget after a long mux", () => {
		const job = createTrackedJob("job-verification-budget");
		job.phase = "uploading";
		job.createdAt = Date.now() - 55 * 60 * 1000;
		expect(beginRecordingVerification(job.jobId, 50 * 60 * 1000)).toBe(true);
		job.createdAt -= 10 * 60 * 1000;
		expect(cleanupExpiredJobs()).toBe(0);
		const deadline = job.recordingVerificationDeadlineAt;
		touchJob(job.jobId);
		expect(beginRecordingVerification(job.jobId, 50 * 60 * 1000)).toBe(false);
		expect(job.recordingVerificationDeadlineAt).toBe(deadline);
		job.recordingVerificationDeadlineAt = Date.now() - 1;
		expect(cleanupExpiredJobs()).toBe(1);
		expect(job.error).toBe("Recording verification timed out");
	});

	test("cannot revive an aborted job for verification", () => {
		const job = createTrackedJob("job-verification-cancelled");
		job.phase = "uploading";
		job.abortController = new AbortController();
		job.abortController.abort();
		expect(beginRecordingVerification(job.jobId, 50 * 60 * 1000)).toBe(false);
		expect(job.recordingVerificationDeadlineAt).toBeUndefined();
	});

	test("keeps a processing job alive after a heartbeat", () => {
		const job = createTrackedJob("job-heartbeat");
		const now = Date.now();
		job.phase = "processing";
		job.createdAt = now - 20 * 60 * 1000;
		job.updatedAt = now - 16 * 60 * 1000;

		touchJob(job.jobId);

		const cleaned = cleanupExpiredJobs();
		const currentJob = getJob(job.jobId);

		expect(cleaned).toBe(0);
		expect(currentJob?.phase).toBe("processing");
	});

	test("marks an untouched stale processing job as error", () => {
		const job = createTrackedJob("job-stale");
		const now = Date.now();
		job.phase = "processing";
		job.createdAt = now - 20 * 60 * 1000;
		job.updatedAt = now - 16 * 60 * 1000;

		const cleaned = cleanupExpiredJobs();
		const currentJob = getJob(job.jobId);

		expect(cleaned).toBe(1);
		expect(currentJob?.phase).toBe("error");
		expect(currentJob?.error).toContain("Job stale");
	});

	test("allows active jobs below the one-hour lifetime cap", () => {
		const job = createTrackedJob("job-below-lifetime");
		const now = Date.now();
		job.phase = "processing";
		job.createdAt = now - 50 * 60 * 1000;
		job.updatedAt = now;

		const cleaned = cleanupExpiredJobs();
		const currentJob = getJob(job.jobId);

		expect(cleaned).toBe(0);
		expect(currentJob?.phase).toBe("processing");
	});

	test("marks active jobs past the one-hour lifetime cap as error", () => {
		const job = createTrackedJob("job-past-lifetime");
		const now = Date.now();
		job.phase = "processing";
		job.createdAt = now - 61 * 60 * 1000;
		job.updatedAt = now;

		const cleaned = cleanupExpiredJobs();
		const currentJob = getJob(job.jobId);

		expect(cleaned).toBe(1);
		expect(currentJob?.phase).toBe("error");
		expect(currentJob?.error).toContain("maximum lifetime of 60 minutes");
	});
});
