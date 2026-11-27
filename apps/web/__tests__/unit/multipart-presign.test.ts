import { S3Bucket, User, Video } from "@cap/web-domain";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { Effect, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
	copy: vi.fn(),
	studio: vi.fn((_email: unknown) => false),
	startProcessing: vi.fn(async () => "started"),
	sourcesComplete: vi.fn(async (_input: unknown) => {}),
}));
vi.mock("@/lib/render-recording", () => ({
	onStudioSourcesComplete: (input: unknown) => mocks.sourcesComplete(input),
}));
vi.mock("@/lib/web-studio-rollout", () => ({
	isWebStudioEnabledForEmail: (email: unknown) => mocks.studio(email),
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
	startVideoProcessingWorkflow: mocks.startProcessing,
}));

import { app } from "@/app/api/upload/[...route]/multipart";
import {
	assertDesktopReuploadTarget,
	createDesktopReuploadKey,
	createDesktopReuploadToken,
	type DesktopReuploadToken,
	decodeDesktopReuploadToken,
	SupersededBrowserSaveError,
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

describe("multipart initiation source types", () => {
	it.each(["raw-upload.m3u8", "result.mpd", "source/original.xml"])(
		"refuses a %s source upload before touching storage",
		async (subpath) => {
			vi.clearAllMocks();
			const response = await app.request("/initiate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					videoId: "video",
					subpath,
					contentType: "application/x-mpegURL",
				}),
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				error: "This file type cannot be uploaded",
			});
			expect(mocks.getOwnedById).not.toHaveBeenCalled();
			expect(mocks.storage).not.toHaveBeenCalled();
		},
	);

	it.each(["../../other/result.mp4", "segments/./result.mp4"])(
		"refuses the path %s before touching storage",
		async (subpath) => {
			vi.clearAllMocks();
			const response = await app.request("/initiate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					videoId: "video",
					subpath,
					contentType: "video/mp4",
				}),
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({ error: "Invalid file path" });
			expect(mocks.getOwnedById).not.toHaveBeenCalled();
			expect(mocks.storage).not.toHaveBeenCalled();
		},
	);
});

