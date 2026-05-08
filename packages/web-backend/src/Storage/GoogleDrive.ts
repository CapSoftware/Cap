import { createHash, randomUUID } from "node:crypto";
import { serverEnv } from "@cap/env";
import { Storage, type User, type Video } from "@cap/web-domain";
import { Effect, Option, Schedule } from "effect";
import type {
	GoogleDriveAccessTokenCache,
	GoogleDriveIntegrationConfig,
	GoogleDriveStorageQuota,
	StorageRepo,
} from "./StorageRepo.ts";

const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3";
export const GOOGLE_DRIVE_FOLDER_MIME_TYPE =
	"application/vnd.google-apps.folder";
const DRIVE_FOLDER_OBJECT_PREFIX = ".cap-folders";
const DRIVE_WARNING_OBJECT_PREFIX = ".cap-warnings";
const DRIVE_WARNING_FILE_NAME = "DO_NOT_EDIT_OR_DELETE.txt";
const DRIVE_WARNING_TEXT =
	"Cap uses this folder to store and serve your video files. Do not rename, move, edit, or delete files or folders here. Changing anything in this folder can break playback, downloads, thumbnails, captions, and processing.";

export type GoogleDriveFile = {
	id: string;
	name?: string;
	mimeType?: string;
	size?: string;
	modifiedTime?: string;
};

type GoogleDriveListResponse = {
	files?: GoogleDriveFile[];
};

type GoogleDriveTokenResponse = {
	access_token?: string;
	expires_in?: number;
	scope?: string;
	token_type?: string;
	refresh_token?: string;
};

export type GoogleDriveTokenStore = {
	cacheKey: string;
	getInitialAccessTokenCache: () => Effect.Effect<
		Option.Option<GoogleDriveAccessTokenCache>,
		Storage.StorageError
	>;
	getAccessTokenCache: () => Effect.Effect<
		Option.Option<GoogleDriveAccessTokenCache>,
		Storage.StorageError
	>;
	claimRefreshLease: (
		leaseId: string,
		expiresAt: Date,
	) => Effect.Effect<boolean, Storage.StorageError>;
	saveAccessTokenCache: (
		leaseId: string,
		cache: GoogleDriveAccessTokenCache,
	) => Effect.Effect<boolean, Storage.StorageError>;
	releaseRefreshLease: (
		leaseId: string,
	) => Effect.Effect<unknown, Storage.StorageError>;
};

export type CreateGoogleDriveUploadInput = {
	integrationId: Storage.StorageIntegrationId;
	ownerId: User.UserId;
	videoId: Video.VideoId | null;
	key: string;
	contentType: string;
	contentLength?: number;
};

const normalizeContentType = (contentType?: string | null) =>
	contentType?.trim() ? contentType : "application/octet-stream";

const parseDriveJson = async <T>(response: Response) => {
	const text = await response.text();
	if (!text) return {} as T;
	return JSON.parse(text) as T;
};

const assertDriveResponse = async (response: Response) => {
	if (response.ok || response.status === 308) return;
	const text = await response.text().catch(() => "");
	throw new Error(`Google Drive request failed: ${response.status} ${text}`);
};

const escapeDriveQueryValue = (value: string) =>
	value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

const GOOGLE_DRIVE_ACCESS_TOKEN_EXPIRY_MARGIN_MS = 60_000;
const GOOGLE_DRIVE_TOKEN_REFRESH_LEASE_MS = 15_000;
const googleDriveAccessTokenCache = new Map<
	string,
	GoogleDriveAccessTokenCache
>();
const googleDriveAccessTokenRefreshes = new Map<
	string,
	Promise<GoogleDriveAccessTokenCache>
>();

const getGoogleDriveAccessTokenCacheKey = (
	config: GoogleDriveIntegrationConfig,
) => createHash("sha256").update(config.refreshToken).digest("hex");

const isGoogleDriveAccessTokenFresh = (
	token: GoogleDriveAccessTokenCache | undefined,
	invalidAccessToken?: string,
) =>
	Boolean(
		token &&
			token.expiresAt.getTime() > Date.now() &&
			token.accessToken !== invalidAccessToken,
	);

