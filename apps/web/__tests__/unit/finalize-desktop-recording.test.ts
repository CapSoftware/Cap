import type { User, Video } from "@cap/web-domain";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	DesktopRecordingAttempt,
	DesktopRecordingJob,
} from "@/lib/desktop-recording-jobs";

const mocks = vi.hoisted(() => ({
	state: vi.fn(),
	claim: vi.fn(),
	ensure: vi.fn(),
	persist: vi.fn(),
	heartbeat: vi.fn(),
	blocked: vi.fn(),
	retry: vi.fn(),
	attach: vi.fn(),
	defer: vi.fn(),
	commitSource: vi.fn(),
	checkpoint: vi.fn(),
	saveCheckpoint: vi.fn(),
	sourceUrls: vi.fn(),
	observe: vi.fn(),
	sleep: vi.fn(),
	env: vi.fn(),
	transcribe: vi.fn(),
	fetch: vi.fn(),
	put: vi.fn(),
	databaseRows: vi.fn(),
}));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: mocks.databaseRows,
			}),
		}),
	}),
}));
vi.mock("@cap/database/schema", () => ({ users: {}, videos: {} }));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), eq: vi.fn() }));
vi.mock("@cap/env", () => ({ serverEnv: mocks.env }));
vi.mock("workflow", () => ({ sleep: mocks.sleep }));
vi.mock("@/lib/desktop-recording-jobs", () => ({
	getProcessingState: mocks.state,
	claimProcessingAttempt: mocks.claim,
	ensureSegmentProcessingJob: mocks.ensure,
	persistCommittedSource: mocks.persist,
	initializeSourceCommitCheckpoint: mocks.checkpoint,
	persistSourceCommitCheckpoint: mocks.saveCheckpoint,
	heartbeatAttempt: mocks.heartbeat,
	markSourceBlocked: mocks.blocked,
	scheduleRetry: mocks.retry,
	attachRemoteJob: mocks.attach,
	deferWithoutMediaServer: mocks.defer,
}));
vi.mock("@/lib/desktop-recording-source", () => ({
	advanceDesktopRecordingSourceCommit: mocks.commitSource,
	buildDesktopRecordingSourceUrls: mocks.sourceUrls,
	getDesktopRecordingOutputKey: (
		owner: string,
		video: string,
		generation: string,
		attempt: string,
	) => `${owner}/${video}/.recording/outputs/${generation}/${attempt}.mp4`,
}));
vi.mock("@/lib/desktop-recording-job-status", () => ({
	observeDesktopRecordingJob: mocks.observe,
}));
vi.mock("@/lib/ai-generation-entitlement", () => ({
	isAiGenerationEnabledForUser: () => false,
}));
vi.mock("@/lib/google-drive-storage-quota-cache", () => ({
	invalidateGoogleDriveStorageQuotaCache: vi.fn(),
}));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: mocks.transcribe }));
vi.mock("@/lib/video-storage", () => ({ decodeStorageVideo: () => ({}) }));
vi.mock("@/lib/workflow-runtime", async () => ({
	runWorkflowPromise: (await import("effect")).Effect.runPromise,
}));
vi.mock("@cap/web-backend/src/Storage/index", async () => {
	const { Effect } = await import("effect");
	return {
		Storage: {
			getAccessForVideo: () =>
				Effect.succeed([
					{
						provider: "test",
						getInternalSignedObjectUrl: (key: string) =>
							Effect.succeed(`https://storage.test/${key}`),
						getInternalPresignedPutUrl: mocks.put,
					},
				]),
		},
	};
});

import {
	commitDesktopRecordingAttempt,
	finalizeDesktopRecordingWorkflow,
	pollDesktopRecordingAttempt,
	startDesktopRecordingJob,
} from "@/workflows/finalize-desktop-recording";

const videoId = "video" as Video.VideoId;
const userId = "user" as User.UserId;
const now = new Date("2026-09-02T12:00:00Z");
const source = {
	version: 1 as const,
	kind: "segments" as const,
	manifestSha256: "a".repeat(64),
	inventorySha256: "b".repeat(64),
	inventoryKey: "user/video/.recording/sources/generation/inventory.json",
	requiredAudio: true,
};
const fixture: DesktopRecordingAttempt = {
	videoId,
	ownerId: userId,
	generation: "generation",
	state: "processing",
	attemptId: "attempt",
	attemptCount: 1,
	manifestSha256: source.manifestSha256,
	leaseExpiresAt: new Date(now.getTime() + 5 * 60_000),
	nextRetryAt: now,
	workflowRunId: "run",
	remoteJobId: null,
	source,
	verification: null,
	output: null,
	errorCode: null,
	errorMessage: null,
	createdAt: now,
	updatedAt: now,
};
let current: DesktopRecordingJob | null;

