import { S3Bucket, User, Video } from "@cap/web-domain";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getOwnedById: vi.fn(),
	storage: vi.fn(),
	sign: vi.fn(),
	database: vi.fn(),
	prepareReplacement: vi.fn(),
	invalidate: vi.fn(),
	head: vi.fn(),
	queueTranscription: vi.fn(),
	shouldQueueTranscription: vi.fn(),
	complete: vi.fn(),
	create: vi.fn(),
	abort: vi.fn(),
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ NEXTAUTH_SECRET: "test-reupload-secret" }),
	buildEnv: { NEXT_PUBLIC_IS_CAP: true },
}));
vi.mock("@/lib/desktop-reupload", () => ({
	prepareDesktopReupload: mocks.prepareReplacement,
	invalidateReuploadedVideo: mocks.invalidate,
}));
vi.mock("@cap/web-backend", async () => {
	const { Context, Layer } = await import("effect");
	return {
		Database: Context.GenericTag("test/Database"),
		VideosPolicy: Context.GenericTag("test/VideosPolicy"),
		Storage: { getAccessForVideo: mocks.storage },
		makeCurrentUserLayer: () => Layer.empty,
		provideOptionalAuth: (effect: unknown) => effect,
	};
});
vi.mock("@/app/api/utils", () => ({
	withAuth: async (
		c: { set: (key: string, value: unknown) => void },
		next: () => Promise<void>,
	) => {
		c.set("user", { id: "owner" });
		await next();
	},
}));
vi.mock("@/lib/server", async () => {
	const { Effect, Context, Layer } = await import("effect");
	return {
		runPromise: (effect: Effect.Effect<unknown, unknown, unknown>) =>
			Effect.runPromise(
				effect.pipe(
					Effect.provide(
						Layer.succeed(Context.GenericTag("test/VideosPolicy"), {
							getOwnedById: mocks.getOwnedById,
						}),
					),
					Effect.provide(
						Layer.succeed(Context.GenericTag("test/Database"), {
							use: (callback: (client: unknown) => Promise<unknown>) =>
								Effect.tryPromise(() => callback(mocks.database())),
						}),
					),
				) as Effect.Effect<unknown>,
			),
	};
});
vi.mock("@/lib/google-drive-storage-quota", () => ({
	invalidateGoogleDriveStorageQuotaCache: vi.fn(async () => {}),
}));
vi.mock("@/lib/queue-video-transcription", () => ({
	queueVideoTranscription: mocks.queueTranscription,
	shouldQueueTranscriptionAfterMultipartComplete:
		mocks.shouldQueueTranscription,
}));
vi.mock("@/lib/video-processing", () => ({
	startVideoProcessingWorkflow: vi.fn(),
}));

import { app } from "@/app/api/upload/[...route]/multipart";
import {
	assertDesktopReuploadTarget,
	createDesktopReuploadKey,
	createDesktopReuploadToken,
	type DesktopReuploadToken,
	decodeDesktopReuploadToken,
} from "@/lib/desktop-reupload-token";

const request = () =>
	app.request("/presign-part", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			videoId: "missing-video",
			uploadId: "upload",
			partNumber: 1,
		}),
	});

describe("multipart presign ownership failures", () => {
	it("returns 404 without accessing storage for a missing or unowned video", async () => {
		mocks.getOwnedById.mockReturnValue(Effect.succeed(Option.none()));
		const response = await request();
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: "Video not found",
			code: "VIDEO_NOT_FOUND",
		});
		expect(mocks.storage).not.toHaveBeenCalled();
	});

	it("does not reveal or sign a recording owned by someone else", async () => {
		mocks.getOwnedById.mockReturnValue(Effect.fail({ _tag: "PolicyDenied" }));
		const response = await request();
		expect(response.status).toBe(404);
		expect(mocks.storage).not.toHaveBeenCalled();
	});

	it("still signs a part for its owner", async () => {
		mocks.getOwnedById.mockReturnValue(
			Effect.succeed(Option.some([{ id: "missing-video" }])),
		);
		mocks.sign.mockReturnValue(Effect.succeed("https://uploads.example/part"));
		mocks.storage.mockReturnValue(
			Effect.succeed([
				{
					provider: "s3",
					multipart: { getPresignedUploadPartUrl: mocks.sign },
				},
			]),
		);
		const response = await request();
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			provider: "s3",
			presignedUrl: "https://uploads.example/part",
		});
	});
});