export const getGoogleDriveAuthUrl = ({ state }: { state: string }) => {
	const env = serverEnv();
	if (!env.GOOGLE_CLIENT_ID) {
		throw new Error("GOOGLE_CLIENT_ID is not configured");
	}

	const params = new URLSearchParams({
		client_id: env.GOOGLE_CLIENT_ID,
		redirect_uri: `${env.WEB_URL}/api/desktop/storage/google-drive/callback`,
		response_type: "code",
		access_type: "offline",
		prompt: "consent",
		scope: DRIVE_FILE_SCOPE,
		state,
		include_granted_scopes: "true",
	});

	return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
};

export const exchangeGoogleDriveCode = (code: string) =>
	Effect.tryPromise({
		try: async () => {
			const env = serverEnv();
			if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
				throw new Error("Google OAuth is not configured");
			}

			const response = await fetch("https://oauth2.googleapis.com/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					code,
					client_id: env.GOOGLE_CLIENT_ID,
					client_secret: env.GOOGLE_CLIENT_SECRET,
					redirect_uri: `${env.WEB_URL}/api/desktop/storage/google-drive/callback`,
					grant_type: "authorization_code",
				}),
			});

			await assertDriveResponse(response);
			const tokens = await parseDriveJson<GoogleDriveTokenResponse>(response);
			if (!tokens.refresh_token) {
				throw new Error("Google did not return a refresh token");
			}
			return tokens;
		},
		catch: (cause) => new Storage.StorageError({ cause }),
	});

const fetchGoogleDriveAccessToken = async (
	config: GoogleDriveIntegrationConfig,
): Promise<GoogleDriveAccessTokenCache> => {
	const env = serverEnv();
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
		throw new Error("Google OAuth is not configured");
	}

	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: env.GOOGLE_CLIENT_ID,
			client_secret: env.GOOGLE_CLIENT_SECRET,
			refresh_token: config.refreshToken,
			grant_type: "refresh_token",
		}),
	});

	await assertDriveResponse(response);
	const token = await parseDriveJson<GoogleDriveTokenResponse>(response);
	if (!token.access_token) {
		throw new Error("Google did not return an access token");
	}

	const ttlMs = Math.max(
		(token.expires_in ?? 3600) * 1000 -
			GOOGLE_DRIVE_ACCESS_TOKEN_EXPIRY_MARGIN_MS,
		0,
	);
	return {
		accessToken: token.access_token,
		expiresAt: new Date(Date.now() + ttlMs),
	};
};

const fetchLocalGoogleDriveAccessToken = (
	config: GoogleDriveIntegrationConfig,
	cacheKey: string,
) =>
	Effect.tryPromise({
		try: async () => {
			const currentRefresh = googleDriveAccessTokenRefreshes.get(cacheKey);
			if (currentRefresh) return currentRefresh;

			const refresh = fetchGoogleDriveAccessToken(config).finally(() => {
				googleDriveAccessTokenRefreshes.delete(cacheKey);
			});
			googleDriveAccessTokenRefreshes.set(cacheKey, refresh);
			const token = await refresh;
			googleDriveAccessTokenCache.set(cacheKey, token);
			return token;
		},
		catch: (cause) => new Storage.StorageError({ cause }),
	});

const readFreshPersistedGoogleDriveAccessToken = (
	tokenStore: GoogleDriveTokenStore,
	cacheKey: string,
	invalidAccessToken?: string,
) =>
	tokenStore.getAccessTokenCache().pipe(
		Effect.flatMap(
			Option.match({
				onNone: () =>
					Effect.fail(
						new Storage.StorageError({
							cause: new Error("Google Drive access token is not cached"),
						}),
					),
				onSome: (token) => {
					if (!isGoogleDriveAccessTokenFresh(token, invalidAccessToken)) {
						return Effect.fail(
							new Storage.StorageError({
								cause: new Error("Google Drive access token cache is stale"),
							}),
						);
					}

					googleDriveAccessTokenCache.set(cacheKey, token);
					return Effect.succeed(token);
				},
			}),
		),
	);

