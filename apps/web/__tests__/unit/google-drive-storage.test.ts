import { Organisation, Storage, User, Video } from "@cap/web-domain";
import { Effect, Layer, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		GOOGLE_CLIENT_ID: "client-id",
		GOOGLE_CLIENT_SECRET: "client-secret",
		WEB_URL: "https://cap.test",
	}),
}));

import { S3Buckets } from "../../../../packages/web-backend/src/S3Buckets";
import { Storage as StorageService } from "../../../../packages/web-backend/src/Storage";
import {
	copyGoogleDriveFile,
	createGoogleDriveResumableUpload,
	GOOGLE_DRIVE_FOLDER_MIME_TYPE,
	type GoogleDriveTokenStore,
	syncGoogleDriveVideoNames,
} from "../../../../packages/web-backend/src/Storage/GoogleDrive";
import { getGoogleDriveVideoNames } from "../../../../packages/web-backend/src/Storage/google-drive-names";
import {
	type GoogleDriveIntegrationConfig,
	type StorageObjectInput,
	type StorageObjectUpdate,
	StorageRepo,
} from "../../../../packages/web-backend/src/Storage/StorageRepo";

const integrationId = Storage.StorageIntegrationId.make("integration-1");
const otherIntegrationId = Storage.StorageIntegrationId.make("integration-2");
const integrationOwnerId = User.UserId.make("integration-owner");
const videoOwnerId = User.UserId.make("video-owner");
const videoId = Video.VideoId.make("video-1");
const resultKey = `${videoOwnerId}/${videoId}/result.mp4`;

type StoredObject = {
	id: Storage.StorageObjectId;
	integrationId: Storage.StorageIntegrationId;
	ownerId: User.UserId;
	videoId: Video.VideoId | null;
	objectKey: string;
	objectKeyHash: string;
	providerObjectId: string;
	uploadSessionUrl: string | null;
	uploadStatus: "pending" | "complete" | "error";
	contentType: string | null;
	contentLength: number | null;
	metadata: Storage.StorageObjectMetadata | null;
	createdAt: Date;
	updatedAt: Date;
};

type VideoForNameSync = {
	id: Video.VideoId;
	name: string;
	ownerId: User.UserId;
	storageIntegrationId: Storage.StorageIntegrationId | null;
};

type RepoHarness = {
	repo: StorageRepo;
	objects: Map<string, StoredObject>;
	reservations: StorageObjectInput[];
	upserts: StorageObjectInput[];
	updates: Array<{ object: StoredObject; input: StorageObjectUpdate }>;
	fileNameUpdates: Array<{ object: StoredObject; fileName: string }>;
	putObject: (input: StorageObjectInput) => StoredObject;
	setVideo: (video: VideoForNameSync) => void;
	setFileNameUpdateResult: (
		result: (object: StoredObject, fileName: string) => boolean,
	) => void;
};

const objectMapKey = (
	storageIntegrationId: Storage.StorageIntegrationId,
	key: string,
) => `${storageIntegrationId}:${key}`;

const snapshotObject = (object: StoredObject): StoredObject => ({
	...object,
	metadata: object.metadata ? { ...object.metadata } : null,
	createdAt: new Date(object.createdAt),
	updatedAt: new Date(object.updatedAt),
});