describe("recorder source upload", () => {
	const cameraKey = "owner/video/camera-upload.webm";
	const displayKey = "owner/video/raw-upload.webm";
	const dialect = new MySqlDialect();
	let updates: Record<string, unknown>[];
	let uploadMutations: string[];
	afterEach(() => {
		mocks.studio.mockReturnValue(false);
	});
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.studio.mockReturnValue(true);
		updates = [];
		uploadMutations = [];
		mocks.getOwnedById.mockReturnValue(
			Effect.succeed(
				Option.some([
					{
						id: Video.VideoId.make("video"),
						ownerId: User.UserId.make("owner"),
						orgId: "org",
						source: { type: "webMP4" },
						metadata: Option.none(),
						bucketId: Option.none(),
						storageIntegrationId: Option.none(),
					},
				]),
			),
		);
		mocks.database.mockReturnValue({
			insert: () => ({
				values: () => ({
					onDuplicateKeyUpdate: async () => {
						uploadMutations.push("insert");
					},
				}),
			}),
			update: () => ({
				set: (values: Record<string, unknown>) => ({
					where: async () => {
						updates.push(values);
					},
				}),
			}),
			delete: () => ({
				where: async () => {
					uploadMutations.push("delete");
				},
			}),
		});
		mocks.create.mockReturnValue(
			Effect.succeed({ UploadId: "camera-session" }),
		);
		mocks.complete.mockReturnValue(
			Effect.succeed({ ETag: "camera-etag", Location: cameraKey }),
		);
		mocks.head.mockReturnValue(
			Effect.succeed({ ETag: "camera-etag", ContentLength: 100 }),
		);
		mocks.abort.mockReturnValue(Effect.succeed({}));
		mocks.storage.mockReturnValue(
			Effect.succeed([
				{
					provider: "s3",
					bucketName: "bucket",
					multipart: {
						create: mocks.create,
						complete: mocks.complete,
						abort: mocks.abort,
					},
					headObject: mocks.head,
				},
			]),
		);
	});
	const completeCamera = (body: Record<string, unknown> = {}) =>
		app.request("/complete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				videoId: "video",
				uploadId: "camera-session",
				subpath: "camera-upload.webm",
				screenSubpath: "raw-upload.webm",
				cameraOffsetMs: 8,
				durationInSecs: 5,
				parts: [{ partNumber: 1, etag: "part-etag", size: 100 }],
				...body,
			}),
		});
	const sourcePatch = () => {
		const metadata = updates[0]?.metadata;
		if (!metadata) throw new Error("Missing editor source metadata update");
		const params = dialect.sqlToQuery(metadata as SQL).params;
		const json = params.find(
			(value): value is string =>
				typeof value === "string" &&
				value.includes(JSON.stringify("editorSources")),
		);
		if (!json) throw new Error("Missing editor source JSON patch");
		return JSON.parse(json) as Record<string, unknown>;
	};

	it("retains a verified screen source when no webcam was recorded", async () => {
		mocks.complete.mockReturnValue(
			Effect.succeed({ ETag: "display-etag", Location: displayKey }),
		);
		mocks.head.mockReturnValue(
			Effect.succeed({ ETag: "display-etag", ContentLength: 100 }),
		);
		mocks.startProcessing.mockResolvedValue("started");
		const response = await app.request("/complete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				videoId: "video",
				uploadId: "display-session",
				subpath: "raw-upload.webm",
				durationInSecs: 5,
				parts: [{ partNumber: 1, etag: "part-etag", size: 100 }],
			}),
		});
		expect(response.status).toBe(200);
		expect(sourcePatch()).toEqual({
			editorSources: {
				version: 1,
				display: {
					key: displayKey,
					contentType: "video/webm",
					size: 100,
					objectIdentity: "display-etag",
				},
			},
		});
		expect(mocks.startProcessing).toHaveBeenCalledWith(
			expect.objectContaining({ rawFileKey: displayKey }),
		);
		expect(mocks.sourcesComplete).toHaveBeenCalledWith({
			videoId: "video",
			key: displayKey,
			origin: "http://localhost",
		});
	});

	it("completes the private camera asset without publishing or clearing the screen upload", async () => {
		const initiated = await app.request("/initiate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				videoId: "video",
				subpath: "camera-upload.webm",
				contentType: "video/webm",
			}),
		});
		expect(initiated.status).toBe(200);
		expect(uploadMutations).toEqual([]);
		const response = await completeCamera();
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			fileKey: cameraKey,
			processingStarted: false,
		});
		expect(mocks.complete).toHaveBeenCalledWith(
			cameraKey,
			"camera-session",
			expect.anything(),
		);
		expect(updates).toHaveLength(1);
		expect(sourcePatch()).toEqual({
			editorSources: {
				version: 1,
				display: { key: displayKey, contentType: "video/webm" },
				camera: {
					key: cameraKey,
					contentType: "video/webm",
					size: 100,
					objectIdentity: "camera-etag",
					offsetMs: 8,
				},
			},
		});
		expect(uploadMutations).toEqual([]);
		expect(mocks.startProcessing).not.toHaveBeenCalled();
		expect(mocks.sourcesComplete).toHaveBeenCalledOnce();
		expect(mocks.sourcesComplete).toHaveBeenCalledWith({
			videoId: "video",
			key: cameraKey,
			origin: "http://localhost",
		});
	});

	it("rejects an invalid display path before completing camera bytes", async () => {
		const response = await completeCamera({
			screenSubpath: "../result.mp4",
		});
		expect(response.status).toBe(400);
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(updates).toEqual([]);
	});

	it("recovers a lost completion response from the verified camera object", async () => {
		mocks.complete.mockReturnValueOnce(Effect.fail(new Error("NoSuchUpload")));
		const response = await completeCamera();
		expect(response.status).toBe(200);
		expect(updates).toHaveLength(1);
		expect(uploadMutations).toEqual([]);
	});

	it("requires verified display bytes before starting the composited output", async () => {
		mocks.getOwnedById.mockReturnValue(
			Effect.succeed(
				Option.some([
					{
						id: Video.VideoId.make("video"),
						ownerId: User.UserId.make("owner"),
						orgId: "org",
						source: { type: "webMP4" },
						metadata: Option.some({
							editorSources: {
								version: 1,
								display: { key: displayKey, contentType: "video/webm" },
								camera: {
									key: cameraKey,
									contentType: "video/webm",
									size: 100,
									objectIdentity: "camera-etag",
									offsetMs: 8,
								},
							},
						}),
						bucketId: Option.none(),
						storageIntegrationId: Option.none(),
					},
				]),
			),
		);
		mocks.startProcessing.mockResolvedValue("started");
		mocks.head.mockReturnValue(
			Effect.succeed({ ETag: "display-etag", ContentLength: 99 }),
		);
		const response = await app.request("/complete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				videoId: "video",
				uploadId: "display-session",
				subpath: "raw-upload.webm",
				durationInSecs: 5,
				parts: [{ partNumber: 1, etag: "part-etag", size: 100 }],
			}),
		});
		expect(response.status).toBe(500);
		expect(mocks.startProcessing).not.toHaveBeenCalled();
	});

	it("refuses Studio tracks from an account outside the pilot", async () => {
		mocks.studio.mockReturnValue(false);
		const initiated = await app.request("/initiate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				videoId: "video",
				subpath: "mic-upload.webm",
				contentType: "audio/webm",
			}),
		});
		expect(initiated.status).toBe(403);
		const completed = await completeCamera();
		expect(completed.status).toBe(403);
		expect(mocks.create).not.toHaveBeenCalled();
		expect(mocks.complete).not.toHaveBeenCalled();
		expect(updates).toEqual([]);
	});

	it("leaves an Instant recording's metadata alone outside the pilot", async () => {
		mocks.studio.mockReturnValue(false);
		mocks.complete.mockReturnValue(
			Effect.succeed({ ETag: "display-etag", Location: displayKey }),
		);
		mocks.head.mockReturnValue(
			Effect.succeed({ ETag: "display-etag", ContentLength: 100 }),
		);
		const response = await app.request("/complete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				videoId: "video",
				uploadId: "display-session",
				subpath: "raw-upload.webm",
				durationInSecs: 5,
				parts: [{ partNumber: 1, etag: "part-etag", size: 100 }],
			}),
		});
		expect(response.status).toBe(200);
		expect(updates).toHaveLength(1);
		expect(updates[0]).not.toHaveProperty("metadata");
		expect(mocks.startProcessing).toHaveBeenCalledWith(
			expect.objectContaining({ rawFileKey: displayKey }),
		);
		expect(mocks.sourcesComplete).not.toHaveBeenCalled();
	});

	it("stores the recorder camera layout with the camera track", async () => {
		const layout = {
			version: 1,
			position: { x: "left", y: "top" },
			size: 30,
			mirror: true,
			shape: "round",
		};
		const response = await completeCamera({ recorderCamera: layout });
		expect(response.status).toBe(200);
		expect(sourcePatch()).toMatchObject({ recorderCamera: layout });
	});

	it("rejects a camera layout outside what the editor accepts", async () => {
		const response = await completeCamera({
			recorderCamera: {
				version: 1,
				position: { x: "left", y: "top" },
				size: 400,
				mirror: true,
				shape: "round",
			},
		});
		expect(response.status).toBe(400);
		expect(mocks.complete).not.toHaveBeenCalled();
	});

	it("records a microphone track with its own offset", async () => {
		const response = await app.request("/complete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				videoId: "video",
				uploadId: "mic-session",
				subpath: "mic-upload.webm",
				screenSubpath: "raw-upload.webm",
				audioOffsetMs: -4,
				durationInSecs: 5,
				parts: [{ partNumber: 1, etag: "part-etag", size: 100 }],
			}),
		});
		expect(response.status).toBe(200);
		expect(sourcePatch()).toEqual({
			editorSources: {
				version: 1,
				display: { key: displayKey, contentType: "video/webm" },
				mic: {
					key: "owner/video/mic-upload.webm",
					contentType: "audio/webm",
					size: 100,
					objectIdentity: "camera-etag",
					offsetMs: -4,
				},
			},
		});
	});

	it("aborts a microphone track without touching the screen upload row", async () => {
		const response = await app.request("/abort", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				videoId: "video",
				subpath: "mic-upload.webm",
				uploadId: "mic-session",
			}),
		});
		expect(response.status).toBe(200);
		expect(mocks.abort).toHaveBeenCalledWith(
			"owner/video/mic-upload.webm",
			"mic-session",
		);
		expect(uploadMutations).toEqual([]);
	});

	it("aborts only the camera multipart session", async () => {
		const response = await app.request("/abort", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				videoId: "video",
				subpath: "camera-upload.webm",
				uploadId: "camera-session",
			}),
		});
		expect(response.status).toBe(200);
		expect(mocks.abort).toHaveBeenCalledWith(cameraKey, "camera-session");
		expect(uploadMutations).toEqual([]);
	});

	it("keeps an uncertain Drive camera mapping for retry", async () => {
		mocks.storage.mockReturnValue(
			Effect.succeed([
				{
					provider: "googleDrive",
					bucketName: "drive",
					multipart: { abort: mocks.abort },
				},
			]),
		);
		const response = await app.request("/abort", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				videoId: "video",
				subpath: "camera-upload.webm",
				uploadId: "camera-session",
			}),
		});
		expect(response.status).toBe(200);
		expect(mocks.abort).not.toHaveBeenCalled();
		expect(uploadMutations).toEqual([]);
	});
});

