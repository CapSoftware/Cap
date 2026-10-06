import type { VideoEditSpec } from "@cap/database/types";
import { User, Video } from "@cap/web-domain";
import { Effect, Option, Schema } from "effect";
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
	videoProcessingJobs: { table: "jobs", videoId: "videoId" },
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
import { prepareDesktopReupload } from "@/lib/desktop-reupload";
import {
	createDesktopReuploadKey,
	createDesktopReuploadToken,
	decodeDesktopReuploadToken,
} from "@/lib/desktop-reupload-token";
import { saveMetadataAndComplete } from "@/workflows/admin-reprocess-video";
import {
	saveEditResultAndComplete,
	startMediaServerEditJob,
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
		audioLevelOutputKey?: string;
		audioLevelSourceKey?: string;
	};
	metadata: Record<string, unknown>;
};
let events: string[];
let updates: Record<string, unknown>[];
let reorderSourceKeys: boolean;
const operation = {
	token: "11111111-1111-4111-8111-111111111111",
	startedAt: "2026-09-08T12:00:00.000Z",
};
const sourceKey = "user/video/edit-original.mp4";
let upload: Record<string, unknown>;
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
						const rows =
							table.table === "comments"
								? []
								: table.table === "uploads"
									? [upload]
									: [video];
						return Object.assign(Promise.resolve(rows), {
							for: async () => {
								events.push(
									table.table === "jobs"
										? "lock-job"
										: table.table === "uploads"
											? "lock-upload"
											: "lock-video",
								);
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
							if (values.source && reorderSourceKeys) {
								video.source = Object.assign(
									{ type: video.source.type },
									Object.fromEntries(Object.entries(video.source).reverse()),
								);
							}
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
	reorderSourceKeys = false;
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
	upload = {
		phase: "complete",
		startedAt: new Date(operation.startedAt),
		rawFileKey: sourceKey,
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
		NEXTAUTH_SECRET: "test-only-desktop-reupload-signing-key",
		MEDIA_SERVER_URL: "https://media.test",
		MEDIA_SERVER_WEBHOOK_SECRET: "secret",
		WEB_URL: "https://cap.test",
	});
	mocks.auth.mockResolvedValue({ id: "admin", email: "admin@cap.test" });
	mocks.fetch.mockResolvedValue(Response.json({ metadata }));
	vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => vi.unstubAllGlobals());

describe("desktop reupload publication", () => {
	const original = () => ({
		id: Video.VideoId.make(video.id),
		ownerId: User.UserId.make(video.ownerId),
		bucketId: Option.none(),
		storageIntegrationId: Option.none(),
		source: Schema.decodeUnknownSync(Video.Video.fields.source)(video.source),
	});
	const tokenFor = (snapshot = original()) => {
		const token = decodeDesktopReuploadToken(
			createDesktopReuploadToken(snapshot, {
				uploadId: "provider-upload-id",
				provider: "s3",
				outputKey: createDesktopReuploadKey(snapshot),
			}),
		);
		if (!token) throw new Error("Expected a replacement token");
		upload.rawFileKey = token.outputKey;
		return token;
	};
	const transaction = () =>
		createClient() as unknown as Parameters<typeof prepareDesktopReupload>[0];

	it("replaces processed playback and stale AI while preserving the link's other metadata", async () => {
		video.source.audioLevelOutputKey =
			"user/video/.recording/outputs/old-audio.mp4";
		video.metadata.editProcessing = { token: "old-edit" };
		video.metadata.completedVideoEdit = { token: "completed-edit" };
		video.metadata.chapters = [{ title: "old chapter" }];
		video.metadata.aiGenerationStatus = "complete";
		const before = structuredClone(video);
		const snapshot = original();
		const token = tokenFor(snapshot);
		const tx = transaction();
		const replacement = await prepareDesktopReupload(tx, snapshot, token);
		expect(replacement).toEqual({
			source: { type: "desktopMP4", outputKey: token.outputKey },
			metadata: { customCreatedAt: "2020-01-01T00:00:00Z" },
			transcriptionStatus: null,
		});
		expect(video).toEqual(before);
		expect(events).toEqual([
			"lock-job",
			"lock-video",
			"lock-upload",
			"retire-job",
		]);
		expect(mocks.retire).toHaveBeenCalledWith(tx, {
			videoId: "video",
			userId: "user",
		});
		expect(mocks.head).not.toHaveBeenCalled();
		expect(mocks.access).not.toHaveBeenCalled();
	});

	it.each(["desktopSegments", "webMP4"])(
		"publishes a %s replacement with its immutable MP4 key",
		async (type) => {
			video.source = { type };
			const replacement = await prepareDesktopReupload(
				transaction(),
				original(),
				tokenFor(),
			);
			expect(replacement?.source.type).toBe(
				type === "webMP4" ? "webMP4" : "desktopMP4",
			);
			expect(replacement?.source.outputKey).toContain(
				"user/video/.recording/outputs/reupload-",
			);
		},
	);

	it.each(["bucket", "storageIntegrationId", "ownerId"] as const)(
		"rejects publication if %s changed during upload before retiring any job",
		async (field) => {
			const snapshot = original();
			const token = tokenFor(snapshot);
			video[field] = "different-identity";
			const before = structuredClone(video);
			await expect(
				prepareDesktopReupload(transaction(), snapshot, token),
			).rejects.toThrow("storage changed");
			expect(video).toEqual(before);
			expect(updates).toEqual([]);
			expect(events).toEqual(["lock-job", "lock-video"]);
			expect(mocks.retire).not.toHaveBeenCalled();
		},
	);

	it.each([null, "newer-upload"])(
		"rejects canceled or superseded upload %s under the lock",
		async (rawFileKey) => {
			const snapshot = original();
			const token = tokenFor(snapshot);
			upload.rawFileKey = rawFileKey;
			const before = structuredClone(video);
			await expect(
				prepareDesktopReupload(transaction(), snapshot, token),
			).rejects.toThrow("canceled or superseded");
			expect(video).toEqual(before);
			expect(mocks.retire).not.toHaveBeenCalled();
			expect(events).toEqual(["lock-job", "lock-video", "lock-upload"]);
		},
	);
	it("rejects an older upload completion after another publication", async () => {
		const snapshot = original();
		const token = tokenFor(snapshot);
		video.source.outputKey = "user/video/.recording/outputs/newer/result.mp4";
		const before = structuredClone(video);
		await expect(
			prepareDesktopReupload(transaction(), snapshot, token),
		).rejects.toThrow("source changed");
		expect(video).toEqual(before);
		expect(mocks.retire).not.toHaveBeenCalled();
	});

	it("compares normalized source fields under the lock", async () => {
		const snapshot = original();
		const token = tokenFor(snapshot);
		video.source = Object.assign(
			{ type: video.source.type },
			Object.fromEntries(Object.entries(video.source).reverse()),
			{ legacyExtra: "ignored by Video.source" },
		);
		await expect(
			prepareDesktopReupload(transaction(), snapshot, token),
		).resolves.toMatchObject({ source: { outputKey: token.outputKey } });
		expect(events).toEqual([
			"lock-job",
			"lock-video",
			"lock-upload",
			"retire-job",
		]);
	});

	it("returns no update for the exact already-published attempt without retiring a new job", async () => {
		const snapshot = original();
		const token = tokenFor(snapshot);
		video.source = { type: "desktopMP4", outputKey: token.outputKey };
		video.metadata.summary = "new summary";
		const before = structuredClone(video);
		await expect(
			prepareDesktopReupload(transaction(), snapshot, token),
		).resolves.toBeNull();
		expect(video).toEqual(before);
		expect(events).toEqual(["lock-job", "lock-video"]);
		expect(mocks.retire).not.toHaveBeenCalled();
		expect(updates).toEqual([]);
	});

	it("still validates storage on an already-published retry", async () => {
		const snapshot = original();
		const token = tokenFor(snapshot);
		video.source = { type: "desktopMP4", outputKey: token.outputKey };
		video.bucket = "changed-bucket";
		await expect(
			prepareDesktopReupload(transaction(), snapshot, token),
		).rejects.toThrow("storage changed");
		expect(mocks.retire).not.toHaveBeenCalled();
	});

	it("leaves the publication and metadata intact if retiring the job fails", async () => {
		const before = structuredClone(video);
		mocks.retire.mockImplementationOnce(async () => {
			events.push("retire-job");
			throw new Error("Job retirement failed");
		});
		await expect(
			prepareDesktopReupload(transaction(), original(), tokenFor()),
		).rejects.toThrow("Job retirement failed");
		expect(video).toEqual(before);
		expect(updates).toEqual([]);
		expect(events).toEqual([
			"lock-job",
			"lock-video",
			"lock-upload",
			"retire-job",
		]);
	});

	it("keeps job retirement inside the caller's publication transaction", async () => {
		const before = structuredClone(video);
		const retainedJob = {
			generation: "original-generation",
			state: "complete",
			sourceKey: "user/video/original-source.mp4",
			outputKey: video.source.outputKey,
		};
		let job = { ...retainedJob };
		const tx = transaction();
		mocks.retire.mockImplementationOnce(async (owner) => {
			expect(owner).toBe(tx);
			events.push("retire-job");
			job = {
				...job,
				generation: "retired-generation",
				state: "source-blocked",
			};
		});
		const publishTransaction = async () => {
			events.push("transaction");
			const savedVideo = structuredClone(video);
			const savedJob = { ...job };
			try {
				const replacement = await prepareDesktopReupload(
					tx,
					original(),
					tokenFor(),
				);
				expect(replacement).not.toBeNull();
				expect(job.state).toBe("source-blocked");
				Object.assign(video, replacement);
				events.push("publication-failed");
				throw new Error("Publication failed");
			} catch (error) {
				video = savedVideo;
				job = savedJob;
				events.push("rollback");
				throw error;
			}
		};
		await expect(publishTransaction()).rejects.toThrow("Publication failed");
		expect(video).toEqual(before);
		expect(job).toEqual(retainedJob);
		expect(events).toEqual([
			"transaction",
			"lock-job",
			"lock-video",
			"lock-upload",
			"retire-job",
			"publication-failed",
			"rollback",
		]);
	});
});

describe("edited recording publication", () => {
	it.each(["reprocess", "replace"])(
		"clears a browser audio derivative after %s",
		async (operation) => {
			video.source = {
				type: "webMP4",
				audioLevelSourceKey: "user/video/result.mp4",
				audioLevelOutputKey:
					"user/video/.recording/outputs/audio-quality-v3/test.mp4",
			};
			if (operation === "reprocess")
				await saveMetadataAndComplete("video", metadata);
			else await invalidateVideoCache("video");
			expect(video.source).toEqual({ type: "webMP4" });
		},
	);
	it.each(["desktopMP4", "webMP4"])(
		"clears the previous audio derivative when publishing a %s edit",
		async (type) => {
			video.source = {
				type,
				...(type === "desktopMP4"
					? {
							outputKey: "user/video/.recording/outputs/generation/attempt.mp4",
						}
					: {}),
				audioLevelSourceKey:
					type === "desktopMP4"
						? "user/video/.recording/outputs/generation/attempt.mp4"
						: "user/video/result.mp4",
				audioLevelOutputKey:
					"user/video/.recording/outputs/audio-quality-v3/test.mp4",
			};
			video.metadata.editProcessing = {
				...operation,
				ownerId: video.ownerId,
				bucket: video.bucket,
				storageIntegrationId: video.storageIntegrationId,
				sourceKey,
				source: JSON.stringify(video.source),
				dispatch: "accepted",
			};
			await saveEditResultAndComplete(
				"video",
				sourceKey,
				editSpec,
				editSpec,
				metadata,
				operation,
			);
			expect(video.source).toEqual({
				type,
				outputKey: `user/video/.recording/outputs/edit-${operation.token}/result.mp4`,
				thumbnailKey: `user/video/.recording/outputs/edit-${operation.token}/thumbnail.jpg`,
				previewKey: `user/video/.recording/outputs/edit-${operation.token}/preview.gif`,
			});
			expect(video.metadata.completedVideoEdit).toMatchObject(operation);
		},
	);
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

	it("verifies the current edit output independently of the published video", async () => {
		await verifyRenderedEditOutput(
			"video",
			"user",
			editSpec,
			metadata,
			operation,
		);
		expect(mocks.fetch).toHaveBeenCalledWith(
			"https://media.test/video/probe",
			expect.objectContaining({
				body: JSON.stringify({
					videoUrl: `https://storage.test/canonical/user/video/.recording/outputs/edit-${operation.token}/result.mp4`,
				}),
			}),
		);
	});

	it.each([false, true])(
		"publishes a completed edit atomically with reordered JSON keys: %s",
		async (reorder) => {
			reorderSourceKeys = reorder;
			video.metadata.editProcessing = {
				...operation,
				ownerId: video.ownerId,
				bucket: video.bucket,
				storageIntegrationId: video.storageIntegrationId,
				sourceKey,
				source: JSON.stringify(video.source),
				dispatch: "accepted",
			};
			await saveEditResultAndComplete(
				"video",
				"user/video/edit-original.mp4",
				editSpec,
				editSpec,
				metadata,
				operation,
			);
			expect(video.source).toEqual({
				type: "desktopMP4",
				outputKey: `user/video/.recording/outputs/edit-${operation.token}/result.mp4`,
				thumbnailKey: `user/video/.recording/outputs/edit-${operation.token}/thumbnail.jpg`,
				previewKey: `user/video/.recording/outputs/edit-${operation.token}/preview.gif`,
			});
			expect(video.metadata).not.toHaveProperty("desktopRecordingUpload");
			expect(video.metadata.customCreatedAt).toBe("2020-01-01T00:00:00Z");
			expect(events.indexOf("lock-job")).toBeLessThan(
				events.indexOf("lock-video"),
			);
			expect(events.indexOf("lock-video")).toBeLessThan(
				events.indexOf("update-videos"),
			);
			const before = events.length;
			await saveEditResultAndComplete(
				"video",
				sourceKey,
				editSpec,
				editSpec,
				metadata,
				operation,
			);
			expect(events).toHaveLength(before);
		},
	);

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

describe("edit dispatch acceptance", () => {
	it("retries only an explicit capacity rejection", async () => {
		mocks.fetch.mockResolvedValue(
			Response.json({ code: "SERVER_BUSY" }, { status: 503 }),
		);
		await expect(
			startMediaServerEditJob("https://media.test", { videoId: "video" }),
		).resolves.toEqual({ status: "capacity" });
		expect(mocks.fetch).toHaveBeenCalledOnce();
	});
	it("treats proxy failures as uncertain acceptance", async () => {
		mocks.fetch.mockResolvedValue(
			Response.json({ error: "Gateway timeout" }, { status: 504 }),
		);
		await expect(
			startMediaServerEditJob("https://media.test", { videoId: "video" }),
		).rejects.toThrow("uncertain");
		expect(mocks.fetch).toHaveBeenCalledOnce();
	});
	it("does not resend a request after a lost response", async () => {
		mocks.fetch.mockRejectedValue(new Error("Connection reset"));
		await expect(
			startMediaServerEditJob("https://media.test", { videoId: "video" }),
		).rejects.toThrow("Connection reset");
		expect(mocks.fetch).toHaveBeenCalledOnce();
	});
	it("accepts only responses containing the worker identity", async () => {
		mocks.fetch.mockResolvedValue(Response.json({ jobId: "worker-1" }));
		await expect(
			startMediaServerEditJob("https://media.test", { videoId: "video" }),
		).resolves.toEqual({ status: "accepted", jobId: "worker-1" });
	});
});