const makeRepoHarness = (videos: VideoForNameSync[] = []): RepoHarness => {
	const objects = new Map<string, StoredObject>();
	const reservations: StorageObjectInput[] = [];
	const upserts: StorageObjectInput[] = [];
	const updates: Array<{ object: StoredObject; input: StorageObjectUpdate }> =
		[];
	const fileNameUpdates: Array<{ object: StoredObject; fileName: string }> = [];
	const videoMap = new Map(videos.map((video) => [video.id, video]));
	let objectSequence = 0;
	let fileNameUpdateResult: (
		object: StoredObject,
		fileName: string,
	) => boolean = () => true;

	const putObject = (input: StorageObjectInput) => {
		const key = objectMapKey(input.integrationId, input.objectKey);
		const existing = objects.get(key);
		const next: StoredObject = {
			id:
				existing?.id ??
				Storage.StorageObjectId.make(`storage-object-${++objectSequence}`),
			integrationId: input.integrationId,
			ownerId: existing?.ownerId ?? input.ownerId,
			videoId: existing?.videoId ?? input.videoId,
			objectKey: input.objectKey,
			objectKeyHash: existing?.objectKeyHash ?? `hash:${input.objectKey}`,
			providerObjectId: input.providerObjectId,
			uploadSessionUrl: input.uploadSessionUrl ?? null,
			uploadStatus: input.uploadStatus ?? "pending",
			contentType: input.contentType ?? null,
			contentLength: input.contentLength ?? null,
			metadata:
				existing && input.preserveMetadata
					? existing.metadata
					: (input.metadata ?? null),
			createdAt: existing?.createdAt ?? new Date("2026-01-01T00:00:00.000Z"),
			updatedAt: new Date("2026-01-01T00:00:00.000Z"),
		};
		objects.set(key, next);
		return next;
	};

	const repo = {
		getIntegrationById: (id: Storage.StorageIntegrationId) =>
			Effect.succeed(
				id === integrationId
					? Option.some({ id, ownerId: integrationOwnerId })
					: Option.none(),
			),
		getGoogleDriveConfig: () => Effect.succeed(makeConfig()),
		getGoogleDriveAccessTokenCache: () =>
			Effect.succeed(
				Option.some({
					accessToken: "access-token",
					expiresAt: new Date("2100-01-01T00:00:00.000Z"),
				}),
			),
		getGoogleDriveAccessTokenCacheById: () =>
			Effect.succeed(
				Option.some({
					accessToken: "access-token",
					expiresAt: new Date("2100-01-01T00:00:00.000Z"),
				}),
			),
		claimGoogleDriveTokenRefreshLease: () => Effect.succeed(true),
		saveGoogleDriveAccessTokenCache: () => Effect.succeed(true),
		releaseGoogleDriveTokenRefreshLease: () => Effect.void,
		getObjectByKey: (
			storageIntegrationId: Storage.StorageIntegrationId,
			key: string,
		) =>
			Effect.succeed(
				Option.fromNullable(
					objects.get(objectMapKey(storageIntegrationId, key)),
				).pipe(Option.map(snapshotObject)),
			),
		getVideoForNameSync: (id: Video.VideoId) =>
			Effect.succeed(Option.fromNullable(videoMap.get(id))),
		reserveObject: (input: StorageObjectInput) =>
			Effect.sync(() => {
				reservations.push(input);
				const key = objectMapKey(input.integrationId, input.objectKey);
				return snapshotObject(objects.get(key) ?? putObject(input));
			}),
		upsertObject: (input: StorageObjectInput) =>
			Effect.sync(() => {
				upserts.push(input);
				putObject(input);
			}),
		updateObjectIfCurrent: (object: StoredObject, input: StorageObjectUpdate) =>
			Effect.sync(() => {
				updates.push({ object, input });
				const current = objects.get(
					objectMapKey(object.integrationId, object.objectKey),
				);
				if (
					!current ||
					current.id !== object.id ||
					current.integrationId !== object.integrationId ||
					current.objectKey !== object.objectKey ||
					current.objectKeyHash !== object.objectKeyHash ||
					current.providerObjectId !== object.providerObjectId ||
					current.uploadStatus !== object.uploadStatus
				)
					return false;
				const metadata = input.preserveMetadata
					? current.metadata
					: (input.metadata ?? null);
				putObject({
					...input,
					integrationId: current.integrationId,
					ownerId: current.ownerId,
					videoId: current.videoId,
					objectKey: current.objectKey,
					metadata,
				});
				return true;
			}),
		markObjectComplete: (
			storageIntegrationId: Storage.StorageIntegrationId,
			key: string,
			contentLength?: number | null,
		) =>
			Effect.sync(() => {
				const object = objects.get(objectMapKey(storageIntegrationId, key));
				if (!object) return;
				object.uploadStatus = "complete";
				if (contentLength !== undefined) object.contentLength = contentLength;
			}),
		deleteObjectByKey: (
			storageIntegrationId: Storage.StorageIntegrationId,
			key: string,
		) =>
			Effect.sync(() => {
				objects.delete(objectMapKey(storageIntegrationId, key));
			}),
		updateObjectFileName: (object: StoredObject, fileName: string) =>
			Effect.sync(() => {
				fileNameUpdates.push({ object, fileName });
				const current = objects.get(
					objectMapKey(object.integrationId, object.objectKey),
				);
				if (current) {
					current.metadata = { ...(current.metadata ?? {}), fileName };
				}
				return fileNameUpdateResult(object, fileName);
			}),
	} as unknown as StorageRepo;

	return {
		repo,
		objects,
		reservations,
		upserts,
		updates,
		fileNameUpdates,
		putObject,
		setVideo: (video) => {
			videoMap.set(video.id, video);
		},
		setFileNameUpdateResult: (result) => {
			fileNameUpdateResult = result;
		},
	};
};

let tokenSequence = 0;

const makeTokenStore = (): GoogleDriveTokenStore => {
	const token = {
		accessToken: "access-token",
		expiresAt: new Date("2100-01-01T00:00:00.000Z"),
	};
	return {
		cacheKey: `google-drive-test-${++tokenSequence}`,
		getInitialAccessTokenCache: () => Effect.succeed(Option.some(token)),
		getAccessTokenCache: () => Effect.succeed(Option.some(token)),
		claimRefreshLease: () => Effect.succeed(true),
		saveAccessTokenCache: () => Effect.succeed(true),
		releaseRefreshLease: () => Effect.void,
	};
};

const makeConfig = (
	folderLayout: GoogleDriveIntegrationConfig["folderLayout"] = "video",
): GoogleDriveIntegrationConfig => ({
	refreshToken: "refresh-token",
	folderId: "root-folder",
	folderLayout,
});

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
		...init,
	});

const response = (status: number, headers?: HeadersInit) =>
	new Response(status === 204 ? null : "", { status, headers });

const requestBody = (init?: RequestInit) =>
	typeof init?.body === "string" && init.body.startsWith("{")
		? (JSON.parse(init.body) as Record<string, unknown>)
		: null;