function withCurrent(update: Partial<DesktopRecordingJob>) {
	if (!current) throw new Error("Fixture job disappeared");
	current = { ...current, ...update };
}

beforeEach(() => {
	mocks.databaseRows.mockResolvedValue([
		{ id: "video", ownerId: "user", source: { type: "desktopSegments" } },
	]);
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(now);
	current = { ...fixture };
	mocks.state.mockImplementation(async () => (current ? { ...current } : null));
	mocks.ensure.mockImplementation(async () => ({
		job: current,
		created: false,
	}));
	mocks.claim.mockImplementation(async () => {
		if (!current) return null;
		withCurrent({
			state: current.source ? "processing" : "committing",
			attemptId: `attempt-${current.attemptCount + 1}`,
			attemptCount: current.attemptCount + 1,
			leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
			updatedAt: new Date(),
			remoteJobId: null,
		});
		return current;
	});
	mocks.persist.mockImplementation(async (_attempt, savedSource) => {
		withCurrent({ source: savedSource, state: "processing" });
		return true;
	});
	mocks.heartbeat.mockImplementation(async () => {
		withCurrent({ leaseExpiresAt: new Date(Date.now() + 5 * 60_000) });
		return true;
	});
	mocks.retry.mockImplementation(
		async ({ nextRetryAt }: { nextRetryAt?: Date }) => {
			withCurrent({
				state: "retry",
				leaseExpiresAt: null,
				nextRetryAt: nextRetryAt ?? new Date(Date.now() + 15_000),
			});
			return true;
		},
	);
	mocks.blocked.mockImplementation(async () => {
		withCurrent({ state: "source-blocked", leaseExpiresAt: null });
		return true;
	});
	mocks.attach.mockImplementation(async ({ remoteJobId }) => {
		withCurrent({ remoteJobId });
		return true;
	});
	mocks.defer.mockImplementation(async () => {
		withCurrent({ state: "queued", leaseExpiresAt: null });
		return true;
	});
	mocks.commitSource.mockResolvedValue({ source });
	mocks.checkpoint.mockImplementation(
		async () =>
			current?.output ?? {
				kind: "desktop-recording-source-commit",
				version: 1,
				generation: fixture.generation,
				snapshotId: "snapshot",
				revision: 0,
				phase: "plan",
				cursor: 0,
				planRoots: [],
				receiptRoots: [],
			},
	);
	mocks.saveCheckpoint.mockImplementation(async (_fence, checkpoint) => {
		withCurrent({ output: checkpoint });
		return true;
	});
	mocks.sourceUrls.mockResolvedValue({
		videoInitUrl: "https://source.test/init.mp4",
		videoSegmentUrls: ["https://source.test/segment.m4s"],
		sourceObjects: [
			{
				url: "https://source.test/init.mp4",
				objectIdentity: '"init"',
				size: 100,
			},
			{
				url: "https://source.test/segment.m4s",
				objectIdentity: '"segment"',
				size: 1000,
			},
		],
		manifestSha256: source.manifestSha256,
		inventorySha256: source.inventorySha256,
	});
	mocks.observe.mockImplementation(async () => {
		withCurrent({ state: "verified" });
		return { status: "terminal", delivered: true };
	});
	mocks.sleep.mockImplementation(async (delay: number | Date) =>
		vi.setSystemTime(
			delay instanceof Date ? delay : new Date(Date.now() + delay),
		),
	);
	mocks.env.mockReturnValue({
		MEDIA_SERVER_URL: "https://media.test",
		MEDIA_SERVER_WEBHOOK_SECRET: "secret",
		ASSEMBLY_API_KEY: "assembly-test",
		WEB_URL: "https://cap.test",
	});
	mocks.transcribe.mockResolvedValue({ success: true });
	mocks.put.mockImplementation((key: string) =>
		Effect.succeed(`https://storage.test/${key}`),
	);
	mocks.fetch.mockResolvedValue(Response.json({ jobId: "remote-job" }));
	vi.stubGlobal("fetch", mocks.fetch);
});

