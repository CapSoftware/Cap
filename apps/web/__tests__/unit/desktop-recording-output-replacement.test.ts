import type { VideoEditSpec } from "@cap/database/types";
import { Effect, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	db: vi.fn(),
	access: vi.fn(),
	head: vi.fn(),
	post: vi.fn(),
	retire: vi.fn(),
	env: vi.fn(),
	fetch: vi.fn(),
	cloudfront: vi.fn(),
	auth: vi.fn(),
}));
vi.mock("@cap/database", () => ({ db: mocks.db }));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: mocks.auth }));
vi.mock("@cap/database/schema", () => ({
	videos: { table: "videos", id: "id" },
	videoUploads: {
		table: "uploads",
		videoId: "videoId",
		phase: "phase",
		rawFileKey: "rawFileKey",
	},
	videoEdits: { table: "edits" },
	comments: { table: "comments" },
}));
vi.mock("drizzle-orm", () => ({ and: vi.fn(), eq: vi.fn() }));
vi.mock("@cap/env", () => ({ serverEnv: mocks.env }));
vi.mock("@cap/web-backend", () => ({
	Storage: { getAccessForVideo: mocks.access },
	AwsCredentials: {},
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: { getAccessForVideo: mocks.access },
}));
vi.mock("@cap/web-backend/src/Aws", () => ({ AwsCredentials: {} }));
vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
	sleep: vi.fn(),
}));
vi.mock("@aws-sdk/client-cloudfront", () => ({
	CloudFrontClient: class {
		send = mocks.cloudfront;
	},
	CreateInvalidationCommand: class {
		constructor(readonly input: unknown) {}
	},
}));
vi.mock("@/lib/desktop-recording-jobs", () => ({
	retireDesktopRecordingJobForOutputReplacement: mocks.retire,
}));
vi.mock("@/lib/messenger/constants", () => ({
	MESSENGER_ADMIN_EMAIL: "admin@cap.test",
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
vi.mock("@/lib/edit-transcript-storage", () => ({
	decryptEditTranscriptObject: () => null,
}));
vi.mock("@/lib/generate-ai", () => ({ startAiGeneration: vi.fn() }));
vi.mock("@/lib/transcribe", () => ({ transcribeVideo: vi.fn() }));

import {
	getVideoReplaceUploadUrl,
	invalidateVideoCache,
} from "@/actions/admin/replace-video";
import { saveMetadataAndComplete } from "@/workflows/admin-reprocess-video";
import {
	saveEditResultAndComplete,
	verifyRenderedEditOutput,
} from "@/workflows/edit-video";

let video: {
	id: string;
	ownerId: string;
	bucket: string | null;
	storageIntegrationId: string | null;
	source: {
		type: string;
		outputKey?: string;
		thumbnailKey?: string;
		previewKey?: string;
	};
	metadata: Record<string, unknown>;
};
let events: string[];
let updates: Record<string, unknown>[];
const metadata = { duration: 5, width: 320, height: 180, fps: 30 };
const editSpec: VideoEditSpec = {
	version: 1,
	sourceDuration: 10,
	keepRanges: [{ start: 0, end: 5 }],
};

function createClient() {
	const client = {
		select() {
			return {
				from: (table: { table: string }) => ({
					where: () => {
						const rows = table.table === "comments" ? [] : [video];
						return Object.assign(Promise.resolve(rows), {
							for: async () => {
								events.push("lock-video");
								return rows;
							},
						});
					},
				}),
			};
		},
		update(table: { table: string }) {
			return {
				set: (values: Record<string, unknown>) => ({
					where: async () => {
						events.push(`update-${table.table}`);
						if (table.table === "videos") {
							updates.push(values);
							Object.assign(video, values);
						}
						return [{ affectedRows: 1 }];
					},
				}),
			};
		},
		insert() {
			return {
				values: () => ({
					onDuplicateKeyUpdate: async () => [{ affectedRows: 1 }],
				}),
			};
		},
		delete(table: { table: string }) {
			return {
				where: async () => {
					events.push(`delete-${table.table}`);
					return [{ affectedRows: 1 }];
				},
			};
		},
	};
	return {
		...client,
		transaction: async (callback: (tx: typeof client) => Promise<unknown>) => {
			events.push("transaction");
			return callback(client);
		},
	};
}

beforeEach(() => {
	video = {
		id: "video",
		ownerId: "user",
		bucket: null,
		storageIntegrationId: null,
		source: {
			type: "desktopMP4",
			outputKey: "user/video/.recording/outputs/generation/attempt.mp4",
			thumbnailKey: "old-thumbnail",
			previewKey: "old-preview",
		},
		metadata: {
			desktopRecordingUpload: { fullDecode: true },
			customCreatedAt: "2020-01-01T00:00:00Z",
			summary: "old summary",
		},
	};
	events = [];
	updates = [];
	mocks.db.mockReturnValue(createClient());
	mocks.head.mockImplementation(() => {
		events.push("head-canonical");
		return Effect.succeed({ ETag: '"new-output"', ContentLength: 1000 });
	});
	mocks.post.mockReturnValue(
		Effect.succeed({
			url: "https://storage.test/upload",
			fields: { key: "user/video/result.mp4" },
		}),
	);
	mocks.access.mockImplementation(
		(_video, options?: { resolvePublishedOutput?: boolean }) =>
			Effect.succeed([
				{
					headObject: mocks.head,
					getPresignedPostUrl: mocks.post,
					getInternalSignedObjectUrl: (key: string) =>
						Effect.succeed(
							`https://storage.test/${options?.resolvePublishedOutput === false ? "canonical" : "published"}/${key}`,
						),
					getObject: () => Effect.succeed(Option.none()),
					listObjects: () => Effect.succeed({ Contents: [] }),
				},
			]),
	);
	mocks.retire.mockImplementation(async () => {
		events.push("retire-job");
	});
	mocks.env.mockReturnValue({
		MEDIA_SERVER_URL: "https://media.test",
		MEDIA_SERVER_WEBHOOK_SECRET: "secret",
		WEB_URL: "https://cap.test",
	});
	mocks.auth.mockResolvedValue({ id: "admin", email: "admin@cap.test" });
	mocks.fetch.mockResolvedValue(Response.json({ metadata }));
	vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => vi.unstubAllGlobals());

describe("edited recording publication", () => {
	it("verifies the newly rendered canonical output instead of the old published immutable recording", async () => {
		await verifyRenderedEditOutput("video", "user", editSpec, metadata);
		expect(mocks.access).toHaveBeenCalledWith(video, {
			resolvePublishedOutput: false,
		});
		expect(mocks.fetch).toHaveBeenCalledWith(
			"https://media.test/video/probe",
			expect.objectContaining({
				body: JSON.stringify({
					videoUrl: "https://storage.test/canonical/user/video/result.mp4",
				}),
			}),
		);
	});

	it("switches a completed edit to canonical output and retires old upload proof atomically", async () => {
		await saveEditResultAndComplete(
			"video",
			"user/video/edit-original.mp4",
			editSpec,
			editSpec,
			metadata,
		);
		expect(video.source).toEqual({ type: "desktopMP4" });
		expect(video.metadata).not.toHaveProperty("desktopRecordingUpload");
		expect(video.metadata.customCreatedAt).toBe("2020-01-01T00:00:00Z");
		expect(events.indexOf("retire-job")).toBeLessThan(
			events.indexOf("lock-video"),
		);
		expect(events.indexOf("lock-video")).toBeLessThan(
			events.indexOf("update-videos"),
		);
	});

	it("checks a reprocessed canonical object before clearing its previous immutable publication", async () => {
		await saveMetadataAndComplete("video", metadata);
		expect(mocks.access).toHaveBeenCalledWith(expect.any(Object), {
			resolvePublishedOutput: false,
		});
		expect(events.indexOf("head-canonical")).toBeLessThan(
			events.indexOf("retire-job"),
		);
		expect(video.source).toEqual({ type: "desktopMP4" });
		expect(video.metadata).not.toHaveProperty("desktopRecordingUpload");
	});

	it("retains the published recording when reprocessing did not produce a usable object", async () => {
		mocks.head.mockReturnValue(
			Effect.succeed({ ETag: '"empty"', ContentLength: 0 }),
		);
		await expect(saveMetadataAndComplete("video", metadata)).rejects.toThrow(
			"missing or empty",
		);
		expect(updates).toEqual([]);
		expect(mocks.retire).not.toHaveBeenCalled();
		expect(video.source.outputKey).toBeDefined();
	});
});

describe("intentional administrator replacements", () => {
	it("publishes the replacement even when CloudFront is not configured", async () => {
		await invalidateVideoCache("video");
		expect(video.source).toEqual({ type: "desktopMP4" });
		expect(video.metadata).not.toHaveProperty("desktopRecordingUpload");
		expect(events).toContain("delete-uploads");
		expect(mocks.cloudfront).not.toHaveBeenCalled();
	});

	it("publishes replacements in custom storage before the cache bypass return", async () => {
		video.bucket = "custom-bucket";
		mocks.env.mockReturnValue({
			CAP_CLOUDFRONT_DISTRIBUTION_ID: "distribution",
		});
		await invalidateVideoCache("video");
		expect(video.source).toEqual({ type: "desktopMP4" });
		expect(mocks.retire).toHaveBeenCalledOnce();
		expect(mocks.cloudfront).not.toHaveBeenCalled();
	});

	it("leaves the published recording and receipt untouched if the replacement has not uploaded", async () => {
		mocks.head.mockReturnValue(Effect.succeed({ ContentLength: 0 }));
		await expect(invalidateVideoCache("video")).rejects.toThrow(
			"not finished uploading",
		);
		expect(updates).toEqual([]);
		expect(mocks.retire).not.toHaveBeenCalled();
		expect(video.metadata).toHaveProperty("desktopRecordingUpload");
	});

	it("moves an explicitly replaced segmented recording to its real MP4 output", async () => {
		video.source = { type: "desktopSegments" };
		await invalidateVideoCache("video");
		expect(video.source).toEqual({ type: "desktopMP4" });
	});

	it("prepares replacement writes against the recording storage without retiring the current publication early", async () => {
		await getVideoReplaceUploadUrl("video");
		expect(mocks.access).toHaveBeenCalledWith(video, {
			resolvePublishedOutput: false,
		});
		expect(mocks.post).toHaveBeenCalledWith(
			"user/video/result.mp4",
			expect.any(Object),
		);
		expect(mocks.retire).not.toHaveBeenCalled();
	});
});