const storedObjectInput = (
	key: string,
	providerObjectId: string,
	options: {
		status?: StoredObject["uploadStatus"];
		contentType?: string;
		contentLength?: number | null;
		fileName?: string;
		ownerId?: User.UserId;
		uploadSessionUrl?: string | null;
	} = {},
): StorageObjectInput => ({
	integrationId,
	ownerId: options.ownerId ?? integrationOwnerId,
	videoId,
	objectKey: key,
	providerObjectId,
	uploadSessionUrl: options.uploadSessionUrl,
	uploadStatus: options.status ?? "complete",
	contentType: options.contentType ?? "video/mp4",
	contentLength: options.contentLength,
	metadata: {
		videoId,
		fileName: options.fileName ?? key.split("/").at(-1),
		contentType: options.contentType ?? "video/mp4",
	},
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("Google Drive video names", () => {
	it("preserves exact valid titles and rejects blank or control-character names", () => {
		expect(getGoogleDriveVideoNames("Launch 🚀: Q3/Q4? (final)")).toEqual({
			folderName: "Launch 🚀: Q3/Q4? (final)",
			fileName: "Launch 🚀: Q3/Q4? (final).mp4",
		});
		expect(getGoogleDriveVideoNames("Already.MP4")).toEqual({
			folderName: "Already.MP4",
			fileName: "Already.MP4",
		});
		expect(getGoogleDriveVideoNames("Same title")).toEqual(
			getGoogleDriveVideoNames("Same title"),
		);
		expect(getGoogleDriveVideoNames(" \t ")).toBeNull();
		expect(getGoogleDriveVideoNames("Visible\u0085control")).toBeNull();
	});

	it.each(["video", "userVideo"] as const)(
		"creates %s-layout folders and final MP4 names from an explicit pre-insert title",
		async (folderLayout) => {
			const harness = makeRepoHarness();
			const generatedIds = [
				"result-id",
				"owner-folder-id",
				"video-folder-id",
				"warning-id",
			];
			const folderBodies: Record<string, unknown>[] = [];
			let filePostSawReservation = false;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
					const url = String(input);
					if (url.includes("/files/generateIds")) {
						return jsonResponse({ ids: [generatedIds.shift()] });
					}
					if (
						url.includes("/drive/v3/files?") &&
						!url.includes("uploadType=") &&
						init?.method === "POST"
					) {
						const body = requestBody(init);
						if (body) folderBodies.push(body);
						return jsonResponse({ id: body?.id, name: body?.name });
					}
					if (url.includes("uploadType=multipart")) {
						return jsonResponse({ id: "warning-id" });
					}
					if (url.includes("uploadType=resumable") && init?.method === "POST") {
						filePostSawReservation = harness.objects.has(
							objectMapKey(integrationId, resultKey),
						);
						return response(200, { Location: "https://upload.test/session" });
					}
					throw new Error(
						`Unexpected Drive request: ${init?.method ?? "GET"} ${url}`,
					);
				}),
			);

			await Effect.runPromise(
				createGoogleDriveResumableUpload(
					harness.repo,
					makeConfig(folderLayout),
					{
						integrationId,
						ownerId: integrationOwnerId,
						videoId,
						key: resultKey,
						contentType: "video/mp4",
						videoTitle: "Café / roadmap 🚀",
					},
					makeTokenStore(),
				),
			);

			const folderNames = folderBodies
				.filter((body) => body.mimeType === GOOGLE_DRIVE_FOLDER_MIME_TYPE)
				.map((body) => body.name);
			expect(folderNames).toContain("Café / roadmap 🚀");
			if (folderLayout === "userVideo")
				expect(folderNames).toContain(videoOwnerId);
			expect(filePostSawReservation).toBe(true);
			const filePost = (
				vi.mocked(fetch).mock.calls as Array<[string, RequestInit]>
			).find(
				([url, init]) =>
					String(url).includes("uploadType=resumable") &&
					init.method === "POST",
			);
			expect(requestBody(filePost?.[1])).toMatchObject({
				id: "result-id",
				name: "Café / roadmap 🚀.mp4",
				parents: [
					folderLayout === "userVideo" ? "video-folder-id" : "owner-folder-id",
				],
				appProperties: { capObjectKey: resultKey },
			});
			expect(harness.updates.at(-1)?.input).toMatchObject({
				providerObjectId: "result-id",
				metadata: { fileName: "Café / roadmap 🚀.mp4" },
			});
		},
	);

	it("uses a matching video owner and integration for final names but leaves auxiliary and mismatched objects alone", async () => {
		const matching = makeRepoHarness([
			{
				id: videoId,
				name: "Org member's demo",
				ownerId: videoOwnerId,
				storageIntegrationId: integrationId,
			},
		]);
		matching.putObject(
			storedObjectInput(".cap-folders/video-1", "folder-id", {
				contentType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
			}),
		);
		matching.putObject(
			storedObjectInput(
				".cap-warnings/video-1/DO_NOT_EDIT_OR_DELETE.txt",
				"warning-id",
				{ contentType: "text/plain" },
			),
		);
		const postedNames: string[] = [];
		let nextId = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/files/generateIds")) {
					nextId += 1;
					return jsonResponse({ ids: [`new-file-${nextId}`] });
				}
				if (url.includes("uploadType=resumable") && init?.method === "POST") {
					postedNames.push(String(requestBody(init)?.name));
					return response(200, { Location: `https://upload.test/${nextId}` });
				}
				throw new Error(
					`Unexpected Drive request: ${init?.method ?? "GET"} ${url}`,
				);
			}),
		);

		for (const key of [resultKey, `${videoOwnerId}/${videoId}/thumbnail.png`]) {
			await Effect.runPromise(
				createGoogleDriveResumableUpload(
					matching.repo,
					makeConfig(),
					{
						integrationId,
						ownerId: integrationOwnerId,
						videoId,
						key,
						contentType: key.endsWith(".mp4") ? "video/mp4" : "image/png",
					},
					makeTokenStore(),
				),
			);
		}

		const mismatched = makeRepoHarness([
			{
				id: videoId,
				name: "Must not leak",
				ownerId: videoOwnerId,
				storageIntegrationId: otherIntegrationId,
			},
		]);
		mismatched.putObject(
			storedObjectInput(".cap-folders/video-1", "folder-id", {
				contentType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
			}),
		);
		mismatched.putObject(
			storedObjectInput(
				".cap-warnings/video-1/DO_NOT_EDIT_OR_DELETE.txt",
				"warning-id",
				{ contentType: "text/plain" },
			),
		);
		await Effect.runPromise(
			createGoogleDriveResumableUpload(
				mismatched.repo,
				makeConfig(),
				{
					integrationId,
					ownerId: integrationOwnerId,
					videoId,
					key: resultKey,
					contentType: "video/mp4",
				},
				makeTokenStore(),
			),
		);

		expect(postedNames).toEqual([
			"Org member's demo.mp4",
			"thumbnail.png",
			"result.mp4",
		]);
	});
});