describe("desktop reupload completion", () => {
	const oldKey = "owner/video/.recording/outputs/original/result.mp4";
	let events: string[];
	let updates: Record<string, unknown>[];
	let objects: Map<string, { ETag: string; ContentLength: number }>;
	let video: {
		id: Video.VideoId;
		ownerId: User.UserId;
		source: { type: "desktopMP4"; outputKey: string };
		bucketId: Video.Video["bucketId"];
		storageIntegrationId: Video.Video["storageIntegrationId"];
	};
	let outputKey: string;
	let token: string;
	let uploadKey: string | null;
	let rejectCommit: boolean;
	let provider: "s3" | "googleDrive";
	let uploadState: Record<string, unknown>;
	const dialect = new MySqlDialect();
	const mintToken = () => {
		outputKey = createDesktopReuploadKey(video);
		token = createDesktopReuploadToken(video, {
			uploadId: "backend-upload",
			provider,
			outputKey,
		});
		uploadKey = outputKey;
	};
	beforeEach(() => {
		vi.clearAllMocks();
		events = [];
		updates = [];
		objects = new Map([[oldKey, { ETag: "original", ContentLength: 90 }]]);
		provider = "s3";
		rejectCommit = false;
		uploadState = {
			phase: "error",
			processingError: "recoverable",
			uploaded: 90,
			total: 90,
		};
		video = {
			id: Video.VideoId.make("video"),
			ownerId: User.UserId.make("owner"),
			source: { type: "desktopMP4", outputKey: oldKey },
			bucketId: Option.none(),
			storageIntegrationId: Option.none(),
		};
		mintToken();
		const client = {
			select: () => ({
				from: () => ({
					innerJoin: () => ({
						where: () => ({
							limit: async () => [
								{
									stripeSubscriptionStatus: null,
									thirdPartyStripeSubscriptionId: null,
								},
							],
						}),
					}),
				}),
			}),
			transaction: async (run: (tx: unknown) => Promise<void>) => {
				const pending: Record<string, unknown>[] = [];
				let removeUpload = false;
				await run({
					update: () => ({
						set: (values: Record<string, unknown>) => ({
							where: async () => {
								pending.push(values);
								events.push("publish");
							},
						}),
					}),
					delete: () => ({
						where: async (filter: SQL) => {
							events.push("delete-upload");
							const params = dialect.sqlToQuery(filter).params;
							removeUpload = params.length === 1 || params.includes(uploadKey);
						},
					}),
				});
				if (rejectCommit) throw new Error("Database commit failed");
				for (const values of pending) {
					updates.push(values);
					if (values.source)
						video.source = values.source as typeof video.source;
				}
				if (removeUpload) uploadKey = null;
			},
			insert: () => ({
				values: (values: { rawFileKey?: string | null }) => ({
					onDuplicateKeyUpdate: async ({
						set,
					}: {
						set: Record<string, unknown>;
					}) => {
						Object.assign(uploadState, set);
						uploadKey = values.rawFileKey ?? null;
					},
				}),
			}),
			delete: () => ({
				where: async (filter: SQL) => {
					if (dialect.sqlToQuery(filter).params.includes(uploadKey))
						uploadKey = null;
				},
			}),
		};
		mocks.database.mockReturnValue(client);
		mocks.getOwnedById.mockImplementation(() =>
			Effect.sync(() =>
				Option.some([{ ...video, source: { ...video.source } }]),
			),
		);
		mocks.complete.mockImplementation((key: string) =>
			Effect.sync(() => {
				events.push("complete");
				objects.set(key, { ETag: "new-video", ContentLength: 100 });
				return { ETag: "new-video" };
			}),
		);
		mocks.create.mockReturnValue(
			Effect.succeed({ UploadId: "backend-upload" }),
		);
		mocks.abort.mockReturnValue(Effect.succeed({}));
		mocks.head.mockImplementation((key: string) => {
			const value = objects.get(key);
			return value
				? Effect.succeed(value)
				: Effect.fail(new Error("Object missing"));
		});
		mocks.storage.mockImplementation(() =>
			Effect.succeed([
				{
					provider,
					bucketName: "bucket",
					multipart: {
						complete: mocks.complete,
						create: mocks.create,
						abort: mocks.abort,
						getPresignedUploadPartUrl: mocks.sign,
					},
					headObject: (key: string) => Effect.suspend(() => mocks.head(key)),
					copyObject: () =>
						Effect.succeed({ CopyObjectResult: { ETag: "new-video" } }),
				},
			]),
		);
		mocks.sign.mockReturnValue(Effect.succeed("https://uploads.example/part"));
		mocks.prepareReplacement.mockImplementation(
			async (
				_tx: unknown,
				_snapshot: unknown,
				replacement: DesktopReuploadToken,
			) => {
				assertDesktopReuploadTarget(
					replacement,
					video,
					"owner/video/result.mp4",
					provider,
				);
				if (video.source.outputKey === replacement.outputKey) return null;
				if (uploadKey !== replacement.outputKey)
					throw new Error("Replacement upload was canceled or superseded");
				events.push("retire");
				return {
					source: { type: "desktopMP4", outputKey: replacement.outputKey },
					transcriptionStatus: null,
				};
			},
		);
		mocks.invalidate.mockImplementation(async () => {
			events.push("invalidate");
		});
		mocks.shouldQueueTranscription.mockReturnValue(false);
		mocks.queueTranscription.mockResolvedValue({ success: true });
	});
	const complete = (
		replaceExisting?: boolean,
		uploadId = token,
		durationInSecs = 5,
	) =>
		app.request("/complete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				videoId: "video",
				uploadId,
				parts: [{ partNumber: 1, etag: "part", size: 100 }],
				durationInSecs,
				replaceExisting,
			}),
		});
	const abort = () =>
		app.request("/abort", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ videoId: "video", uploadId: token }),
		});
	it.each(["s3", "googleDrive"] as const)(
		"initiates isolated %s replacement uploads",
		async (storageProvider) => {
			provider = storageProvider;
			const response = await app.request("/initiate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					videoId: "video",
					contentType: "video/mp4",
					replaceExisting: true,
				}),
			});
			expect(response.status).toBe(200);
			const body = await response.json();
			const decoded = decodeDesktopReuploadToken(body.uploadId);
			expect(decoded).toMatchObject({
				provider,
				uploadId: "backend-upload",
				videoId: "video",
			});
			expect(decoded?.outputKey).not.toBe(oldKey);
			expect(mocks.create).toHaveBeenCalledWith(
				decoded?.outputKey,
				expect.objectContaining({ ContentType: "video/mp4" }),
			);
			expect(uploadKey).toBe(decoded?.outputKey);
			expect(uploadState).toMatchObject({
				phase: "uploading",
				uploaded: 0,
				total: 0,
				processingProgress: 0,
				processingError: null,
				processingMessage: null,
			});
			expect(video.source.outputKey).toBe(oldKey);
		},
	);
	it("publishes verified replacement bytes without overwriting current playback", async () => {
		const response = await complete();
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			fileKey: outputKey,
			objectIdentity: "new-video",
		});
		expect(events).toEqual([
			"complete",
			"retire",
			"publish",
			"delete-upload",
			"invalidate",
		]);
		expect(mocks.complete).toHaveBeenCalledWith(
			outputKey,
			"backend-upload",
			expect.anything(),
		);
		expect(video.source.outputKey).toBe(outputKey);
		expect(objects.get(oldKey)).toEqual({
			ETag: "original",
			ContentLength: 90,
		});
	});
	it("uses a new playback key even when CDN invalidation fails", async () => {
		mocks.invalidate.mockRejectedValueOnce(new Error("CloudFront unavailable"));
		const response = await complete();
		expect(response.status).toBe(200);
		expect(video.source.outputKey).toBe(outputKey);
		expect(video.source.outputKey).not.toBe(oldKey);
		expect(objects.get(oldKey)?.ETag).toBe("original");
	});
	it.each([false, undefined])(
		"keeps ordinary uploads on their existing path: %s",
		async (replacementFlag) => {
			const response = await complete(replacementFlag, "legacy-upload");
			expect(response.status).toBe(200);
			expect(mocks.prepareReplacement).not.toHaveBeenCalled();
			expect(mocks.invalidate).not.toHaveBeenCalled();
			expect(updates[0]).not.toHaveProperty("source");
		},
	);
	it("rejects unsafe legacy replacement completion before storage writes", async () => {
		const response = await complete(true, "legacy-upload");
		expect(response.status).toBe(409);
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(video.source.outputKey).toBe(oldKey);
	});
	it("leaves original bytes and publication intact when storage completion fails", async () => {
		mocks.complete.mockReturnValueOnce(Effect.fail(new Error("Upload failed")));
		expect((await complete()).status).toBe(500);
		expect(video.source.outputKey).toBe(oldKey);
		expect(objects.get(oldKey)?.ETag).toBe("original");
		expect(mocks.prepareReplacement).not.toHaveBeenCalled();
	});
	it("does not publish a mismatched or empty uploaded object", async () => {
		mocks.head.mockReturnValue(
			Effect.succeed({ ETag: "new-video", ContentLength: 0 }),
		);
		expect((await complete()).status).toBe(500);
		expect(video.source.outputKey).toBe(oldKey);
		expect(mocks.prepareReplacement).not.toHaveBeenCalled();
	});
	it("preserves old playback and permits retry after database commit failure", async () => {
		rejectCommit = true;
		expect((await complete()).status).toBe(500);
		expect(video.source.outputKey).toBe(oldKey);
		expect(objects.get(oldKey)?.ETag).toBe("original");
		expect(objects.get(outputKey)?.ETag).toBe("new-video");
		rejectCommit = false;
		mocks.complete.mockReturnValueOnce(Effect.fail(new Error("NoSuchUpload")));
		expect((await complete()).status).toBe(200);
		expect(video.source.outputKey).toBe(outputKey);
	});
	it("rejects storage changes after upload without overwriting the old media", async () => {
		mocks.complete.mockImplementationOnce((key: string) =>
			Effect.sync(() => {
				objects.set(key, { ETag: "new-video", ContentLength: 100 });
				video.bucketId = Option.some(
					S3Bucket.S3BucketId.make("different-storage"),
				);
				return { ETag: "new-video" };
			}),
		);
		expect((await complete()).status).toBe(500);
		expect(video.source.outputKey).toBe(oldKey);
		expect(objects.get(oldKey)?.ETag).toBe("original");
		expect(updates).toEqual([]);
	});
	it("completes repeated publication requests without recompleting or retiring again", async () => {
		expect((await complete()).status).toBe(200);
		expect((await complete()).status).toBe(200);
		expect(mocks.complete).toHaveBeenCalledTimes(1);
		expect(mocks.prepareReplacement).toHaveBeenCalledTimes(1);
	});
	it("rejects competing replacements after another operation publishes", async () => {
		const competing = createDesktopReuploadToken(video, {
			uploadId: "competing",
			provider,
			outputKey: createDesktopReuploadKey(video),
		});
		expect((await complete()).status).toBe(200);
		expect((await complete(true, competing)).status).toBe(500);
		expect(video.source.outputKey).toBe(outputKey);
		expect(mocks.complete).toHaveBeenCalledTimes(1);
	});
	it("preserves newer upload bookkeeping when an older replacement completes", async () => {
		uploadKey = "newer-operation";
		expect((await complete()).status).toBe(500);
		expect(video.source.outputKey).toBe(oldKey);
		expect(uploadKey).toBe("newer-operation");
	});
	it("does not delete published Drive mappings on a late abort", async () => {
		provider = "googleDrive";
		mintToken();
		expect((await complete()).status).toBe(200);
		expect((await abort()).status).toBe(200);
		expect(mocks.abort).not.toHaveBeenCalled();
		expect(video.source.outputKey).toBe(outputKey);
	});
	it("preserves Drive mappings when abort races with publication", async () => {
		provider = "googleDrive";
		mintToken();
		expect((await abort()).status).toBe(200);
		expect(mocks.abort).not.toHaveBeenCalled();
	});
	it.each(["s3", "googleDrive"] as const)(
		"cancels %s replacement after storage completion and database failure",
		async (storageProvider) => {
			provider = storageProvider;
			mintToken();
			rejectCommit = true;
			expect((await complete()).status).toBe(500);
			mocks.abort.mockReturnValue(Effect.fail(new Error("NoSuchUpload")));
			expect((await abort()).status).toBe(200);
			expect(uploadKey).toBeNull();
			rejectCommit = false;
			mocks.complete.mockReturnValue(Effect.fail(new Error("NoSuchUpload")));
			expect((await complete()).status).toBe(500);
			expect(video.source.outputKey).toBe(oldKey);
			expect(objects.get(oldKey)?.ETag).toBe("original");
		},
	);
	it.each(["s3", "googleDrive"] as const)(
		"rejects over-limit %s replacement without changing original playback",
		async (storageProvider) => {
			provider = storageProvider;
			mintToken();
			expect(
				(
					await complete(
						true,
						token,
						Video.FREE_PLAN_MAX_RECORDING_SECONDS + 100,
					)
				).status,
			).toBe(403);
			expect(uploadKey).toBeNull();
			expect(video.source.outputKey).toBe(oldKey);
			expect(objects.get(oldKey)?.ETag).toBe("original");
			if (provider === "googleDrive")
				expect(mocks.abort).not.toHaveBeenCalled();
			else
				expect(mocks.abort).toHaveBeenCalledWith(outputKey, "backend-upload");
		},
	);
	it("preserves a newer upload when rejecting an older over-limit replacement", async () => {
		uploadKey = "newer-operation";
		expect(
			(await complete(true, token, Video.FREE_PLAN_MAX_RECORDING_SECONDS + 100))
				.status,
		).toBe(403);
		expect(uploadKey).toBe("newer-operation");
	});
	it("restarts a legacy session without completing its canonical object", async () => {
		const initiate = (replaceExisting: boolean) =>
			app.request("/initiate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					videoId: "video",
					contentType: "video/mp4",
					replaceExisting,
				}),
			});
		const legacy = await initiate(false);
		expect(legacy.status).toBe(200);
		const { uploadId: legacyId } = await legacy.json();
		const rejected = await complete(true, legacyId);
		expect(rejected.status).toBe(409);
		expect(await rejected.json()).toMatchObject({
			code: "REPLACEMENT_RESTART_REQUIRED",
		});
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(video.source.outputKey).toBe(oldKey);
		const retry = await initiate(true);
		expect(retry.status).toBe(200);
		const { uploadId: replacementId } = await retry.json();
		const replacement = decodeDesktopReuploadToken(replacementId);
		expect(replacement).not.toBeNull();
		expect((await complete(true, replacementId)).status).toBe(200);
		expect(video.source.outputKey).toBe(replacement?.outputKey);
		expect(objects.get(oldKey)?.ETag).toBe("original");
		expect(mocks.complete).toHaveBeenCalledTimes(1);
	});
	it("signs only the authenticated replacement key and backend session", async () => {
		const response = await app.request("/presign-part", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				videoId: "video",
				uploadId: token,
				partNumber: 1,
			}),
		});
		expect(response.status).toBe(200);
		expect(mocks.sign).toHaveBeenCalledWith(
			outputKey,
			"backend-upload",
			1,
			expect.anything(),
		);
	});
	it("rejects tampered replacement sessions without presigning storage", async () => {
		const tampered = `${token.slice(0, -3)}bad`;
		const response = await app.request("/presign-part", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				videoId: "video",
				uploadId: tampered,
				partNumber: 1,
			}),
		});
		expect(response.status).toBe(500);
		expect(mocks.sign).not.toHaveBeenCalled();
	});
});
