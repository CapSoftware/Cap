import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	beginRecordingProcessing,
	beginRecordingVerification,
	claimRecordingWorker,
	cleanupExpiredJobs,
	createJob,
	deleteJob,
	getJob,
	type JobProgress,
	type RecordingWorkerAcknowledgement,
	sendWebhook,
	touchJob,
	updateJob,
} from "../../lib/job-manager";

const createdJobs: string[] = [];
const originalFetch = globalThis.fetch;

function createTrackedJob(jobId: string) {
	createdJobs.push(jobId);
	return createJob(jobId, "video-id", "user-id");
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const jobId of createdJobs.splice(0)) {
		deleteJob(jobId);
	}
});

function workerAcknowledgement(
	payload: JobProgress,
	status: RecordingWorkerAcknowledgement["status"] = "accepted",
) {
	return Response.json({
		recordingWorker: {
			version: 1,
			status,
			generation: payload.generation,
			attemptId: payload.attemptId,
			jobId: payload.jobId,
			sequence: payload.recordingWorker?.sequence,
			leaseDurationMs: 300_000,
		},
	});
}

function createRecordingWorker(jobId: string) {
	const job = createTrackedJob(jobId);
	job.webhookUrl = "https://webhook.example.test/progress";
	updateJob(jobId, {
		generation: "generation",
		attemptId: "attempt",
		abortController: new AbortController(),
	});
	return job;
}