describe("Google Drive upload updates and copies", () => {
	it("overwrites only the content type while preserving the file id and metadata", async () => {
		const harness = makeRepoHarness();
		const existing = harness.putObject(
			storedObjectInput(resultKey, "existing-file-id", {
				contentLength: 4321,
				fileName: "User renamed this in Drive.mp4",
			}),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				response(200, { Location: "https://upload.test/existing" }),
			),
		);

		await Effect.runPromise(
			createGoogleDriveResumableUpload(
				harness.repo,
				makeConfig(),
				{
					integrationId,
					ownerId: integrationOwnerId,
					videoId,
					key: resultKey,
					contentType: "video/mp4",
				},
				makeTokenStore(),
			),
		);

		const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
		expect(url).toContain("/files/existing-file-id?uploadType=resumable");
		expect(init.method).toBe("PATCH");
		expect(requestBody(init)).toEqual({ mimeType: "video/mp4" });
		expect(harness.updates.at(-1)?.input).toMatchObject({
			providerObjectId: "existing-file-id",
			contentLength: null,
			preserveMetadata: true,
		});
		expect(
			harness.objects.get(objectMapKey(integrationId, resultKey))?.metadata,
		).toEqual(existing.metadata);
	});

	it.each([404, 410])(
		"recreates a missing complete file after %i with its current Cap title and stable identity",
		async (missingStatus) => {
			const harness = makeRepoHarness([
				{
					id: videoId,
					name: "Current café / launch",
					ownerId: videoOwnerId,
					storageIntegrationId: integrationId,
				},
			]);
			const existing = harness.putObject(
				storedObjectInput(resultKey, "missing-file-id", {
					fileName: "Stale managed title.mp4",
				}),
			);
			existing.metadata = {
				...existing.metadata,
				duration: "42",
				resolution: "3840x2160",
			};
			harness.putObject(
				storedObjectInput(".cap-folders/video-1", "folder-id", {
					contentType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
				}),
			);
			harness.putObject(
				storedObjectInput(
					".cap-warnings/video-1/DO_NOT_EDIT_OR_DELETE.txt",
					"warning-id",
					{ contentType: "text/plain" },
				),
			);
			vi.stubGlobal(
				"fetch",
				vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
					if (init?.method === "PATCH") return response(missingStatus);
					if (init?.method === "POST")
						return response(200, { Location: "https://upload.test/recreated" });
					throw new Error(`Unexpected Drive method: ${init?.method}`);
				}),
			);

			const uploadUrl = await Effect.runPromise(
				createGoogleDriveResumableUpload(
					harness.repo,
					makeConfig(),
					{
						integrationId,
						ownerId: integrationOwnerId,
						videoId,
						key: resultKey,
						contentType: "video/mp4",
					},
					makeTokenStore(),
				),
			);

			expect(uploadUrl).toBe("https://upload.test/recreated");
			const [, postInit] = vi.mocked(fetch).mock.calls[1] as [
				string,
				RequestInit,
			];
			expect(postInit.method).toBe("POST");
			expect(requestBody(postInit)).toEqual({
				id: "missing-file-id",
				name: "Current café / launch.mp4",
				mimeType: "video/mp4",
				parents: ["folder-id"],
				appProperties: { capObjectKey: resultKey },
			});
			expect(harness.updates.at(-1)?.input).toMatchObject({
				providerObjectId: "missing-file-id",
				preserveMetadata: false,
				metadata: {
					fileName: "Current café / launch.mp4",
					duration: "42",
					resolution: "3840x2160",
				},
			});
		},
	);

	it.each([
		[404, false],
		[410, false],
		[404, true],
		[410, true],
	] as const)(
		"reuses a reserved id after %i (replacement: %s) when POST conflicts",
		async (missingStatus, useReplacement) => {
			const harness = makeRepoHarness();
			const finalFileId = useReplacement
				? "replacement-file-id"
				: "reserved-file-id";
			const reserved = harness.putObject(
				storedObjectInput(resultKey, "reserved-file-id", {
					status: useReplacement ? "complete" : "pending",
					fileName: "Reserved display.mp4",
				}),
			);
			harness.putObject(
				storedObjectInput(".cap-folders/video-1", "folder-id", {
					contentType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
				}),
			);
			harness.putObject(
				storedObjectInput(
					".cap-warnings/video-1/DO_NOT_EDIT_OR_DELETE.txt",
					"warning-id",
					{ contentType: "text/plain" },
				),
			);
			let patchCount = 0;
			vi.stubGlobal(
				"fetch",
				vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
					if (String(input).includes("/files/generateIds"))
						return jsonResponse({ ids: [finalFileId] });
					if (init?.method === "PATCH") {
						patchCount += 1;
						return patchCount === 1
							? response(missingStatus)
							: response(200, { Location: "https://upload.test/recovered" });
					}
					if (init?.method === "POST") {
						return response(
							useReplacement && requestBody(init)?.id === "reserved-file-id"
								? 400
								: 409,
						);
					}
					throw new Error(`Unexpected Drive method: ${init?.method}`);
				}),
			);

			const uploadUrl = await Effect.runPromise(
				createGoogleDriveResumableUpload(
					harness.repo,
					makeConfig(),
					{
						integrationId,
						ownerId: integrationOwnerId,
						videoId,
						key: resultKey,
						contentType: "video/mp4",
					},
					makeTokenStore(),
				),
			);

			expect(uploadUrl).toBe("https://upload.test/recovered");
			expect(patchCount).toBe(2);
			expect(harness.updates.at(-1)?.input).toMatchObject({
				providerObjectId: finalFileId,
				preserveMetadata: true,
			});
			expect(
				harness.objects.get(objectMapKey(integrationId, resultKey))?.metadata,
			).toEqual(reserved.metadata);
		},
	);

	it("allows only one concurrent replacement CAS winner after the old file disappears", async () => {
		const harness = makeRepoHarness([
			{
				id: videoId,
				name: "Concurrent replacement",
				ownerId: videoOwnerId,
				storageIntegrationId: integrationId,
			},
		]);
		harness.putObject(storedObjectInput(resultKey, "missing-file-id"));
		harness.putObject(
			storedObjectInput(".cap-folders/video-1", "folder-id", {
				contentType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
			}),
		);
		harness.putObject(
			storedObjectInput(
				".cap-warnings/video-1/DO_NOT_EDIT_OR_DELETE.txt",
				"warning-id",
				{ contentType: "text/plain" },
			),
		);
		let releaseInitialPatch!: () => void;
		const initialPatchBarrier = new Promise<void>((resolve) => {
			releaseInitialPatch = resolve;
		});
		let patchCount = 0;
		let generatedIdCount = 0;
		let replacementPostCompleted = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (
					init?.method === "PATCH" &&
					(url.includes("missing-file-id") || url.includes("replacement-"))
				) {
					patchCount += 1;
					if (patchCount === 2) releaseInitialPatch();
					if (patchCount <= 2) await initialPatchBarrier;
					return response(404);
				}
				if (url.includes("/files/generateIds")) {
					const id =
						generatedIdCount++ === 0 ? "replacement-a" : "replacement-b";
					return jsonResponse({ ids: [id] });
				}
				if (init?.method === "POST") {
					const body = requestBody(init);
					if (typeof body?.id === "string" && body.id === "missing-file-id")
						return response(404);
					if (
						typeof body?.id === "string" &&
						body.id.startsWith("replacement-")
					) {
						if (replacementPostCompleted) return response(404);
						replacementPostCompleted = true;
					}
					return response(200, {
						Location: `https://upload.test/${body?.id}`,
					});
				}
				throw new Error(
					`Unexpected Drive request: ${init?.method ?? "GET"} ${url}`,
				);
			}),
		);

		const upload = () =>
			Effect.runPromise(
				createGoogleDriveResumableUpload(
					harness.repo,
					makeConfig(),
					{
						integrationId,
						ownerId: integrationOwnerId,
						videoId,
						key: resultKey,
						contentType: "video/mp4",
					},
					makeTokenStore(),
				),
			);
		const results = await Promise.allSettled([upload(), upload()]);
		const fulfilled = results.filter(
			(result): result is PromiseFulfilledResult<string> =>
				result.status === "fulfilled",
		);
		const successfulPosts = vi
			.mocked(fetch)
			.mock.calls.map(([, init]) => requestBody(init))
			.filter(
				(body): body is Record<string, unknown> =>
					typeof body?.id === "string" && body.id.startsWith("replacement-"),
			);
		const mapped = harness.objects.get(objectMapKey(integrationId, resultKey));

		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		expect(fulfilled).toHaveLength(1);
		expect(successfulPosts).toHaveLength(1);
		expect(mapped?.providerObjectId).toBe(successfulPosts[0]?.id);
		expect(mapped?.uploadSessionUrl).toBe(fulfilled[0]?.value);
		expect(
			harness.updates.filter(({ input }) =>
				input.providerObjectId.startsWith("replacement-"),
			),
		).toHaveLength(3);
		expect(
			harness.updates.filter(
				({ input }) =>
					input.providerObjectId.startsWith("replacement-") &&
					input.uploadSessionUrl === undefined,
			),
		).toHaveLength(2);
		const lateResult = await Promise.allSettled([upload()]);
		expect(lateResult[0]?.status).toBe("rejected");
		expect(generatedIdCount).toBe(2);
		expect(
			new Set(
				vi
					.mocked(fetch)
					.mock.calls.filter(([, init]) => init?.method === "POST")
					.map(([, init]) => requestBody(init)?.id)
					.filter(
						(id): id is string =>
							typeof id === "string" && id.startsWith("replacement-"),
					),
			),
		).toHaveLength(1);
	});

	it("does not let a stale session finalization replace a newer provider mapping", async () => {
		const harness = makeRepoHarness([
			{
				id: videoId,
				name: "Stale session race",
				ownerId: videoOwnerId,
				storageIntegrationId: integrationId,
			},
		]);
		harness.putObject(storedObjectInput(resultKey, "missing-file-id"));
		harness.putObject(
			storedObjectInput(".cap-folders/video-1", "folder-id", {
				contentType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
			}),
		);
		harness.putObject(
			storedObjectInput(
				".cap-warnings/video-1/DO_NOT_EDIT_OR_DELETE.txt",
				"warning-id",
				{ contentType: "text/plain" },
			),
		);
		let releaseStalePatch!: () => void;
		let firstPatchSeen!: () => void;
		const stalePatchSeen = new Promise<void>((resolve) => {
			firstPatchSeen = resolve;
		});
		const stalePatchRelease = new Promise<void>((resolve) => {
			releaseStalePatch = resolve;
		});
		let patchCount = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (init?.method === "PATCH" && url.includes("missing-file-id")) {
					patchCount += 1;
					if (patchCount === 1) {
						firstPatchSeen();
						await stalePatchRelease;
						return response(200, {
							Location: "https://upload.test/stale-session",
						});
					}
					return response(404);
				}
				if (url.includes("/files/generateIds"))
					return jsonResponse({ ids: ["replacement-id"] });
				if (init?.method === "POST") {
					const body = requestBody(init);
					if (body?.id === "missing-file-id") return response(404);
					return response(200, {
						Location: "https://upload.test/replacement-session",
					});
				}
				throw new Error(
					`Unexpected Drive request: ${init?.method ?? "GET"} ${url}`,
				);
			}),
		);

		const uploadInput = {
			integrationId,
			ownerId: integrationOwnerId,
			videoId,
			key: resultKey,
			contentType: "video/mp4",
		};
		const stale = Effect.runPromise(
			createGoogleDriveResumableUpload(
				harness.repo,
				makeConfig(),
				uploadInput,
				makeTokenStore(),
			),
		);
		await stalePatchSeen;
		const replacement = await Effect.runPromise(
			createGoogleDriveResumableUpload(
				harness.repo,
				makeConfig(),
				uploadInput,
				makeTokenStore(),
			),
		);
		releaseStalePatch();
		const staleResult = await Promise.allSettled([stale]);
		const mapped = harness.objects.get(objectMapKey(integrationId, resultKey));

		expect(replacement).toBe("https://upload.test/replacement-session");
		expect(staleResult[0]?.status).toBe("rejected");
		expect(mapped?.providerObjectId).toBe("replacement-id");
		expect(mapped?.uploadSessionUrl).toBe(replacement);
	});

	it("copies a final MP4 with the target title and records its managed metadata", async () => {
		const harness = makeRepoHarness([
			{
				id: videoId,
				name: "Copied: launch/demo",
				ownerId: videoOwnerId,
				storageIntegrationId: integrationId,
			},
		]);
		harness.putObject(
			storedObjectInput(".cap-folders/video-1", "folder-id", {
				contentType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
			}),
		);
		harness.putObject(
			storedObjectInput(
				".cap-warnings/video-1/DO_NOT_EDIT_OR_DELETE.txt",
				"warning-id",
				{ contentType: "text/plain" },
			),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				jsonResponse({
					id: "copied-file-id",
					name: "Copied: launch/demo.mp4",
					mimeType: "video/mp4",
					size: "1234",
				}),
			),
		);

		await Effect.runPromise(
			copyGoogleDriveFile({
				repo: harness.repo,
				config: makeConfig(),
				sourceFileId: "source-file-id",
				input: {
					integrationId,
					ownerId: integrationOwnerId,
					videoId,
					key: resultKey,
					contentType: "video/mp4",
				},
				tokenStore: makeTokenStore(),
			}),
		);

		const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
		expect(requestBody(init)).toEqual({
			name: "Copied: launch/demo.mp4",
			parents: ["folder-id"],
			appProperties: { capObjectKey: resultKey },
		});
		expect(harness.upserts.at(-1)).toMatchObject({
			providerObjectId: "copied-file-id",
			contentLength: 1234,
			metadata: {
				videoId,
				fileName: "Copied: launch/demo.mp4",
				contentType: "video/mp4",
			},
		});
	});
});

