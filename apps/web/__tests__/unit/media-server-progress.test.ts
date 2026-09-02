import { Effect } from "effect";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopRecordingJob } from "@/lib/desktop-recording-jobs";

const mocks = vi.hoisted(() => ({
	secret: "media-secret" as string | undefined,
	db: vi.fn(),
	getState: vi.fn(),
	retry: vi.fn(),
	blocked: vi.fn(),
	head: vi.fn(),
	storage: vi.fn(),
	queue: vi.fn(),
	transcribe: vi.fn(),
	invalidateQuota: vi.fn(),
	tables: {
		videos: {
			id: "videos.id",
			ownerId: "videos.ownerId",
			metadata: "videos.metadata",
		},
		jobs: { videoId: "jobs.videoId" },
		uploads: { videoId: "uploads.videoId", rawFileKey: "uploads.rawFileKey" },
	},
}));

vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/schema", () => ({
	videos: mocks.tables.videos,
	videoProcessingJobs: mocks.tables.jobs,
	videoUploads: mocks.tables.uploads,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ MEDIA_SERVER_WEBHOOK_SECRET: mocks.secret }),
}));
vi.mock("@cap/web-backend", () => ({
	Storage: { getAccessForVideo: mocks.storage },
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: { getAccessForVideo: mocks.storage },
}));
vi.mock("@/lib/desktop-recording-jobs", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/desktop-recording-jobs")>()),
	getProcessingState: mocks.getState,
	scheduleRetry: mocks.retry,
	markSourceBlocked: mocks.blocked,
}));
vi.mock("@/lib/server", async () => ({
	runPromise: (await import("effect")).Effect.runPromise,
}));
vi.mock("@/lib/workflow-runtime", async () => ({
	runWorkflowPromise: (await import("effect")).Effect.runPromise,
}));
vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));
vi.mock("@/lib/desktop-segments-finalization", () => ({
	queueDesktopSegmentsFinalization: mocks.queue,
}));
vi.mock("@/lib/google-drive-storage-quota", () => ({
	invalidateGoogleDriveStorageQuotaCache: mocks.invalidateQuota,
}));
vi.mock("@/lib/google-drive-storage-quota-cache", () => ({
	invalidateGoogleDriveStorageQuotaCache: mocks.invalidateQuota,
}));
vi.mock("@/lib/queue-video-transcription", () => ({
	queueVideoTranscription: mocks.transcribe,
	shouldQueueTranscriptionAfterMediaComplete: () => true,
}));

import { POST } from "@/app/api/webhooks/media-server/progress/route";
import {
	parseDesktopRecordingJob,
	SourceCommitPendingError,
} from "@/lib/desktop-recording-jobs";
import { getDesktopRecordingOutputKey } from "@/lib/desktop-recording-source";

const ownerId = "owned-user" as DesktopRecordingJob["ownerId"];
const videoId = "owned-video" as DesktopRecordingJob["videoId"];
const generation = "c9699f1a-fe24-44f9-ac89-63d5744a058c";
const attemptId = "cf9f55f8-4d6d-44b4-a670-30c2f7e51d9b";
const manifestSha256 = "a".repeat(64);
const inventorySha256 = "b".repeat(64);
const outputKey = getDesktopRecordingOutputKey(
	ownerId,
	videoId,
	generation,
	attemptId,
);
const metadata = {
	fileSize: 4096,
	duration: 5,
	width: 320,
	height: 180,
	fps: 30,
	videoCodec: "h264",
	audioCodec: "aac",
};
const verification = {
	version: 1 as const,
	artifact: { kind: "segments" as const, manifestSha256 },
	requiredAudio: true,
};