const refreshPersistedGoogleDriveAccessToken = (
	config: GoogleDriveIntegrationConfig,
	tokenStore: GoogleDriveTokenStore,
	cacheKey: string,
	invalidAccessToken?: string,
): Effect.Effect<GoogleDriveAccessTokenCache, Storage.StorageError> =>
	Effect.gen(function* () {
		const leaseId = randomUUID();
		const leaseExpiresAt = new Date(
			Date.now() + GOOGLE_DRIVE_TOKEN_REFRESH_LEASE_MS,
		);
		const claimed = yield* tokenStore.claimRefreshLease(
			leaseId,
			leaseExpiresAt,
		);

		if (!claimed) {
			return yield* readFreshPersistedGoogleDriveAccessToken(
				tokenStore,
				cacheKey,
				invalidAccessToken,
			).pipe(
				Effect.retry({
					times: 8,
					schedule: Schedule.exponential("100 millis"),
				}),
				Effect.catchAll(() =>
					refreshPersistedGoogleDriveAccessToken(
						config,
						tokenStore,
						cacheKey,
						invalidAccessToken,
					),
				),
			);
		}

		const token = yield* Effect.tryPromise({
			try: () => fetchGoogleDriveAccessToken(config),
			catch: (cause) => new Storage.StorageError({ cause }),
		}).pipe(Effect.tapError(() => tokenStore.releaseRefreshLease(leaseId)));
		const saved = yield* tokenStore.saveAccessTokenCache(leaseId, token);
		if (!saved) {
			return yield* readFreshPersistedGoogleDriveAccessToken(
				tokenStore,
				cacheKey,
				invalidAccessToken,
			);
		}
		googleDriveAccessTokenCache.set(cacheKey, token);
		return token;
	});

const loadGoogleDriveAccessToken = (
	config: GoogleDriveIntegrationConfig,
	forceRefresh: boolean,
	tokenStore?: GoogleDriveTokenStore,
	invalidAccessToken?: string,
) =>
	Effect.gen(function* () {
		const cacheKey =
			tokenStore?.cacheKey ?? getGoogleDriveAccessTokenCacheKey(config);
		const cached = googleDriveAccessTokenCache.get(cacheKey);
		if (
			!forceRefresh &&
			isGoogleDriveAccessTokenFresh(cached, invalidAccessToken)
		) {
			return cached as GoogleDriveAccessTokenCache;
		}
		if (forceRefresh) googleDriveAccessTokenCache.delete(cacheKey);

		if (!forceRefresh && tokenStore) {
			const initialToken = yield* tokenStore.getInitialAccessTokenCache();
			if (
				Option.isSome(initialToken) &&
				isGoogleDriveAccessTokenFresh(initialToken.value, invalidAccessToken)
			) {
				googleDriveAccessTokenCache.set(cacheKey, initialToken.value);
				return initialToken.value;
			}
		}

		if (tokenStore) {
			return yield* refreshPersistedGoogleDriveAccessToken(
				config,
				tokenStore,
				cacheKey,
				invalidAccessToken,
			);
		}

		return yield* fetchLocalGoogleDriveAccessToken(config, cacheKey);
	});

export const refreshGoogleDriveAccessToken = (
	config: GoogleDriveIntegrationConfig,
	tokenStore?: GoogleDriveTokenStore,
	invalidAccessToken?: string,
) =>
	loadGoogleDriveAccessToken(config, true, tokenStore, invalidAccessToken).pipe(
		Effect.map((token) => token.accessToken),
	);

const getCachedGoogleDriveAccessToken = (
	config: GoogleDriveIntegrationConfig,
	tokenStore?: GoogleDriveTokenStore,
) =>
	loadGoogleDriveAccessToken(config, false, tokenStore).pipe(
		Effect.map((token) => token.accessToken),
	);