type DriveFileState = {
	id: string;
	name: string;
	mimeType: string;
	size?: string;
	md5Checksum?: string;
	parents: string[];
	trashed: boolean;
	appProperties?: Record<string, string>;
	capabilities: { canRename: boolean };
};

const makeDriveFileFetch = (
	files: Map<string, DriveFileState>,
	options: {
		failPatchFor?: string;
		events?: string[];
	} = {},
) => {
	let failed = false;
	return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const fileId = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
		const file = files.get(fileId);
		if (!file) return response(404);
		if (!init?.method || init.method === "GET") {
			options.events?.push(`GET:${fileId}`);
			return jsonResponse(file);
		}
		if (init.method === "PATCH") {
			options.events?.push(`PATCH:${fileId}`);
			if (options.failPatchFor === fileId && !failed) {
				failed = true;
				return response(503);
			}
			const body = requestBody(init);
			if (typeof body?.name === "string") file.name = body.name;
			return jsonResponse({ id: file.id, name: file.name });
		}
		throw new Error(`Unexpected Drive request: ${init.method} ${url}`);
	});
};

const makeSyncHarness = (
	fileStatus: StoredObject["uploadStatus"] = "complete",
) => {
	const harness = makeRepoHarness();
	const folderKey = ".cap-folders/video-1";
	const folderObject = harness.putObject(
		storedObjectInput(folderKey, "folder-id", {
			contentType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
			fileName: "Old title",
		}),
	);
	const fileObject = harness.putObject(
		storedObjectInput(resultKey, "file-id", {
			status: fileStatus,
			fileName: "Old title.mp4",
		}),
	);
	const files = new Map<string, DriveFileState>([
		[
			"folder-id",
			{
				id: "folder-id",
				name: "Old title",
				mimeType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
				parents: ["root-folder"],
				trashed: false,
				capabilities: { canRename: true },
			},
		],
		[
			"file-id",
			{
				id: "file-id",
				name: "Old title.mp4",
				mimeType: "video/mp4",
				size: "5678",
				md5Checksum: "original-md5",
				parents: ["folder-id"],
				trashed: false,
				appProperties: {
					capObjectKey: resultKey,
					customerTag: "keep-me",
				},
				capabilities: { canRename: true },
			},
		],
	]);
	return { harness, files, folderObject, fileObject };
};

