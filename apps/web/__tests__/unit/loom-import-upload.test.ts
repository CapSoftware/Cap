import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	set: vi.fn(),
	where: vi.fn(),
	create: vi.fn(),
	abort: vi.fn(),
	head: vi.fn(),
	get: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({ update: () => ({ set: mocks.set }) }),
}));
vi.mock("@cap/database/schema", () => ({
	videos: {
		id: "id",
		ownerId: "ownerId",
		orgId: "orgId",
		metadata: "metadata",
	},
}));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: (effect: Effect.Effect<unknown>) =>
		Effect.runPromise(effect),
}));

import {
	LOOM_IMPORT_MAX_BYTES,
	LOOM_IMPORT_PART_BYTES,
	prepareLoomMultipartUploads,
} from "@/lib/loom-import-upload";

type Input = Parameters<typeof prepareLoomMultipartUploads>[0];

const video = {
	id: "video",
	ownerId: "owner",
	orgId: "organization",
	metadata: { loomImportRun: { runId: "run", dispatch: "accepted" } },
} as Input["video"];

function input(): Input {
	return {
		video,
		bucket: {
			provider: "s3",
			headObject: mocks.head,
			getInternalSignedObjectUrl: mocks.get,
			multipart: { create: mocks.create, abort: mocks.abort },
		} as unknown as Input["bucket"],
		attemptId: "run:0",
		sourceKey: "owner/video/raw-upload.mp4",
		webhookBaseUrl: "https://cap.example.com",
		webhookSecret: "fixture-secret",
	};
}

describe("Loom multipart upload preparation", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.set.mockReturnValue({ where: mocks.where });
		mocks.where.mockResolvedValue([{ affectedRows: 1 }]);
		mocks.create.mockImplementation((key: string) =>
			Effect.succeed({ UploadId: `upload:${key}` }),
		);
		mocks.abort.mockReturnValue(Effect.void);
		mocks.head.mockReturnValue(Effect.fail({ name: "NotFound" }));
		mocks.get.mockReturnValue(
			Effect.succeed("https://storage.example.com/result.mp4"),
		);
	});

	it("prepares original and output parts for files up to 10 GB", async () => {
		const result = await prepareLoomMultipartUploads(input());
		expect(LOOM_IMPORT_MAX_BYTES).toBe(10 * 1024 ** 3);
		expect(Math.ceil(LOOM_IMPORT_MAX_BYTES / LOOM_IMPORT_PART_BYTES)).toBe(160);
		expect(mocks.create.mock.calls.map(([key]) => key)).toEqual([
			"owner/video/raw-upload.mp4",
			"owner/video/result.mp4",
		]);
		expect(result.sourceUpload).toMatchObject({
			type: "multipart",
			key: "owner/video/raw-upload.mp4",
			loomImportAttemptId: "run:0",
			partSize: 64 * 1024 ** 2,
		});
		expect(result.outputUpload).toMatchObject({
			type: "multipart",
			key: "owner/video/result.mp4",
			loomImportAttemptId: "run:0",
		});
		expect(mocks.where).toHaveBeenCalledOnce();
	});

	it("reuses the same multipart reservations after worker backpressure", async () => {
		const args = input();
		args.video = {
			...video,
			metadata: {
				...video.metadata,
				loomImportUpload: {
					attemptId: "run:0",
					ownerId: "owner",
					organizationId: "organization",
					source: { key: "owner/video/raw-upload.mp4", uploadId: "source-id" },
					output: { key: "owner/video/result.mp4", uploadId: "output-id" },
				},
			},
		};
		const result = await prepareLoomMultipartUploads(args);
		expect(result.sourceUpload?.uploadId).toBe("source-id");
		expect(result.outputUpload?.uploadId).toBe("output-id");
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.where).not.toHaveBeenCalled();
	});

	it("reuses an identity-bound saved output without reserving or overwriting objects", async () => {
		const args = input();
		args.video = {
			...video,
			metadata: {
				...video.metadata,
				loomImportUpload: {
					attemptId: "run:0",
					ownerId: "owner",
					organizationId: "organization",
					output: {
						key: "owner/video/result.mp4",
						uploadId: "completed-upload",
					},
				},
			},
		};
		mocks.head.mockReturnValue(
			Effect.succeed({ ContentLength: 4096, ETag: '"saved-output"' }),
		);
		const result = await prepareLoomMultipartUploads({
			...args,
			attemptId: "run:1",
		});
		expect(result).toEqual({
			existingOutput: {
				url: "https://storage.example.com/result.mp4",
				objectIdentity: '"saved-output"',
				fileSize: 4096,
			},
		});
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.abort).not.toHaveBeenCalled();
		expect(mocks.where).not.toHaveBeenCalled();
	});

	it("aborts only newly reserved uploads when recording ownership changes", async () => {
		mocks.where.mockResolvedValue([{ affectedRows: 0 }]);
		await expect(prepareLoomMultipartUploads(input())).rejects.toThrow(
			"ownership changed",
		);
		expect(mocks.abort.mock.calls).toEqual([
			["owner/video/raw-upload.mp4", "upload:owner/video/raw-upload.mp4"],
			["owner/video/result.mp4", "upload:owner/video/result.mp4"],
		]);
	});

	it("cleans up the original reservation if the output cannot be reserved", async () => {
		mocks.create
			.mockReturnValueOnce(Effect.succeed({ UploadId: "source-id" }))
			.mockReturnValueOnce(Effect.fail(new Error("Storage unavailable")));
		await expect(prepareLoomMultipartUploads(input())).rejects.toThrow();
		expect(mocks.abort).toHaveBeenCalledExactlyOnceWith(
			"owner/video/raw-upload.mp4",
			"source-id",
		);
		expect(mocks.where).not.toHaveBeenCalled();
	});

	it("refuses a stale workflow and another recording's source key", async () => {
		await expect(
			prepareLoomMultipartUploads({ ...input(), attemptId: "another-run:0" }),
		).rejects.toThrow("workflow ownership changed");
		await expect(
			prepareLoomMultipartUploads({
				...input(),
				sourceKey: "other/video/raw.mp4",
			}),
		).rejects.toThrow("does not match");
		expect(mocks.create).not.toHaveBeenCalled();
	});
});