const clearCachedGoogleDriveAccessToken = (
	config: GoogleDriveIntegrationConfig,
	tokenStore?: GoogleDriveTokenStore,
) =>
	Effect.sync(() => {
		googleDriveAccessTokenCache.delete(
			tokenStore?.cacheKey ?? getGoogleDriveAccessTokenCacheKey(config),
		);
	});

const sendDriveRequest = (
	accessToken: string,
	url: string,
	init?: RequestInit,
) =>
	Effect.tryPromise({
		try: () => {
			const headers = new Headers(init?.headers);
			headers.set("Authorization", `Bearer ${accessToken}`);
			return fetch(url, { ...init, headers });
		},
		catch: (cause) => new Storage.StorageError({ cause }),
	});

const driveFetch = (
	config: GoogleDriveIntegrationConfig,
	url: string,
	init?: RequestInit,
	tokenStore?: GoogleDriveTokenStore,
) =>
	Effect.gen(function* () {
		const accessToken = yield* getCachedGoogleDriveAccessToken(
			config,
			tokenStore,
		);
		let response = yield* sendDriveRequest(accessToken, url, init);
		if (response.status === 401) {
			yield* clearCachedGoogleDriveAccessToken(config, tokenStore);
			const refreshedAccessToken = yield* refreshGoogleDriveAccessToken(
				config,
				tokenStore,
				accessToken,
			);
			response = yield* sendDriveRequest(refreshedAccessToken, url, init);
		}
		yield* Effect.tryPromise({
			try: () => assertDriveResponse(response),
			catch: (cause) => new Storage.StorageError({ cause }),
		});
		return response;
	});

const getDriveFileName = (key: string) => {
	const parts = key.split("/").filter(Boolean);
	if (parts[2] === "segments") return parts.slice(3).join("__") || "file";
	if (parts.length > 2) return parts.slice(2).join("__");
	return parts.at(-1) ?? "file";
};

const getDriveFolderParts = (key: string) => {
	const parts = key.split("/").filter(Boolean);
	if (parts.length < 2) return [];
	return parts[2] === "segments"
		? [parts[1] as string, "segments"]
		: [parts[1] as string];
};

const getDriveFolderObjectKey = (folderPath: string) =>
	`${DRIVE_FOLDER_OBJECT_PREFIX}/${folderPath}`;

const getDriveWarningObjectKey = (folderPath: string) =>
	`${DRIVE_WARNING_OBJECT_PREFIX}/${folderPath}/${DRIVE_WARNING_FILE_NAME}`;

export const getGoogleDriveUserEmail = (
	config: GoogleDriveIntegrationConfig,
	tokenStore?: GoogleDriveTokenStore,
) =>
	driveFetch(
		config,
		`${DRIVE_API_BASE}/about?fields=user(emailAddress)`,
		undefined,
		tokenStore,
	).pipe(
		Effect.flatMap((response) =>
			Effect.tryPromise({
				try: async () => {
					const body = (await parseDriveJson<{
						user?: { emailAddress?: string };
					}>(response)) as { user?: { emailAddress?: string } };
					return body.user?.emailAddress;
				},
				catch: (cause) => new Storage.StorageError({ cause }),
			}),
		),
	);

export const getGoogleDriveStorageQuota = (
	config: GoogleDriveIntegrationConfig,
	tokenStore?: GoogleDriveTokenStore,
) =>
	driveFetch(
		config,
		`${DRIVE_API_BASE}/about?fields=storageQuota(limit,usage,usageInDrive,usageInDriveTrash)`,
		undefined,
		tokenStore,
	).pipe(
		Effect.flatMap((response) =>
			Effect.tryPromise({
				try: async () => {
					const body = await parseDriveJson<{
						storageQuota?: GoogleDriveStorageQuota;
					}>(response);
					return body.storageQuota ?? {};
				},
				catch: (cause) => new Storage.StorageError({ cause }),
			}),
		),
	);