const syncVideo = {
	id: videoId,
	ownerId: videoOwnerId,
	name: "New title: 测试 🎬",
	storageIntegrationId: integrationId,
};

const makeStorageVideo = (): Video.Video =>
	new Video.Video({
		id: videoId,
		ownerId: videoOwnerId,
		orgId: Organisation.OrganisationId.make("org-1"),
		name: "Recovery test",
		public: false,
		source: { type: "webMP4" },
		metadata: Option.none(),
		bucketId: Option.none(),
		storageIntegrationId: Option.some(integrationId),
		folderId: Option.none(),
		transcriptionStatus: Option.none(),
		width: Option.none(),
		height: Option.none(),
		duration: Option.none(),
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	});

const getStorageObject = (harness: RepoHarness) => {
	const dependencies = Layer.merge(
		Layer.succeed(StorageRepo, harness.repo),
		Layer.succeed(S3Buckets, {} as S3Buckets),
	);
	const storageLayer = StorageService.DefaultWithoutDependencies.pipe(
		Layer.provide(dependencies),
	);
	return Effect.runPromise(
		StorageService.getAccessForVideo(makeStorageVideo()).pipe(
			Effect.provide(storageLayer),
			Effect.flatMap(([access]) => access.getObject(resultKey)),
		),
	);
};