function fixture() {
	const now = new Date();
	const job: DesktopRecordingJob = {
		videoId,
		ownerId,
		generation,
		attemptId,
		manifestSha256,
		state: "processing",
		attemptCount: 1,
		leaseExpiresAt: new Date(now.getTime() + 60_000),
		nextRetryAt: now,
		workflowRunId: "workflow-1",
		remoteJobId: "remote-1",
		source: {
			version: 1,
			kind: "segments",
			manifestSha256,
			inventorySha256,
			inventoryKey: `${ownerId}/${videoId}/.recording/sources/${generation}/snapshot/inventory.json`,
			requiredAudio: true,
		},
		verification,
		output: null,
		errorCode: null,
		errorMessage: null,
		createdAt: now,
		updatedAt: now,
	};
	const payload = {
		jobId: "remote-1",
		videoId,
		generation,
		attemptId,
		phase: "complete",
		progress: 100,
		metadata: { ...metadata },
		recordingVerification: {
			request: verification,
			fullDecode: true,
			objectIdentity: '"output-etag"',
			outputKey,
			outputSha256: "c".repeat(64),
			sourceProof: {
				version: 1,
				manifestSha256,
				inventorySha256,
				sourcePreserved: true,
				videoDuration: metadata.duration,
				hasAudio: true,
				audioVerified: true,
			},
		},
	};
	return { job, payload };
}

type Mutation = {
	operation: "update" | "delete";
	table: unknown;
	values?: Record<string, unknown>;
};

function databaseFixture(initial: DesktopRecordingJob | null = fixture().job) {
	let current = initial;
	let rawFileKey: string | null = null;
	const video: Record<string, unknown> = {
		id: videoId,
		ownerId,
		source: { type: "desktopSegments" },
		metadata: {},
		storageIntegrationId: null,
		bucket: null,
	};
	const mutations: Mutation[] = [];
	const rows = (table: unknown) => {
		if (table === mocks.tables.videos) return [structuredClone(video)];
		if (table === mocks.tables.jobs)
			return current ? [structuredClone(current)] : [];
		if (table === mocks.tables.uploads) return [{ rawFileKey }];
		throw new Error("Unexpected table");
	};
	const writes = (pending: Mutation[]) => ({
		update: (table: unknown) => ({
			set: (values: Record<string, unknown>) => ({
				where: async () => {
					pending.push({ operation: "update", table, values });
					return [{ affectedRows: 1 }];
				},
			}),
		}),
		delete: (table: unknown) => ({
			where: async () => {
				pending.push({ operation: "delete", table });
				return [{ affectedRows: 1 }];
			},
		}),
	});
	function transactionHandle(pending: Mutation[]) {
		return {
			select: () => ({
				from: (table: unknown) => ({
					where: () => ({ for: async () => rows(table) }),
				}),
			}),
			...writes(pending),
		};
	}
	const transaction = vi.fn(
		async (
			operation: (tx: ReturnType<typeof transactionHandle>) => Promise<unknown>,
		) => {
			const pending: Mutation[] = [];
			const result = await operation(transactionHandle(pending));
			for (const mutation of pending) {
				mutations.push(mutation);
				if (mutation.operation !== "update") continue;
				if (mutation.table === mocks.tables.jobs && current) {
					current = { ...current, ...mutation.values };
				} else if (mutation.table === mocks.tables.videos) {
					Object.assign(video, mutation.values);
				}
			}
			return result;
		},
	);
	mocks.db.mockReturnValue({
		select: () => ({
			from: (table: unknown) => ({ where: async () => rows(table) }),
		}),
		...writes(mutations),
		transaction,
	});
	mocks.getState.mockImplementation(async () =>
		current ? parseDesktopRecordingJob(structuredClone(current)) : null,
	);
	return {
		mutations,
		video,
		transaction,
		setRawFileKey: (key: string) => {
			rawFileKey = key;
		},
	};
}

function request(
	body: unknown = fixture().payload,
	secret: string | null = "media-secret",
) {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (secret !== null) headers.set("x-media-server-secret", secret);
	return POST(
		new NextRequest("https://cap.so/api/webhooks/media-server/progress", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		}),
	);
}

