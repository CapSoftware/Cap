import { afterEach, describe, expect, test } from "bun:test";
import {
	beginRecordingVerification,
	cleanupExpiredJobs,
	createJob,
	deleteJob,
	getJob,
	touchJob,
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