describe("desktop reupload completion", () => {
	const oldKey = "owner/video/.recording/outputs/original/result.mp4";
	let events: string[];
	let updates: Record<string, unknown>[];
	let objects: Map<
		string,
		{ ETag: string; ContentLength: number; ContentType?: string }
	>;
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
					copyObject: (...args: unknown[]) => mocks.copy(...args),
				},
			]),
		);
		mocks.copy.mockReturnValue(
			Effect.succeed({ CopyObjectResult: { ETag: "new-video" } }),
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
	it("binds a browser Save to its upload and refuses one a newer Save replaced", async () => {
		const saveA = "00000000-0000-4000-8000-00000000000a";
		const saveB = "00000000-0000-4000-8000-00000000000b";
		const initiate = () =>
			app.request("/initiate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					videoId: "video",
					contentType: "video/mp4",
					replaceExisting: true,
					browserSaveId: saveA,
				}),
			});
		const withSave = (saveId: string, status: string) =>
			Effect.sync(() =>
				Option.some([
					{
						...video,
						source: { ...video.source },
						metadata: Option.some({
							webEditorBrowserSave: { saveId, status },
						}),
					},
				]),
			);
		mocks.getOwnedById.mockImplementationOnce(() =>
			withSave(saveA, "rendering"),
		);
		const current = await initiate();
		expect(current.status).toBe(200);
		expect(
			decodeDesktopReuploadToken((await current.json()).uploadId)
				?.browserSaveId,
		).toBe(saveA);
		mocks.create.mockClear();
		for (const [saveId, status] of [
			[saveB, "rendering"],
			[saveB, "published"],
			[saveA, "error"],
		] as const) {
			mocks.getOwnedById.mockImplementationOnce(() => withSave(saveId, status));
			const superseded = await initiate();
			expect(superseded.status).toBe(409);
			expect(await superseded.json()).toMatchObject({
				code: "SAVE_SUPERSEDED",
			});
		}
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it("reports a Save superseded while it uploaded as a conflict, not a failure", async () => {
		mocks.prepareReplacement.mockRejectedValueOnce(
			new SupersededBrowserSaveError(),
		);
		const response = await complete();
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({ code: "SAVE_SUPERSEDED" });
		expect(video.source.outputKey).toBe(oldKey);
		expect(events).not.toContain("publish");
	});
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
	it.each([
		["raw-upload.html", "text/html", "application/octet-stream"],
		["raw-upload.mp4", "text/html; charset=utf-8", "application/octet-stream"],
		["raw-upload.svg", "image/svg+xml", "application/octet-stream"],
		["raw-upload.xhtml", "application/xhtml+xml", "application/octet-stream"],
		[
			"raw-upload.webm",
			"video/webm;codecs=vp9,opus",
			"video/webm;codecs=vp9,opus",
		],
		["raw-upload.m4a", "audio/mp4", "audio/mp4"],
		["screenshot/screen-capture.png", "image/png", "image/png"],
	])(
		"stores a %s upload sent as %s with content type %s",
		async (subpath, contentType, stored) => {
			const response = await app.request("/initiate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ videoId: "video", subpath, contentType }),
			});
			expect(response.status).toBe(200);
			expect(mocks.create).toHaveBeenCalledWith(
				`owner/video/${subpath}`,
				expect.objectContaining({ ContentType: stored }),
			);
		},
	);

	it.each([
		["page.html", "application/octet-stream", "application/octet-stream"],
		["result.mp4", "application/octet-stream", "video/mp4"],
		["result.mp4", "video/mp4", "video/mp4"],
	])(
		"completes a %s upload stored as %s with content type %s",
		async (subpath, storedType, completedType) => {
			mocks.complete.mockImplementation((key: string) =>
				Effect.sync(() => {
					objects.set(key, {
						ETag: "upload",
						ContentLength: 100,
						ContentType: storedType,
					});
					return { ETag: "upload" };
				}),
			);
			const response = await app.request("/complete", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					videoId: "video",
					uploadId: "backend-upload",
					subpath,
					parts: [{ partNumber: 1, etag: "part", size: 100 }],
				}),
			});
			expect(response.status).toBe(200);
			expect(mocks.copy).toHaveBeenCalledWith(
				expect.any(String),
				`owner/video/${subpath}`,
				expect.objectContaining({ ContentType: completedType }),
			);
		},
	);

	it("stores a replacement upload sent as a web page as plain bytes", async () => {
		const response = await app.request("/initiate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				videoId: "video",
				contentType: "text/html",
				replaceExisting: true,
			}),
		});
		expect(response.status).toBe(200);
		expect(mocks.create).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ ContentType: "application/octet-stream" }),
		);
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