describe("Google Drive title synchronization", () => {
	it("does not serve or clobber a newer pending mapping during Drive recovery", async () => {
		const harness = makeRepoHarness();
		harness.putObject(
			storedObjectInput(resultKey, "stale-file-id", { status: "complete" }),
		);
		let switched = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.includes("alt=media")) return response(404);
				if (url.includes("/files?")) {
					if (!switched) {
						switched = true;
						harness.putObject(
							storedObjectInput(resultKey, "new-pending-id", {
								status: "pending",
							}),
						);
					}
					return jsonResponse({
						files: [
							{
								id: "recovered-stale-id",
								name: "Recovered.mp4",
								mimeType: "video/mp4",
								size: "123",
								modifiedTime: "2026-01-01T00:00:00.000Z",
							},
						],
					});
				}
				throw new Error(`Unexpected Drive request: ${url}`);
			}),
		);

		await expect(getStorageObject(harness)).resolves.toEqual(Option.none());
		const mapped = harness.objects.get(objectMapKey(integrationId, resultKey));
		expect(mapped).toMatchObject({
			providerObjectId: "new-pending-id",
			uploadStatus: "pending",
		});
		expect(
			vi
				.mocked(fetch)
				.mock.calls.some(([input]) =>
					String(input).includes("recovered-stale-id"),
				),
		).toBe(false);
		expect(harness.updates).toHaveLength(1);
	});

	it("rejects a different Drive candidate when the stored object is still pending", async () => {
		const harness = makeRepoHarness();
		const pending = harness.putObject(
			storedObjectInput(resultKey, "pending-file-id", { status: "pending" }),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				if (url.includes("alt=media")) return response(404);
				if (url.includes("/files?"))
					return jsonResponse({
						files: [
							{
								id: "different-file-id",
								name: "Different.mp4",
								mimeType: "video/mp4",
								size: "123",
								modifiedTime: "2026-01-01T00:00:00.000Z",
							},
						],
					});
				throw new Error(`Unexpected Drive request: ${url}`);
			}),
		);

		await expect(getStorageObject(harness)).resolves.toEqual(Option.none());
		expect(
			harness.objects.get(objectMapKey(integrationId, resultKey)),
		).toMatchObject({
			providerObjectId: pending.providerObjectId,
			uploadStatus: "pending",
		});
		expect(harness.updates).toHaveLength(0);
	});

	it("re-reads the current title and converges when it changes during the first patch", async () => {
		const initialVideo = { ...syncVideo, name: "First title" };
		const latestVideo = { ...syncVideo, name: "Latest title" };
		const { harness, files } = makeSyncHarness();
		harness.setVideo(initialVideo);
		const driveFetch = makeDriveFileFetch(files);
		let patchCount = 0;
		const fetchMock = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const result = await driveFetch(input, init);
				if (init?.method === "PATCH" && ++patchCount === 1) {
					harness.setVideo(latestVideo);
				}
				return result;
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		const dependencies = Layer.merge(
			Layer.succeed(StorageRepo, harness.repo),
			Layer.succeed(S3Buckets, {} as S3Buckets),
		);
		const storageLayer = StorageService.DefaultWithoutDependencies.pipe(
			Layer.provide(dependencies),
		);

		await Effect.runPromise(
			StorageService.syncVideoDisplayNames(videoId).pipe(
				Effect.provide(storageLayer),
			),
		);

		expect(
			fetchMock.mock.calls
				.filter(([, init]) => init?.method === "PATCH")
				.map(([, init]) => requestBody(init)),
		).toEqual([
			{ name: "First title" },
			{ name: "First title.mp4" },
			{ name: "Latest title" },
			{ name: "Latest title.mp4" },
		]);
		expect(files.get("folder-id")?.name).toBe("Latest title");
		expect(files.get("file-id")?.name).toBe("Latest title.mp4");
	});

	it("uses name-only patches and verifies ids, parents, hashes, and app properties", async () => {
		const { harness, files } = makeSyncHarness();
		harness.setFileNameUpdateResult(() => false);
		const fetchMock = makeDriveFileFetch(files);
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			Effect.runPromise(
				syncGoogleDriveVideoNames(
					harness.repo,
					makeConfig(),
					syncVideo,
					makeTokenStore(),
				),
			),
		).resolves.toBe(true);

		const patchBodies = fetchMock.mock.calls
			.filter(([, init]) => init?.method === "PATCH")
			.map(([, init]) => requestBody(init));
		expect(patchBodies).toEqual([
			{ name: "New title: 测试 🎬" },
			{ name: "New title: 测试 🎬.mp4" },
		]);
		expect(files.get("folder-id")).toMatchObject({
			id: "folder-id",
			name: "New title: 测试 🎬",
			parents: ["root-folder"],
		});
		expect(files.get("file-id")).toMatchObject({
			id: "file-id",
			name: "New title: 测试 🎬.mp4",
			size: "5678",
			md5Checksum: "original-md5",
			parents: ["folder-id"],
			appProperties: {
				capObjectKey: resultKey,
				customerTag: "keep-me",
			},
		});
		expect(harness.fileNameUpdates).toHaveLength(2);
	});

	it("renames a usable pending result only after every target passes provider preflight", async () => {
		const { harness, files, fileObject } = makeSyncHarness("pending");
		const events: string[] = [];
		const fetchMock = makeDriveFileFetch(files, { events });
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			Effect.runPromise(
				syncGoogleDriveVideoNames(
					harness.repo,
					makeConfig(),
					syncVideo,
					makeTokenStore(),
				),
			),
		).resolves.toBe(true);
		expect(events.indexOf("PATCH:folder-id")).toBeGreaterThan(
			events.indexOf("GET:file-id"),
		);
		expect(fileObject).toMatchObject({
			providerObjectId: "file-id",
			uploadStatus: "pending",
			contentLength: null,
		});
	});

	it.each([
		["zero provider size", "0", null],
		["stored length mismatch", "5678", 1234],
	] as const)(
		"retries a pending result with %s without patching",
		async (_, size, contentLength) => {
			const { harness, files, fileObject } = makeSyncHarness("pending");
			fileObject.contentLength = contentLength;
			const providerFile = files.get("file-id");
			if (providerFile) providerFile.size = size;
			const fetchMock = makeDriveFileFetch(files);
			vi.stubGlobal("fetch", fetchMock);

			await expect(
				Effect.runPromise(
					syncGoogleDriveVideoNames(
						harness.repo,
						makeConfig(),
						syncVideo,
						makeTokenStore(),
					),
				),
			).rejects.toBeDefined();
			expect(
				fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH"),
			).toHaveLength(0);
			expect(fileObject.uploadStatus).toBe("pending");
		},
	);

	it("resumes idempotently after a partial Drive failure", async () => {
		const { harness, files } = makeSyncHarness();
		const fetchMock = makeDriveFileFetch(files, { failPatchFor: "file-id" });
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			Effect.runPromise(
				syncGoogleDriveVideoNames(
					harness.repo,
					makeConfig(),
					syncVideo,
					makeTokenStore(),
				),
			),
		).rejects.toBeDefined();
		expect(files.get("folder-id")?.name).toBe("New title: 测试 🎬");
		expect(files.get("file-id")?.name).toBe("Old title.mp4");

		await expect(
			Effect.runPromise(
				syncGoogleDriveVideoNames(
					harness.repo,
					makeConfig(),
					syncVideo,
					makeTokenStore(),
				),
			),
		).resolves.toBe(true);
		expect(files.get("file-id")?.name).toBe("New title: 测试 🎬.mp4");
	});
});