export const ensureGoogleDriveFolder = (
	config: GoogleDriveIntegrationConfig,
	name: string,
	parentId?: string,
	tokenStore?: GoogleDriveTokenStore,
) =>
	Effect.gen(function* () {
		const query = [
			`name='${escapeDriveQueryValue(name)}'`,
			"mimeType='application/vnd.google-apps.folder'",
			"trashed=false",
			...(parentId ? [`'${escapeDriveQueryValue(parentId)}' in parents`] : []),
		].join(" and ");
		const listUrl = `${DRIVE_API_BASE}/files?q=${encodeURIComponent(query)}&fields=files(id,name)&spaces=drive`;
		const listResponse = yield* driveFetch(
			config,
			listUrl,
			undefined,
			tokenStore,
		);
		const listBody = yield* Effect.tryPromise({
			try: () => parseDriveJson<GoogleDriveListResponse>(listResponse),
			catch: (cause) => new Storage.StorageError({ cause }),
		});
		const existingId = listBody.files?.[0]?.id;
		if (existingId) return existingId;

		const createResponse = yield* driveFetch(
			config,
			`${DRIVE_API_BASE}/files`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name,
					mimeType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
					...(parentId ? { parents: [parentId] } : {}),
				}),
			},
			tokenStore,
		);

		const created = yield* Effect.tryPromise({
			try: () => parseDriveJson<GoogleDriveFile>(createResponse),
			catch: (cause) => new Storage.StorageError({ cause }),
		});
		if (!created.id) {
			return yield* Effect.fail(
				new Storage.StorageError({
					cause: new Error("Google Drive folder creation did not return an id"),
				}),
			);
		}
		return created.id;
	});

const createGoogleDriveFolderWithId = (
	config: GoogleDriveIntegrationConfig,
	id: string,
	name: string,
	parentId: string,
	tokenStore?: GoogleDriveTokenStore,
) =>
	driveFetch(
		config,
		`${DRIVE_API_BASE}/files?fields=id,name`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				id,
				name,
				mimeType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
				parents: [parentId],
			}),
		},
		tokenStore,
	).pipe(Effect.asVoid);

const createGoogleDriveTextFileWithId = ({
	config,
	id,
	name,
	parentId,
	content,
	tokenStore,
}: {
	config: GoogleDriveIntegrationConfig;
	id: string;
	name: string;
	parentId: string;
	content: string;
	tokenStore?: GoogleDriveTokenStore;
}) => {
	const boundary = `cap_drive_boundary_${id}`;
	const metadata = JSON.stringify({
		id,
		name,
		mimeType: "text/plain",
		parents: [parentId],
	});
	const body = [
		`--${boundary}`,
		"Content-Type: application/json; charset=UTF-8",
		"",
		metadata,
		`--${boundary}`,
		"Content-Type: text/plain; charset=UTF-8",
		"",
		content,
		`--${boundary}--`,
		"",
	].join("\r\n");

	return driveFetch(
		config,
		`${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,mimeType,size`,
		{
			method: "POST",
			headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
			body,
		},
		tokenStore,
	).pipe(Effect.asVoid);
};

const waitForReservedGoogleDriveObject = (
	repo: StorageRepo,
	integrationId: Storage.StorageIntegrationId,
	objectKey: string,
) =>
	repo.getObjectByKey(integrationId, objectKey).pipe(
		Effect.flatMap(
			Option.match({
				onNone: () =>
					Effect.fail(
						new Storage.StorageError({
							cause: new Error("Google Drive object reservation not found"),
						}),
					),
				onSome: (object) =>
					object.uploadStatus === "complete"
						? Effect.succeed(object.providerObjectId)
						: Effect.fail(
								new Storage.StorageError({
									cause: new Error("Google Drive object reservation pending"),
								}),
							),
			}),
		),
		Effect.retry({
			times: 8,
			schedule: Schedule.exponential("100 millis"),
		}),
	);