describe("durable post-publication transcription enqueue", () => {
	it.each(["returned failure", "thrown failure"])(
		"retries %s without creating another media attempt",
		async (failure) => {
			withCurrent({ leaseExpiresAt: null });
			if (failure === "returned failure")
				mocks.transcribe.mockResolvedValueOnce({
					success: false,
					message: "Queue unavailable",
				});
			else
				mocks.transcribe.mockRejectedValueOnce(new Error("Queue unavailable"));
			const result = await finalizeDesktopRecordingWorkflow({
				videoId,
				userId,
				generation: fixture.generation,
			});
			expect(result).toMatchObject({ success: true, jobId: "remote-job" });
			expect(mocks.transcribe).toHaveBeenCalledTimes(2);
			expect(mocks.fetch).toHaveBeenCalledOnce();
			expect(mocks.claim).toHaveBeenCalledOnce();
			expect(mocks.retry).not.toHaveBeenCalled();
			expect(current?.state).toBe("verified");
			expect(mocks.sleep.mock.calls).toEqual([[15_000], [15_000]]);
		},
	);

	it("resumes failed enqueue from an already verified recording without remuxing", async () => {
		withCurrent({ state: "verified" });
		mocks.transcribe.mockResolvedValueOnce({
			success: false,
			message: "Temporary queue error",
		});
		expect(
			await finalizeDesktopRecordingWorkflow({
				videoId,
				userId,
				generation: fixture.generation,
			}),
		).toEqual({ success: true });
		expect(mocks.transcribe).toHaveBeenCalledTimes(2);
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.claim).not.toHaveBeenCalled();
	});

	it.each(["unconfigured", "deleted"])(
		"skips %s transcription without retrying forever",
		async (reason) => {
			withCurrent({ state: "verified" });
			if (reason === "unconfigured") mocks.env.mockReturnValue({});
			else mocks.databaseRows.mockResolvedValue([]);
			expect(
				await finalizeDesktopRecordingWorkflow({
					videoId,
					userId,
					generation: fixture.generation,
				}),
			).toEqual({ success: true });
			expect(mocks.transcribe).not.toHaveBeenCalled();
			expect(mocks.sleep).not.toHaveBeenCalled();
		},
	);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function pollingInput() {
	return {
		videoId,
		generation: fixture.generation,
		attemptId: fixture.attemptId,
		jobId: "remote-job",
		deadline: new Date(now.getTime() + 2 * 60 * 60_000),
	};
}

describe("short durable processing polls", () => {
	it.each(["processing-timeout", "worker-lease-expired"])(
		"does not reuse a rich attempt's stale retry date after %s",
		async (errorCode) => {
			withCurrent({ leaseExpiresAt: new Date(now.getTime() - 1) });
			mocks.observe.mockResolvedValue({
				status: "unavailable",
				delivered: false,
			});
			const input = {
				...fixture,
				...pollingInput(),
				nextRetryAt: new Date(now.getTime() - 60_000),
				...(errorCode === "processing-timeout" ? { deadline: now } : {}),
			};
			expect(await pollDesktopRecordingAttempt(input)).toBe("retry");
			expect(current?.nextRetryAt).toEqual(new Date(now.getTime() + 15_000));
			expect(mocks.retry.mock.calls[0]?.[0]).not.toHaveProperty("nextRetryAt");
			expect(mocks.retry.mock.calls[0]?.[0]).toMatchObject({
				videoId,
				generation: fixture.generation,
				attemptId: fixture.attemptId,
				errorCode,
			});
		},
	);

	it("does not treat a delivered terminal webhook as durable success until publication is committed", async () => {
		mocks.observe.mockResolvedValue({ status: "terminal", delivered: true });
		expect(await pollDesktopRecordingAttempt(pollingInput())).toBe("waiting");
		expect(mocks.sleep).not.toHaveBeenCalled();
		expect(mocks.heartbeat).not.toHaveBeenCalled();
	});

	it("returns success only from the current durable verified state", async () => {
		withCurrent({ state: "verified" });
		expect(await pollDesktopRecordingAttempt(pollingInput())).toBe("verified");
		expect(mocks.observe).not.toHaveBeenCalled();
	});

	it("does not extend a lease when the remote worker is missing", async () => {
		mocks.observe.mockResolvedValue({
			status: "unavailable",
			delivered: false,
		});
		expect(await pollDesktopRecordingAttempt(pollingInput())).toBe("waiting");
		expect(mocks.heartbeat).not.toHaveBeenCalled();
		vi.setSystemTime(new Date(now.getTime() + 6 * 60_000));
		expect(await pollDesktopRecordingAttempt(pollingInput())).toBe("retry");
		expect(current?.source).toEqual(source);
		expect(mocks.retry).toHaveBeenCalledWith(
			expect.objectContaining({
				errorCode: "worker-lease-expired",
				generation: "generation",
				attemptId: "attempt",
			}),
		);
	});

	it("renews only a positively observed matching active attempt", async () => {
		mocks.observe.mockResolvedValue({ status: "active", delivered: false });
		expect(await pollDesktopRecordingAttempt(pollingInput())).toBe("waiting");
		expect(mocks.heartbeat).toHaveBeenCalledWith({
			videoId,
			generation: "generation",
			attemptId: "attempt",
		});
		expect(mocks.observe).toHaveBeenCalledWith(
			expect.objectContaining({
				inventorySha256: source.inventorySha256,
				generation: "generation",
				attemptId: "attempt",
			}),
		);
	});

	it("ignores an older workflow after another attempt takes over", async () => {
		withCurrent({ attemptId: "new-attempt" });
		expect(await pollDesktopRecordingAttempt(pollingInput())).toBe(
			"superseded",
		);
		expect(mocks.observe).not.toHaveBeenCalled();
		expect(mocks.retry).not.toHaveBeenCalled();
	});
});

describe("source commitment and media request compatibility", () => {
	it("checkpoints each source batch in a separate durable step before processing", async () => {
		withCurrent({ source: null, state: "committing", leaseExpiresAt: null });
		mocks.commitSource.mockImplementationOnce(async (_video, checkpoint) => ({
			checkpoint: { ...checkpoint, revision: 1, phase: "copy" },
		}));
		const result = await finalizeDesktopRecordingWorkflow({
			videoId,
			userId,
			generation: fixture.generation,
		});
		expect(result.success).toBe(true);
		expect(mocks.commitSource).toHaveBeenCalledTimes(2);
		expect(mocks.saveCheckpoint).toHaveBeenCalledOnce();
		expect(mocks.persist).toHaveBeenCalledOnce();
		expect(mocks.commitSource.mock.calls[1]?.[1]).toMatchObject({
			revision: 1,
			phase: "copy",
		});
	});

	it.each(["source-missing", "source-changed", "source-invalid"])(
		"keeps %s classification when committed inventory cannot be read",
		async (code) => {
			withCurrent({ leaseExpiresAt: null });
			mocks.sourceUrls.mockRejectedValue(
				Object.assign(new Error("Committed source cannot be read"), { code }),
			);
			expect(
				await finalizeDesktopRecordingWorkflow({
					videoId,
					userId,
					generation: fixture.generation,
				}),
			).toMatchObject({ success: false, reason: "source-blocked" });
			expect(mocks.blocked).toHaveBeenCalledWith(
				expect.objectContaining({ errorCode: code }),
			);
			expect(mocks.retry).not.toHaveBeenCalled();
			expect(mocks.fetch).not.toHaveBeenCalled();
		},
	);

	it("does not start media processing before durable source commitment", async () => {
		withCurrent({ source: null });
		await expect(startDesktopRecordingJob(fixture)).rejects.toThrow(
			"superseded",
		);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("preserves incomplete originals without calling the media server", async () => {
		withCurrent({ source: null, state: "committing" });
		mocks.commitSource.mockRejectedValue(
			Object.assign(new Error("Manifest is incomplete"), {
				code: "source-incomplete",
			}),
		);
		expect(await commitDesktopRecordingAttempt(fixture)).toBe("source-blocked");
		expect(mocks.persist).not.toHaveBeenCalled();
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("sends immutable inventory identities without estimated legacy duration", async () => {
		await startDesktopRecordingJob(fixture);
		const body = JSON.parse(mocks.fetch.mock.calls[0]?.[1]?.body ?? "{}");
		expect(body).toMatchObject({
			generation: "generation",
			attemptId: "attempt",
			inventorySha256: source.inventorySha256,
			manifestSha256: source.manifestSha256,
			outputKey: "user/video/.recording/outputs/generation/attempt.mp4",
			outputUpload: { type: "put", ifNoneMatch: "*" },
		});
		expect(body).not.toHaveProperty("expectedDuration");
		expect(body.thumbnailPresignedUrl).toContain(
			"/generation/attempt/screenshot.jpg",
		);
	});

	it("reuses a recorded remote job after a step replay instead of submitting another mux", async () => {
		withCurrent({ remoteJobId: "existing-worker" });
		expect(await startDesktopRecordingJob(fixture)).toBe("existing-worker");
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("verifies a legacy MP4 from its immutable snapshot without inventing a capture duration", async () => {
		withCurrent({
			source: {
				...source,
				kind: "mp4",
				manifestSha256: undefined,
				mp4: { fileSize: 1000, objectIdentity: '"original"' },
			},
		});
		mocks.sourceUrls.mockResolvedValue({
			videoUrl: "https://source.test/recording.mp4",
			sourceObjectIdentity: '"snapshot"',
			outputKey: "user/video/.recording/sources/generation/mp4/0.mp4",
		});
		await startDesktopRecordingJob(fixture);
		expect(mocks.fetch.mock.calls[0]?.[0]).toBe(
			"https://media.test/video/verify-recording",
		);
		const body = JSON.parse(mocks.fetch.mock.calls[0]?.[1]?.body ?? "{}");
		expect(body).toMatchObject({
			originalObjectIdentity: '"original"',
			sourceObjectIdentity: '"snapshot"',
			fileSize: 1000,
		});
		expect(body).not.toHaveProperty("duration");
	});

	it("retains explicit modern MP4 duration and audio requirements", async () => {
		withCurrent({
			source: {
				...source,
				kind: "mp4",
				manifestSha256: undefined,
				mp4: { fileSize: 1000, objectIdentity: '"original"' },
			},
			verification: {
				version: 1,
				artifact: {
					kind: "mp4",
					fileSize: 1000,
					duration: 91.6,
					objectIdentity: '"original"',
				},
				requiredAudio: true,
			},
		});
		mocks.sourceUrls.mockResolvedValue({
			videoUrl: "https://source.test/recording.mp4",
			sourceObjectIdentity: '"snapshot"',
			outputKey: "user/video/.recording/sources/generation/mp4/0.mp4",
		});
		await startDesktopRecordingJob(fixture);
		const body = JSON.parse(mocks.fetch.mock.calls[0]?.[1]?.body ?? "{}");
		expect(body).toMatchObject({ duration: 91.6, requiredAudio: true });
	});
});

describe("workflow retry lifetime", () => {
	it("waits for fresh backoff after a source commit failure with a rich stale attempt", async () => {
		withCurrent({
			state: "committing",
			source: null,
			leaseExpiresAt: null,
			nextRetryAt: new Date(now.getTime() - 60_000),
		});
		mocks.commitSource.mockRejectedValueOnce(
			new Error("provider copy unavailable"),
		);
		expect(
			await finalizeDesktopRecordingWorkflow({
				videoId,
				userId,
				generation: fixture.generation,
			}),
		).toEqual({ success: true, jobId: "remote-job" });
		expect(mocks.retry).toHaveBeenCalledWith({
			videoId,
			generation: fixture.generation,
			attemptId: "attempt-2",
			errorCode: "processing-interrupted",
			errorMessage: "provider copy unavailable",
		});
		expect(mocks.sleep.mock.calls[0]).toEqual([
			new Date(now.getTime() + 15_000),
		]);
		expect(mocks.claim.mock.calls[1]?.[0].now).toEqual(
			new Date(now.getTime() + 15_000),
		);
		expect(mocks.fetch).toHaveBeenCalledOnce();
	});

	it("waits durably between failed attempts and continues past the old eight-attempt cutoff", async () => {
		withCurrent({
			state: "committing",
			source: null,
			leaseExpiresAt: null,
			attemptId: null,
			attemptCount: 0,
		});
		let submitted = 0;
		mocks.fetch.mockImplementation(async () => {
			if (++submitted <= 9) throw new Error("worker restarting");
			return Response.json({ jobId: "recovered-worker" });
		});
		const result = await finalizeDesktopRecordingWorkflow({
			videoId,
			userId,
			generation: "generation",
		});
		expect(result).toEqual({ success: true, jobId: "recovered-worker" });
		expect(mocks.retry).toHaveBeenCalledTimes(9);
		expect(mocks.commitSource).toHaveBeenCalledOnce();
		expect(
			mocks.sleep.mock.calls.some(([delay]) => delay instanceof Date),
		).toBe(true);
		expect(mocks.sleep.mock.calls.some(([delay]) => delay === 15_000)).toBe(
			true,
		);
	});

	it("preserves the self-hosted playback fallback without issuing a verified cleanup receipt", async () => {
		withCurrent({
			state: "queued",
			leaseExpiresAt: null,
			attemptId: null,
			attemptCount: 0,
		});
		mocks.env.mockReturnValue({ WEB_URL: "https://self-hosted.test" });
		const result = await finalizeDesktopRecordingWorkflow({
			videoId,
			userId,
			generation: "generation",
		});
		expect(result).toEqual({
			success: false,
			reason: "media-server-unconfigured",
		});
		expect(current?.source).toEqual(source);
		expect(current?.state).not.toBe("verified");
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
});
