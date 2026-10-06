import { Effect } from "effect";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopRecordingJob } from "@/lib/desktop-recording-jobs";

const mocks = vi.hoisted(() => ({
	secret: "media-secret" as string | undefined,
	rows: [] as unknown[],
	getState: vi.fn(),
	storage: vi.fn(),
	signPart: vi.fn(),
	complete: vi.fn(),
	abort: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({ where: async () => mocks.rows }),
		}),
	}),
}));
vi.mock("@cap/database/schema", () => ({
	videos: { id: "videos.id" },
	videoProcessingJobs: { videoId: "jobs.videoId" },
	videoUploads: { videoId: "uploads.videoId" },
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

import { POST } from "@/app/api/webhooks/media-server/multipart/[action]/route";
import { getDesktopRecordingOutputKey } from "@/lib/desktop-recording-source";

const ownerId = "owned-user" as DesktopRecordingJob["ownerId"];
const videoId = "owned-video" as DesktopRecordingJob["videoId"];
const generation = "c9699f1a-fe24-44f9-ac89-63d5744a058c";
const attemptId = "cf9f55f8-4d6d-44b4-a670-30c2f7e51d9b";
const outputKey = getDesktopRecordingOutputKey(
	ownerId,
	videoId,
	generation,
	attemptId,
);

function currentJob(): DesktopRecordingJob {
	const now = new Date();
	return {
		videoId,
		ownerId,
		generation,
		attemptId,
		state: "processing",
		attemptCount: 1,
		leaseExpiresAt: new Date(now.getTime() + 60_000),
		nextRetryAt: now,
		manifestSha256: "a".repeat(64),
		remoteJobId: "remote-job",
		workflowRunId: "workflow",
		source: {
			version: 1,
			kind: "segments",
			manifestSha256: "a".repeat(64),
			inventorySha256: "b".repeat(64),
			inventoryKey: `${ownerId}/${videoId}/.recording/sources/${generation}/snapshot/inventory.json`,
			requiredAudio: true,
		},
		verification: null,
		output: null,
		errorCode: null,
		errorMessage: null,
		createdAt: now,
		updatedAt: now,
	};
}

function payload() {
	return {
		videoId,
		generation,
		attemptId,
		key: outputKey,
		uploadId: "multipart-upload",
		partNumber: 1,
		contentLength: 1024,
		parts: [
			{ partNumber: 2, etag: '"part-2"', size: 1024 },
			{ partNumber: 1, etag: '"part-1"', size: 5 * 1024 * 1024 },
		],
	};
}

async function request(
	action: string,
	body: unknown = payload(),
	secret: string | null = "media-secret",
) {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (secret !== null) headers.set("x-media-server-secret", secret);
	const response = await POST(
		new NextRequest(
			`https://cap.so/api/webhooks/media-server/multipart/${action}`,
			{
				method: "POST",
				headers,
				body: JSON.stringify(body),
			},
		),
		{ params: Promise.resolve({ action }) },
	);
	if (!response) throw new Error("Multipart route did not return a response");
	return response;
}

function useStorage(provider = "s3") {
	mocks.storage.mockReturnValue(
		Effect.succeed([
			{
				provider,
				multipart: {
					getPresignedUploadPartUrl: mocks.signPart,
					complete: mocks.complete,
					abort: mocks.abort,
				},
			},
		]),
	);
}

describe("media-server multipart fencing", () => {
	beforeEach(() => {
		mocks.secret = "media-secret";
		mocks.rows = [
			{ id: videoId, ownerId, source: { type: "desktopSegments" } },
		];
		mocks.getState.mockReset().mockResolvedValue(currentJob());
		mocks.signPart
			.mockReset()
			.mockReturnValue(Effect.succeed("https://storage.test/part"));
		mocks.complete.mockReset().mockReturnValue(
			Effect.succeed({
				Location: "https://storage.test/output",
				ETag: '"output-etag"',
			}),
		);
		mocks.abort.mockReset().mockReturnValue(Effect.void);
		useStorage();
		vi.spyOn(console, "error").mockImplementation(() => undefined);
	});

	it.each([null, "wrong-secret", "éééééééééééé"])(
		"rejects missing or incorrect webhook authentication %s",
		async (secret) => {
			expect((await request("sign-part", payload(), secret)).status).toBe(401);
			expect(mocks.getState).not.toHaveBeenCalled();
			expect(mocks.storage).not.toHaveBeenCalled();
		},
	);

	it("does not accept an unset configured secret", async () => {
		mocks.secret = undefined;
		expect((await request("sign-part")).status).toBe(401);
		expect(mocks.storage).not.toHaveBeenCalled();
	});

	it("signs only the exact current attempt key and part", async () => {
		const response = await request("sign-part");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ url: "https://storage.test/part" });
		expect(mocks.getState).toHaveBeenCalledWith({ videoId });
		expect(mocks.signPart).toHaveBeenCalledWith(
			outputKey,
			"multipart-upload",
			1,
		);
	});

	it.each([
		"owner",
		"generation",
		"attempt",
		"expired",
		"unleased",
		"state",
		"source",
		"missing",
	])(
		"refuses signing and completion for an invalid %s fence",
		async (reason) => {
			const job = currentJob();
			if (reason === "owner") job.ownerId = "other-user" as typeof ownerId;
			if (reason === "generation") job.generation = "different-generation";
			if (reason === "attempt") job.attemptId = "different-attempt";
			if (reason === "expired") job.leaseExpiresAt = new Date(Date.now() - 1);
			if (reason === "unleased") job.leaseExpiresAt = null;
			if (reason === "state") job.state = "retry";
			if (reason === "source") job.source = null;
			mocks.getState.mockResolvedValue(reason === "missing" ? null : job);
			expect((await request("sign-part")).status).toBe(409);
			expect((await request("complete")).status).toBe(409);
			expect(mocks.storage).not.toHaveBeenCalled();
			expect(mocks.signPart).not.toHaveBeenCalled();
			expect(mocks.complete).not.toHaveBeenCalled();
		},
	);

	it.each([
		"other-user/owned-video/.recording/outputs/generation/attempt.mp4",
		"owned-user/other-video/result.mp4",
		"owned-user/owned-video/result.mp4",
		"owned-user/owned-video/.recording/outputs/../attempt.mp4",
		"owned-user/owned-video/.recording/outputs/%2e%2e/attempt.mp4",
	])(
		"rejects a foreign, canonical, or traversing fenced key %s",
		async (key) => {
			for (const action of ["sign-part", "complete", "abort"]) {
				expect((await request(action, { ...payload(), key })).status).toBe(400);
			}
			expect(mocks.storage).not.toHaveBeenCalled();
		},
	);

	it("completes contiguous parts in order without replacing an existing output", async () => {
		const response = await request("complete");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			success: true,
			location: "https://storage.test/output",
			objectIdentity: '"output-etag"',
		});
		expect(mocks.complete).toHaveBeenCalledWith(outputKey, "multipart-upload", {
			MultipartUpload: {
				Parts: [
					{ PartNumber: 1, ETag: '"part-1"' },
					{ PartNumber: 2, ETag: '"part-2"' },
				],
			},
			IfNoneMatch: "*",
		});
	});

	it.each([[1, 3], [1, 1], [2], []])(
		"refuses missing or duplicate multipart sequence %j",
		async (...partNumbers) => {
			const parts = partNumbers.map((partNumber) => ({
				partNumber,
				etag: '"part"',
				size: 1024,
			}));
			expect((await request("complete", { ...payload(), parts })).status).toBe(
				400,
			);
			expect(mocks.complete).not.toHaveBeenCalled();
		},
	);

	it("permits aborting the old exact key after the lease or attempt changes", async () => {
		mocks.getState.mockResolvedValue({
			...currentJob(),
			attemptId: "new-attempt",
			leaseExpiresAt: new Date(Date.now() - 1),
		});
		const response = await request("abort");
		expect(response.status).toBe(200);
		expect(mocks.getState).not.toHaveBeenCalled();
		expect(mocks.abort).toHaveBeenCalledWith(outputKey, "multipart-upload");
		expect((await request("sign-part")).status).toBe(409);
		expect((await request("complete")).status).toBe(409);
	});

	it("retains the canonical multipart contract for an unfenced legacy worker", async () => {
		const body = {
			...payload(),
			generation: undefined,
			attemptId: undefined,
			key: `${ownerId}/${videoId}/result.mp4`,
		};
		expect((await request("sign-part", body)).status).toBe(200);
		expect((await request("complete", body)).status).toBe(200);
		expect(mocks.getState).not.toHaveBeenCalled();
		expect(mocks.complete).toHaveBeenCalledWith(body.key, body.uploadId, {
			MultipartUpload: {
				Parts: [
					{ PartNumber: 1, ETag: '"part-1"' },
					{ PartNumber: 2, ETag: '"part-2"' },
				],
			},
		});
	});

	it.each([
		{ generation: undefined },
		{ attemptId: undefined },
		{ generation: "../elsewhere" },
		{ attemptId: 1 },
		{ partNumber: 0 },
		{ partNumber: 1.5 },
		{ contentLength: 0 },
		{ uploadId: "" },
	])(
		"rejects malformed or partially fenced sign requests %#",
		async (change) => {
			expect(
				(await request("sign-part", { ...payload(), ...change })).status,
			).toBe(400);
			expect(mocks.signPart).not.toHaveBeenCalled();
		},
	);

	it("returns not found for a deleted video and rejects non-S3 storage", async () => {
		mocks.rows = [];
		expect((await request("complete")).status).toBe(404);
		mocks.rows = [
			{ id: videoId, ownerId, source: { type: "desktopSegments" } },
		];
		useStorage("google-drive");
		expect((await request("complete")).status).toBe(400);
		expect(mocks.complete).not.toHaveBeenCalled();
	});

	it("does not report success when conditional multipart completion fails", async () => {
		mocks.complete.mockReturnValueOnce(
			Effect.fail(new Error("Precondition failed")),
		);
		expect((await request("complete")).status).toBe(500);
	});

	it("rejects invalid JSON and unknown multipart actions", async () => {
		const response = await POST(
			new NextRequest(
				"https://cap.so/api/webhooks/media-server/multipart/complete",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-media-server-secret": "media-secret",
					},
					body: "{",
				},
			),
			{ params: Promise.resolve({ action: "complete" }) },
		);
		if (!response) throw new Error("Multipart route did not return a response");
		expect(response.status).toBe(400);
		expect((await request("unexpected")).status).toBe(404);
		expect(mocks.storage).not.toHaveBeenCalled();
	});
});