const getOrCreateGoogleDriveFolder = ({
	repo,
	config,
	input,
	folderPath,
	name,
	parentId,
	tokenStore,
}: {
	repo: StorageRepo;
	config: GoogleDriveIntegrationConfig;
	input: CreateGoogleDriveUploadInput;
	folderPath: string;
	name: string;
	parentId: string;
	tokenStore?: GoogleDriveTokenStore;
}) =>
	Effect.gen(function* () {
		const folderObjectKey = getDriveFolderObjectKey(folderPath);
		const existing = yield* repo.getObjectByKey(
			input.integrationId,
			folderObjectKey,
		);
		if (Option.isSome(existing)) {
			if (existing.value.uploadStatus === "complete") {
				return existing.value.providerObjectId;
			}
			return yield* waitForReservedGoogleDriveObject(
				repo,
				input.integrationId,
				folderObjectKey,
			);
		}

		const folderId = yield* generateGoogleDriveFileId(config, tokenStore);
		const reserved = yield* repo.reserveObject({
			integrationId: input.integrationId,
			ownerId: input.ownerId,
			videoId: input.videoId,
			objectKey: folderObjectKey,
			providerObjectId: folderId,
			uploadStatus: "pending",
			contentType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
			metadata: {
				videoId: input.videoId ?? undefined,
				fileName: name,
				contentType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
			},
		});

		if (reserved.providerObjectId !== folderId) {
			return yield* waitForReservedGoogleDriveObject(
				repo,
				input.integrationId,
				folderObjectKey,
			);
		}

		yield* createGoogleDriveFolderWithId(
			config,
			folderId,
			name,
			parentId,
			tokenStore,
		).pipe(
			Effect.tapError(() =>
				repo.deleteObjectByKey(input.integrationId, folderObjectKey),
			),
		);
		yield* repo.markObjectComplete(input.integrationId, folderObjectKey);
		return folderId;
	});

const ensureGoogleDriveWarningFile = ({
	repo,
	config,
	input,
	folderPath,
	parentId,
	tokenStore,
}: {
	repo: StorageRepo;
	config: GoogleDriveIntegrationConfig;
	input: CreateGoogleDriveUploadInput;
	folderPath: string;
	parentId: string;
	tokenStore?: GoogleDriveTokenStore;
}) =>
	Effect.gen(function* () {
		const warningObjectKey = getDriveWarningObjectKey(folderPath);
		const existing = yield* repo.getObjectByKey(
			input.integrationId,
			warningObjectKey,
		);
		if (Option.isSome(existing)) {
			if (existing.value.uploadStatus === "complete") return;
			yield* waitForReservedGoogleDriveObject(
				repo,
				input.integrationId,
				warningObjectKey,
			);
			return;
		}

		const warningFileId = yield* generateGoogleDriveFileId(config, tokenStore);
		const reserved = yield* repo.reserveObject({
			integrationId: input.integrationId,
			ownerId: input.ownerId,
			videoId: input.videoId,
			objectKey: warningObjectKey,
			providerObjectId: warningFileId,
			uploadStatus: "pending",
			contentType: "text/plain",
			contentLength: DRIVE_WARNING_TEXT.length,
			metadata: {
				videoId: input.videoId ?? undefined,
				fileName: DRIVE_WARNING_FILE_NAME,
				contentType: "text/plain",
			},
		});

		if (reserved.providerObjectId !== warningFileId) {
			yield* waitForReservedGoogleDriveObject(
				repo,
				input.integrationId,
				warningObjectKey,
			);
			return;
		}

		yield* createGoogleDriveTextFileWithId({
			config,
			id: warningFileId,
			name: DRIVE_WARNING_FILE_NAME,
			parentId,
			content: DRIVE_WARNING_TEXT,
			tokenStore,
		}).pipe(
			Effect.tapError(() =>
				repo.deleteObjectByKey(input.integrationId, warningObjectKey),
			),
		);
		yield* repo.markObjectComplete(
			input.integrationId,
			warningObjectKey,
			DRIVE_WARNING_TEXT.length,
		);
	});