describe("media-server recording progress webhook", () => {
	beforeEach(() => {
		mocks.secret = "media-secret";
		mocks.storage.mockReturnValue(Effect.succeed([{ headObject: mocks.head }]));
		mocks.head.mockImplementation((key: string) =>
			key.endsWith(".mp4")
				? Effect.succeed({
						ContentLength: metadata.fileSize,
						ETag: '"output-etag"',
					})
				: Effect.fail(new Error("Asset absent")),
		);
		mocks.queue.mockReset().mockResolvedValue("queued");
		mocks.transcribe.mockReset().mockResolvedValue({ success: true });
		mocks.invalidateQuota.mockResolvedValue(undefined);
		mocks.retry.mockResolvedValue(true);
		mocks.blocked.mockResolvedValue(true);
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	it.each([null, "wrong-secret", "éééééééééééé"])(
		"rejects unauthenticated callbacks before publication %s",
		async (secret) => {
			const database = databaseFixture();
			expect((await request(fixture().payload, secret)).status).toBe(401);
			expect(mocks.getState).not.toHaveBeenCalled();
			expect(database.mutations).toEqual([]);
			expect(mocks.transcribe).not.toHaveBeenCalled();
		},
	);

	it("refuses callbacks when the webhook secret is not configured", async () => {
		databaseFixture();
		mocks.secret = undefined;
		expect((await request()).status).toBe(401);
		expect(mocks.getState).not.toHaveBeenCalled();
	});

	it("publishes the fenced immutable output before queueing transcription", async () => {
		const database = databaseFixture();
		mocks.transcribe.mockImplementation(async () => {
			expect(database.mutations).toContainEqual(
				expect.objectContaining({
					table: mocks.tables.jobs,
					values: expect.objectContaining({ state: "verified" }),
				}),
			);
			return { success: true };
		});
		const response = await request();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true });
		expect(database.mutations).toContainEqual(
			expect.objectContaining({
				table: mocks.tables.videos,
				values: expect.objectContaining({
					source: { type: "desktopMP4", outputKey },
				}),
			}),
		);
		expect(mocks.head).toHaveBeenCalledWith(outputKey);
		expect(mocks.transcribe).toHaveBeenCalledExactlyOnceWith(videoId);
		expect(mocks.queue).not.toHaveBeenCalled();
	});

	it("does not repeat publication or transcription for a duplicate callback", async () => {
		const database = databaseFixture();
		expect((await request()).status).toBe(200);
		const count = database.mutations.length;
		expect((await request()).status).toBe(200);
		expect(database.mutations).toHaveLength(count);
		expect(mocks.transcribe).toHaveBeenCalledOnce();
	});

	it("keeps the completed recording published if transcription is unavailable", async () => {
		const database = databaseFixture();
		mocks.transcribe.mockRejectedValueOnce(
			new Error("Transcription unavailable"),
		);
		expect((await request()).status).toBe(200);
		expect(database.video.source).toEqual({ type: "desktopMP4", outputKey });
	});

	it.each(["generation", "attempt", "remote", "expired"])(
		"acknowledges but does not publish a stale %s callback",
		async (reason) => {
			const { job, payload } = fixture();
			if (reason === "generation") job.generation = "new-generation";
			if (reason === "attempt") job.attemptId = "new-attempt";
			if (reason === "remote") job.remoteJobId = "new-remote-job";
			if (reason === "expired") job.leaseExpiresAt = new Date(Date.now() - 1);
			const database = databaseFixture(job);
			expect((await request(payload)).status).toBe(200);
			expect(database.mutations).toEqual([]);
			expect(mocks.head).not.toHaveBeenCalled();
			expect(mocks.queue).not.toHaveBeenCalled();
			expect(mocks.transcribe).not.toHaveBeenCalled();
		},
	);

	it("rejects fenced callbacks without a current job or from a different owner", async () => {
		let database = databaseFixture(null);
		expect((await request()).status).toBe(409);
		expect(database.mutations).toEqual([]);
		database = databaseFixture();
		database.video.ownerId = "different-owner";
		expect((await request()).status).toBe(409);
		expect(database.mutations).toEqual([]);
		expect(mocks.head).not.toHaveBeenCalled();
	});

	it.each([
		{ generation: 123 },
		{ generation: "" },
		{ generation: undefined },
		{ attemptId: undefined },
		{ attemptId: {} },
		{ videoId: undefined },
		{ videoId: 123 },
		{ jobId: undefined },
		{ phase: "unexpected" },
		{ progress: 101 },
		{ recordingVerification: { request: verification, fullDecode: false } },
	])(
		"rejects malformed callbacks without falling through to legacy writes %#",
		async (change) => {
			const database = databaseFixture();
			const response = await request({ ...fixture().payload, ...change });
			expect(response.status).toBe(400);
			expect(database.mutations).toEqual([]);
			expect(mocks.head).not.toHaveBeenCalled();
			expect(mocks.queue).not.toHaveBeenCalled();
			expect(mocks.transcribe).not.toHaveBeenCalled();
		},
	);

	it("leaves the upload pending when the remotely verified object was replaced", async () => {
		const database = databaseFixture();
		mocks.head.mockReturnValue(
			Effect.succeed({
				ContentLength: metadata.fileSize,
				ETag: '"other-output"',
			}),
		);
		const response = await request();
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(database.mutations).toEqual([]);
		expect(mocks.transcribe).not.toHaveBeenCalled();
	});

	it.each(["processing-unavailable", "source-missing"])(
		"routes a current %s failure to durable recovery without publishing",
		async (errorCode) => {
			const database = databaseFixture();
			const response = await request({
				...fixture().payload,
				phase: "error",
				errorCode,
				error: "Worker failed",
			});
			expect(response.status).toBe(200);
			const expected =
				errorCode === "source-missing" ? mocks.blocked : mocks.retry;
			expect(expected).toHaveBeenCalledWith({
				videoId,
				generation,
				attemptId,
				errorCode,
				errorMessage: "Worker failed",
			});
			expect(database.mutations).toEqual([]);
			expect(mocks.transcribe).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ sourceType: "desktopSegments", hasProof: false },
		{ sourceType: "desktopMP4", hasProof: false },
		{ sourceType: "desktopMP4", hasProof: true },
	])(
		"adopts $sourceType completion (proof: $hasProof) without publishing canonical media",
		async ({ sourceType, hasProof }) => {
			const database = databaseFixture(null);
			database.video.source = { type: sourceType };
			const proof = hasProof
				? {
						request: {
							version: 1,
							artifact: {
								kind: "mp4",
								fileSize: 4096,
								duration: 5,
								objectIdentity: '"legacy-upload"',
							},
							requiredAudio: true,
						},
						fullDecode: true,
						objectIdentity: '"legacy-upload"',
					}
				: undefined;
			const response = await request({
				jobId: "legacy-worker",
				videoId,
				phase: "complete",
				progress: 100,
				metadata,
				recordingVerification: proof,
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				success: true,
				status: "queued-for-verification",
			});
			expect(mocks.queue).toHaveBeenCalledWith({
				videoId,
				userId: ownerId,
				verification: proof?.request,
			});
			expect(database.mutations).toEqual([]);
			expect(mocks.head).not.toHaveBeenCalled();
			expect(mocks.transcribe).not.toHaveBeenCalled();
		},
	);

	it("accepts a legacy worker callback while durable source commitment remains pending", async () => {
		const database = databaseFixture(null);
		mocks.queue.mockRejectedValueOnce(new SourceCommitPendingError());
		const response = await request({
			jobId: "legacy-worker",
			videoId,
			phase: "complete",
			progress: 100,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			status: "queued-for-verification",
		});
		expect(database.mutations).toEqual([]);
		expect(mocks.transcribe).not.toHaveBeenCalled();
	});

	it("keeps the explicit edit path for this recording's owned original source", async () => {
		const database = databaseFixture(null);
		database.video.source = { type: "desktopMP4" };
		database.setRawFileKey(`${ownerId}/${videoId}/source/original.mp4`);
		const response = await request({
			jobId: "edit-worker",
			videoId,
			phase: "complete",
			progress: 100,
			metadata,
		});
		expect(response.status).toBe(200);
		expect(mocks.queue).not.toHaveBeenCalled();
		expect(database.mutations).toContainEqual(
			expect.objectContaining({
				operation: "update",
				table: mocks.tables.uploads,
				values: expect.objectContaining({ phase: "complete" }),
			}),
		);
		expect(
			database.mutations.some(({ operation }) => operation === "delete"),
		).toBe(false);
		expect(mocks.head).not.toHaveBeenCalled();
	});

	it.each([
		`other-user/${videoId}/source/original.mp4`,
		`${ownerId}/other-video/source/original.mp4`,
	])("does not treat the foreign key %s as an edit exception", async (key) => {
		const database = databaseFixture(null);
		database.video.source = { type: "desktopMP4" };
		database.setRawFileKey(key);
		const response = await request({
			jobId: "legacy-worker",
			videoId,
			phase: "complete",
			progress: 100,
			metadata,
		});
		expect(response.status).toBe(200);
		expect(mocks.queue).toHaveBeenCalledWith({
			videoId,
			userId: ownerId,
			verification: undefined,
		});
		expect(database.mutations).toEqual([]);
	});

	it.each(["verified", "output-replaced"])(
		"preserves intentional generic replacement processing after %s",
		async (state) => {
			const { job } = fixture();
			if (state === "verified") job.state = "verified";
			else {
				job.state = "source-blocked";
				job.errorCode = "output-replaced";
			}
			const database = databaseFixture(job);
			database.video.source = { type: "desktopMP4", outputKey };
			database.setRawFileKey(`${ownerId}/${videoId}/replacement.mp4`);
			const response = await request({
				jobId: "replacement-worker",
				videoId,
				phase: "complete",
				progress: 100,
				metadata,
			});
			expect(response.status).toBe(200);
			expect(mocks.queue).not.toHaveBeenCalled();
			expect(mocks.head).not.toHaveBeenCalled();
			expect(database.mutations).toContainEqual({
				operation: "delete",
				table: mocks.tables.uploads,
			});
			expect(
				database.mutations.some(
					({ table, values }) =>
						table === mocks.tables.jobs || values?.source !== undefined,
				),
			).toBe(false);
		},
	);

	it("does not discard an invalid proof while adopting an old completion", async () => {
		const database = databaseFixture(null);
		const response = await request({
			jobId: "legacy-worker",
			videoId,
			phase: "complete",
			progress: 100,
			recordingVerification: {
				request: { ...verification, version: 2 },
				fullDecode: true,
			},
		});
		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(mocks.queue).not.toHaveBeenCalled();
		expect(database.mutations).toEqual([]);
	});

	it("updates only the current attempt's progress without treating it as completed", async () => {
		const database = databaseFixture();
		const response = await request({
			...fixture().payload,
			phase: "processing",
			progress: 42,
			message: "Verifying source media",
		});
		expect(response.status).toBe(200);
		expect(database.mutations).toContainEqual(
			expect.objectContaining({
				table: mocks.tables.uploads,
				values: expect.objectContaining({
					phase: "processing",
					processingProgress: 42,
				}),
			}),
		);
		expect(
			database.mutations.some(({ table }) => table === mocks.tables.videos),
		).toBe(false);
		expect(mocks.head).not.toHaveBeenCalled();
		expect(mocks.transcribe).not.toHaveBeenCalled();
	});

	it("does not let an unfenced old worker replace a managed recording", async () => {
		const database = databaseFixture();
		const response = await request({
			jobId: "legacy-worker",
			videoId,
			phase: "complete",
			progress: 100,
			metadata,
		});
		expect(response.status).toBe(200);
		expect(database.mutations).toEqual([]);
		expect(mocks.queue).not.toHaveBeenCalled();
		expect(mocks.head).not.toHaveBeenCalled();
		expect(mocks.transcribe).not.toHaveBeenCalled();
	});

	it("never falls back to canonical publication if legacy source adoption fails", async () => {
		const database = databaseFixture(null);
		mocks.queue.mockRejectedValueOnce(new Error("Durable queue unavailable"));
		expect(
			(
				await request({
					jobId: "legacy-worker",
					videoId,
					phase: "complete",
					progress: 100,
				})
			).status,
		).toBe(500);
		expect(database.mutations).toEqual([]);
		expect(mocks.transcribe).not.toHaveBeenCalled();
	});
});