describe("raw recording completion integrity", () => {
	const firstPart = {
		partNumber: 1,
		etag: "7fc56270e7a70fa81a5935b72eacbe29",
		size: 1,
	};
	const secondPart = {
		partNumber: 2,
		etag: "9d5ed678fe57bcca610140957afab571",
		size: 1,
	};
	const parts = [firstPart, secondPart];
	const etag = '"938e9f75e9874032440e416d025877f8-2"';
	const complete = (submittedParts = parts) =>
		app.request("/complete", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				videoId: "video",
				uploadId: "same-upload",
				subpath: "raw-upload.webm",
				durationInSecs: 1,
				parts: submittedParts,
			}),
		});

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getOwnedById.mockReturnValue(
			Effect.succeed(
				Option.some([
					{
						id: Video.VideoId.make("video"),
						ownerId: User.UserId.make("owner"),
						source: { type: "webMP4" },
						bucketId: Option.none(),
						storageIntegrationId: Option.none(),
					},
				]),
			),
		);
		mocks.database.mockReturnValue({
			update: () => ({ set: () => ({ where: async () => {} }) }),
		});
		mocks.complete.mockReturnValue(Effect.succeed({ ETag: etag }));
		mocks.head.mockReturnValue(
			Effect.succeed({ ETag: etag, ContentLength: 2 }),
		);
		mocks.storage.mockReturnValue(
			Effect.succeed([
				{
					provider: "s3",
					multipart: { complete: mocks.complete },
					headObject: mocks.head,
				},
			]),
		);
	});

	it("acknowledges only the assembled recording with matching size", async () => {
		const response = await complete();
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			processingStarted: true,
		});
		expect(mocks.head).toHaveBeenCalledWith("owner/video/raw-upload.webm");
	});

	it("reconciles a lost completion response using all part identities and object size", async () => {
		mocks.complete.mockReturnValue(Effect.fail(new Error("NoSuchUpload")));
		const response = await complete([...parts].reverse());
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			success: true,
			objectIdentity: etag,
		});
		expect(mocks.abort).not.toHaveBeenCalled();
	});

	it.each([
		{ ETag: '"different"', ContentLength: 2 },
		{ ETag: etag, ContentLength: 1 },
		{ ETag: "provider-specific", ContentLength: 2 },
	])(
		"does not accept a different or unverifiable object after completion fails",
		async (head) => {
			mocks.complete.mockReturnValue(Effect.fail(new Error("NoSuchUpload")));
			mocks.head.mockReturnValue(Effect.succeed(head));
			const response = await complete();
			expect(response.status).toBe(500);
			const { startVideoProcessingWorkflow } = await import(
				"@/lib/video-processing"
			);
			expect(startVideoProcessingWorkflow).not.toHaveBeenCalled();
		},
	);

	it("does not acknowledge success if provider verification finds missing bytes", async () => {
		mocks.head.mockReturnValue(
			Effect.succeed({ ETag: etag, ContentLength: 1 }),
		);
		expect((await complete()).status).toBe(500);
		const { startVideoProcessingWorkflow } = await import(
			"@/lib/video-processing"
		);
		expect(startVideoProcessingWorkflow).not.toHaveBeenCalled();
	});

	it.each([
		{ invalid: [] },
		{ invalid: [secondPart] },
		{ invalid: [firstPart, firstPart] },
		{ invalid: [{ ...firstPart, size: 0 }] },
		{ invalid: [{ ...firstPart, size: 1.5 }] },
	])(
		"rejects incomplete or invalid part lists before completing storage",
		async ({ invalid }) => {
			expect((await complete(invalid)).status).toBe(400);
			expect(mocks.complete).not.toHaveBeenCalled();
		},
	);
});