describe("durable recording workers", () => {
	test("retries a lost ownership acknowledgement with the same claim before work", async () => {
		const job = createRecordingWorker("worker-lost-claim");
		const payloads: JobProgress[] = [];
		globalThis.fetch = (async (_input, init) => {
			const payload = JSON.parse(String(init?.body)) as JobProgress;
			payloads.push(payload);
			if (payloads.length === 1) throw new Error("Acknowledgement lost");
			return workerAcknowledgement(payload);
		}) as typeof fetch;
		const acknowledgement = await claimRecordingWorker(job);
		expect(acknowledgement?.status).toBe("accepted");
		expect(payloads).toHaveLength(2);
		expect(payloads[0]).toEqual(payloads[1]);
		expect(payloads[0]?.recordingWorker).toEqual({
			version: 1,
			action: "claim",
			sequence: 0,
		});
		expect(job.recordingWorkerClaimed).toBe(true);
		expect(job.abortController?.signal.aborted).toBe(false);
		expect(await claimRecordingWorker(job)).toBe(acknowledgement);
		expect(payloads).toHaveLength(2);
	});

	test("renews an unchanged long phase without extending the processing deadline", async () => {
		const job = createRecordingWorker("worker-silent-stage");
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const payloads: JobProgress[] = [];
		globalThis.fetch = (async (_input, init) => {
			const payload = JSON.parse(String(init?.body)) as JobProgress;
			payloads.push(payload);
			return workerAcknowledgement(payload);
		}) as typeof fetch;
		try {
			await claimRecordingWorker(job);
			expect(beginRecordingProcessing(job.jobId, 20 * 60_000)).toBe(true);
			updateJob(job.jobId, { phase: "processing", progress: 60 });
			const deadline = job.recordingProcessingDeadlineAt;
			for (let minute = 0; minute < 7; minute++) {
				now += 61_000;
				touchJob(job.jobId);
				expect(cleanupExpiredJobs()).toBe(0);
				await job.webhookPromise;
				expect(job.recordingWorkerLeaseExpiresAt).toBeGreaterThan(now);
			}
			expect(payloads.slice(1)).toHaveLength(7);
			expect(
				payloads
					.slice(1)
					.every(
						(payload) =>
							payload.phase === "processing" &&
							payload.progress === 60 &&
							payload.recordingWorker?.sequence === 1,
					),
			).toBe(true);
			expect(job.recordingProcessingDeadlineAt).toBe(deadline);
			now = (deadline ?? now) + 1;
			job.recordingWorkerLeaseExpiresAt = now + 300_000;
			touchJob(job.jobId);
			expect(cleanupExpiredJobs()).toBe(1);
			await job.webhookPromise;
			expect(job.phase).toBe("error");
			expect(job.abortController?.signal.aborted).toBe(true);
		} finally {
			clock.mockRestore();
		}
	});

	test("serializes an in-flight active callback and immediately drains terminal proof", async () => {
		const job = createRecordingWorker("worker-terminal-drain");
		const payloads: JobProgress[] = [];
		let release: ((response: Response) => void) | undefined;
		let inFlight = 0;
		let maximumInFlight = 0;
		globalThis.fetch = (async (_input, init) => {
			const payload = JSON.parse(String(init?.body)) as JobProgress;
			payloads.push(payload);
			inFlight++;
			maximumInFlight = Math.max(maximumInFlight, inFlight);
			try {
				if (payload.phase === "processing")
					return await new Promise<Response>((resolve) => {
						release = resolve;
					});
				return workerAcknowledgement(payload);
			} finally {
				inFlight--;
			}
		}) as typeof fetch;
		await claimRecordingWorker(job);
		updateJob(job.jobId, { phase: "processing", progress: 60 });
		const sending = sendWebhook(job);
		updateJob(job.jobId, { phase: "complete", progress: 100 });
		expect(sendWebhook(job)).toBe(sending);
		const started = performance.now();
		release?.(new Response(null, { status: 503 }));
		await sending;
		expect(performance.now() - started).toBeLessThan(400);
		expect(maximumInFlight).toBe(1);
		expect(payloads.map((payload) => payload.phase)).toEqual([
			"queued",
			"processing",
			"complete",
		]);
		expect(job.terminalWebhookAcknowledgedAt).toBeNumber();
		expect(payloads.at(-1)?.recordingWorker?.sequence).toBe(2);
	});

	test("fails closed on unsupported ownership acknowledgements", async () => {
		const job = createRecordingWorker("worker-unsupported-claim");
		globalThis.fetch = (async (_input, _init) =>
			Response.json({ success: true })) as typeof fetch;
		expect(await claimRecordingWorker(job)).toBeUndefined();
		expect(job.recordingWorkerClaimed).toBeUndefined();
		expect(job.recordingWorkerLeaseExpiresAt).toBeUndefined();
	});

	test("revokes only positive supersession or expiry of the granted lease", async () => {
		const job = createRecordingWorker("worker-lease-expiry");
		let unavailable = false;
		globalThis.fetch = (async (_input, init) =>
			unavailable
				? new Response(null, { status: 503 })
				: workerAcknowledgement(
						JSON.parse(String(init?.body)) as JobProgress,
					)) as typeof fetch;
		await claimRecordingWorker(job);
		updateJob(job.jobId, { phase: "processing", progress: 60 });
		const granted = job.recordingWorkerLeaseExpiresAt;
		unavailable = true;
		await sendWebhook(job);
		expect(job.abortController?.signal.aborted).toBe(false);
		expect(job.recordingWorkerLeaseExpiresAt).toBe(granted);
		job.recordingWorkerLeaseExpiresAt = Date.now() - 1;
		cleanupExpiredJobs();
		expect(job.abortController?.signal.aborted).toBe(true);
		expect(job.phase).toBe("cancelled");
		expect(
			updateJob(job.jobId, { phase: "complete", progress: 100 }),
		).toBeUndefined();
		expect(updateJob(job.jobId, { phase: "error" })).toBeUndefined();
		expect(job.phase).toBe("cancelled");
	});

	test("aborts a superseded worker and never revives it from a late completion", async () => {
		const job = createRecordingWorker("worker-superseded");
		let superseded = false;
		let requests = 0;
		globalThis.fetch = (async (_input, init) => {
			requests++;
			return workerAcknowledgement(
				JSON.parse(String(init?.body)) as JobProgress,
				superseded ? "superseded" : "accepted",
			);
		}) as typeof fetch;
		await claimRecordingWorker(job);
		updateJob(job.jobId, { phase: "processing", progress: 60 });
		superseded = true;
		await sendWebhook(job);
		expect(job.phase).toBe("cancelled");
		expect(job.abortController?.signal.aborted).toBe(true);
		updateJob(job.jobId, { phase: "complete", progress: 100 });
		await sendWebhook(job);
		expect(requests).toBe(2);
		expect(job.phase).toBe("cancelled");
	});

	test("does not revoke or renew a live worker for a stale state acknowledgement", async () => {
		const job = createRecordingWorker("worker-stale-ack");
		let stale = false;
		globalThis.fetch = (async (_input, init) =>
			workerAcknowledgement(
				JSON.parse(String(init?.body)) as JobProgress,
				stale ? "stale" : "accepted",
			)) as typeof fetch;
		await claimRecordingWorker(job);
		updateJob(job.jobId, { phase: "processing", progress: 60 });
		const deadline = job.recordingWorkerLeaseExpiresAt;
		stale = true;
		expect((await sendWebhook(job))?.status).toBe("stale");
		expect(job.recordingWorkerLeaseExpiresAt).toBe(deadline);
		expect(job.abortController?.signal.aborted).toBe(false);
	});

	test("cannot revive an expired grant with an acknowledgement that arrives late", async () => {
		const job = createRecordingWorker("worker-late-ack");
		let release: (() => void) | undefined;
		globalThis.fetch = (async (_input, init) => {
			const payload = JSON.parse(String(init?.body)) as JobProgress;
			if (payload.recordingWorker?.action === "progress")
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			const acknowledgement = await workerAcknowledgement(payload).json();
			acknowledgement.recordingWorker.leaseDurationMs = 20;
			return Response.json(acknowledgement);
		}) as typeof fetch;
		await claimRecordingWorker(job);
		updateJob(job.jobId, { phase: "processing", progress: 60 });
		const deadline = job.recordingWorkerLeaseExpiresAt;
		const sending = sendWebhook(job);
		try {
			await Bun.sleep(40);
			expect(job.phase).toBe("cancelled");
			expect(job.abortController?.signal.aborted).toBe(true);
		} finally {
			release?.();
		}
		await sending;
		expect(job.recordingWorkerLeaseExpiresAt).toBe(deadline);
		expect(job.recordingWorkerRevoked).toBe(true);
	});

	test("ignores an ownership rejection addressed to a different attempt", async () => {
		const job = createRecordingWorker("worker-foreign-ack");
		let foreign = false;
		globalThis.fetch = (async (_input, init) => {
			const payload = JSON.parse(String(init?.body)) as JobProgress;
			if (foreign) payload.attemptId = "another-attempt";
			return workerAcknowledgement(
				payload,
				foreign ? "superseded" : "accepted",
			);
		}) as typeof fetch;
		await claimRecordingWorker(job);
		updateJob(job.jobId, { phase: "processing", progress: 60 });
		foreign = true;
		const deadline = job.recordingWorkerLeaseExpiresAt;
		expect(await sendWebhook(job)).toBeUndefined();
		expect(job.recordingWorkerLeaseExpiresAt).toBe(deadline);
		expect(job.abortController?.signal.aborted).toBe(false);
	});

	test("does not accept a malformed status as a lease renewal", async () => {
		const job = createRecordingWorker("worker-malformed-ack");
		let malformed = false;
		globalThis.fetch = (async (_input, init) => {
			const payload = JSON.parse(String(init?.body)) as JobProgress;
			const acknowledgement = await workerAcknowledgement(payload).json();
			if (malformed) acknowledgement.recordingWorker.status = ["accepted"];
			return Response.json(acknowledgement);
		}) as typeof fetch;
		await claimRecordingWorker(job);
		updateJob(job.jobId, { phase: "processing", progress: 60 });
		const deadline = job.recordingWorkerLeaseExpiresAt;
		malformed = true;
		expect(await sendWebhook(job)).toBeUndefined();
		expect(job.recordingWorkerLeaseExpiresAt).toBe(deadline);
		expect(job.abortController?.signal.aborted).toBe(false);
	});

	test("retains the same fenced terminal revision across a lost acknowledgement", async () => {
		const job = createRecordingWorker("worker-terminal-lost-ack");
		const terminals: JobProgress[] = [];
		globalThis.fetch = (async (_input, init) => {
			const payload = JSON.parse(String(init?.body)) as JobProgress;
			if (payload.phase === "complete") {
				terminals.push(payload);
				if (terminals.length === 1)
					throw new Error("Terminal acknowledgement lost");
			}
			return workerAcknowledgement(payload);
		}) as typeof fetch;
		await claimRecordingWorker(job);
		updateJob(job.jobId, { phase: "complete", progress: 100 });
		await sendWebhook(job);
		expect(terminals).toHaveLength(2);
		expect(terminals[0]).toEqual(terminals[1]);
		expect(job.terminalWebhookAcknowledgedAt).toBeNumber();
		expect(updateJob(job.jobId, { phase: "error" })).toBeUndefined();
		expect(job.phase).toBe("complete");
	});
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