const getGoogleDriveUploadParentId = (
	repo: StorageRepo,
	config: GoogleDriveIntegrationConfig,
	input: CreateGoogleDriveUploadInput,
	tokenStore?: GoogleDriveTokenStore,
) =>
	Effect.gen(function* () {
		const folderParts = getDriveFolderParts(input.key);
		let parentId = config.folderId;
		const pathParts: string[] = [];
		let videoFolderId: string | null = null;
		let videoFolderPath: string | null = null;

		for (const folderName of folderParts) {
			pathParts.push(folderName);
			parentId = yield* getOrCreateGoogleDriveFolder({
				repo,
				config,
				input,
				folderPath: pathParts.join("/"),
				name: folderName,
				parentId,
				tokenStore,
			});
			if (pathParts.length === 1) {
				videoFolderId = parentId;
				videoFolderPath = pathParts.join("/");
			}
		}

		if (videoFolderId && videoFolderPath) {
			yield* ensureGoogleDriveWarningFile({
				repo,
				config,
				input,
				folderPath: videoFolderPath,
				parentId: videoFolderId,
				tokenStore,
			});
		}

		return parentId;
	});

const generateGoogleDriveFileId = (
	config: GoogleDriveIntegrationConfig,
	tokenStore?: GoogleDriveTokenStore,
) =>
	driveFetch(
		config,
		`${DRIVE_API_BASE}/files/generateIds?count=1&space=drive&type=files`,
		undefined,
		tokenStore,
	).pipe(
		Effect.flatMap((response) =>
			Effect.tryPromise({
				try: async () => {
					const body = await parseDriveJson<{ ids?: string[] }>(response);
					const id = body.ids?.[0];
					if (!id) throw new Error("Google Drive did not return a file id");
					return id;
				},
				catch: (cause) => new Storage.StorageError({ cause }),
			}),
		),
	);

export const createGoogleDriveResumableUpload = (
	repo: StorageRepo,
	config: GoogleDriveIntegrationConfig,
	input: CreateGoogleDriveUploadInput,
	tokenStore?: GoogleDriveTokenStore,
) =>
	Effect.gen(function* () {
		const contentType = normalizeContentType(input.contentType);
		const [parentId, fileId] = yield* Effect.all([
			getGoogleDriveUploadParentId(repo, config, input, tokenStore),
			generateGoogleDriveFileId(config, tokenStore),
		]);
		const headers: Record<string, string> = {
			"Content-Type": "application/json; charset=UTF-8",
			"X-Upload-Content-Type": contentType,
		};
		if (input.contentLength !== undefined) {
			headers["X-Upload-Content-Length"] = input.contentLength.toString();
		}

		const response = yield* driveFetch(
			config,
			`${DRIVE_UPLOAD_BASE}/files?uploadType=resumable&fields=id,name,mimeType,size`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					id: fileId,
					name: getDriveFileName(input.key),
					mimeType: contentType,
					parents: [parentId],
					appProperties: {
						capObjectKey: input.key,
					},
				}),
			},
			tokenStore,
		);
		const uploadUrl = response.headers.get("Location");
		if (!uploadUrl) {
			return yield* Effect.fail(
				new Storage.StorageError({
					cause: new Error("Google Drive did not return an upload URL"),
				}),
			);
		}

		yield* repo.upsertObject({
			integrationId: input.integrationId,
			ownerId: input.ownerId,
			videoId: input.videoId,
			objectKey: input.key,
			providerObjectId: fileId,
			uploadSessionUrl: uploadUrl,
			uploadStatus: "pending",
			contentType,
			contentLength: input.contentLength ?? null,
			metadata: {
				videoId: input.videoId ?? undefined,
				fileName: getDriveFileName(input.key),
				contentType,
			},
		});

		return uploadUrl;
	});

export const getGoogleDriveFileMetadata = (
	config: GoogleDriveIntegrationConfig,
	fileId: string,
	tokenStore?: GoogleDriveTokenStore,
) =>
	driveFetch(
		config,
		`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size`,
		undefined,
		tokenStore,
	).pipe(
		Effect.flatMap((response) =>
			Effect.tryPromise({
				try: () => parseDriveJson<GoogleDriveFile>(response),
				catch: (cause) => new Storage.StorageError({ cause }),
			}),
		),
	);

export const findGoogleDriveFileByObjectKey = (
	config: GoogleDriveIntegrationConfig,
	key: string,
	tokenStore?: GoogleDriveTokenStore,
) => {
	const query = [
		`appProperties has { key='capObjectKey' and value='${escapeDriveQueryValue(key)}' }`,
		"trashed=false",
	].join(" and ");
	const params = new URLSearchParams({
		q: query,
		fields: "files(id,name,mimeType,size,modifiedTime)",
		orderBy: "modifiedTime desc",
		pageSize: "10",
		spaces: "drive",
	});

	return driveFetch(
		config,
		`${DRIVE_API_BASE}/files?${params.toString()}`,
		undefined,
		tokenStore,
	).pipe(
		Effect.flatMap((response) =>
			Effect.tryPromise({
				try: () => parseDriveJson<GoogleDriveListResponse>(response),
				catch: (cause) => new Storage.StorageError({ cause }),
			}),
		),
		Effect.map((body) => {
			const files = body.files ?? [];
			return Option.fromNullable(
				files.find((file) => Number(file.size ?? 0) > 0) ?? files[0],
			);
		}),
	);
};

export const getGoogleDriveObjectText = (
	config: GoogleDriveIntegrationConfig,
	fileId: string,
	tokenStore?: GoogleDriveTokenStore,
) =>
	driveFetch(
		config,
		`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
		undefined,
		tokenStore,
	).pipe(
		Effect.flatMap((response) =>
			Effect.tryPromise({
				try: () => response.text(),
				catch: (cause) => new Storage.StorageError({ cause }),
			}),
		),
	);

export const getGoogleDriveObjectResponse = (
	config: GoogleDriveIntegrationConfig,
	fileId: string,
	range?: string | null,
	tokenStore?: GoogleDriveTokenStore,
) =>
	Effect.gen(function* () {
		const headers: Record<string, string> = {};
		if (range) headers.Range = range;
		const response = yield* driveFetch(
			config,
			`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
			{ headers },
			tokenStore,
		);
		return response;
	});

export const deleteGoogleDriveFile = (
	config: GoogleDriveIntegrationConfig,
	fileId: string,
	tokenStore?: GoogleDriveTokenStore,
) =>
	driveFetch(
		config,
		`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`,
		{
			method: "DELETE",
		},
		tokenStore,
	).pipe(Effect.asVoid);

export const copyGoogleDriveFile = ({
	repo,
	config,
	sourceFileId,
	input,
	tokenStore,
}: {
	repo: StorageRepo;
	config: GoogleDriveIntegrationConfig;
	sourceFileId: string;
	input: CreateGoogleDriveUploadInput;
	tokenStore?: GoogleDriveTokenStore;
}) =>
	Effect.gen(function* () {
		const parentId = yield* getGoogleDriveUploadParentId(
			repo,
			config,
			input,
			tokenStore,
		);
		const response = yield* driveFetch(
			config,
			`${DRIVE_API_BASE}/files/${encodeURIComponent(sourceFileId)}/copy?fields=id,name,mimeType,size`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: getDriveFileName(input.key),
					parents: [parentId],
					appProperties: {
						capObjectKey: input.key,
					},
				}),
			},
			tokenStore,
		);
		const copied = yield* Effect.tryPromise({
			try: () => parseDriveJson<GoogleDriveFile>(response),
			catch: (cause) => new Storage.StorageError({ cause }),
		});
		if (!copied.id) {
			return yield* Effect.fail(
				new Storage.StorageError({
					cause: new Error("Google Drive copy did not return an id"),
				}),
			);
		}
		yield* repo.upsertObject({
			integrationId: input.integrationId,
			ownerId: input.ownerId,
			videoId: input.videoId,
			objectKey: input.key,
			providerObjectId: copied.id,
			uploadStatus: "complete",
			contentType: copied.mimeType ?? input.contentType,
			contentLength: copied.size ? Number(copied.size) : null,
		});
	});

export const parseVideoIdFromObjectKey = (key: string) =>
	Option.fromNullable(key.split("/")[1]).pipe(Option.filter((id) => id !== ""));
