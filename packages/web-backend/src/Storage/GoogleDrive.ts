import { createHash, randomUUID } from "node:crypto";
import { serverEnv } from "@cap/env";
import { Storage, type User, type Video } from "@cap/web-domain";
import { Effect, Either, Option, Schedule } from "effect";
import { getGoogleDriveVideoNames } from "./google-drive-names.ts";
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
	version?: string;
	md5Checksum?: string;
	modifiedTime?: string;
	parents?: string[];
	trashed?: boolean;
	appProperties?: Record<string, string>;
	capabilities?: { canRename?: boolean };
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

export type GoogleDriveFolderLocation = {
	id: string;
	name: string;
	driveId?: string | null;
	driveName?: string | null;
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
	videoTitle?: string;
};

const normalizeContentType = (contentType?: string | null) =>
	contentType?.trim() ? contentType : "application/octet-stream";

const getGoogleDriveBrowserUploadOrigin = () => {
	try {
		return new URL(serverEnv().WEB_URL).origin;
	} catch {
		return null;
	}
};

const appendDriveQuery = (
	url: string,
	params: Record<string, string | undefined>,
) => {
	const nextUrl = new URL(url);
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) nextUrl.searchParams.set(key, value);
	}
	return nextUrl.toString();
};

const appendSharedDriveCreateParams = (url: string) =>
	appendDriveQuery(url, { supportsAllDrives: "true" });

const appendSharedDriveListParams = (
	url: string,
	config: GoogleDriveIntegrationConfig,
) =>
	appendDriveQuery(url, {
		supportsAllDrives: "true",
		includeItemsFromAllDrives: "true",
		corpora: config.driveId ? "drive" : undefined,
		driveId: config.driveId ?? undefined,
	});

const parseDriveJson = async <T>(response: Response) => {
	const text = await response.text();
	if (!text) return {} as T;
	return JSON.parse(text) as T;
};

export class GoogleDriveRequestError extends Error {
	constructor(
		readonly status: number,
		text: string,
	) {
		super(`Google Drive request failed: ${status} ${text}`);
		this.name = "GoogleDriveRequestError";
	}
}

const assertDriveResponse = async (response: Response) => {
	if (response.ok || response.status === 308) return;
	const text = await response.text().catch(() => "");
	throw new GoogleDriveRequestError(response.status, text);
};

const isDriveRequestStatus = (
	error: Storage.StorageError,
	...statuses: number[]
) =>
	error.cause instanceof GoogleDriveRequestError &&
	statuses.includes(error.cause.status);

const escapeDriveQueryValue = (value: string) =>
	value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

const getGoogleDriveObjectKeyHash = (key: string) =>
	createHash("sha256").update(key, "utf8").digest("hex");

const getGoogleDriveObjectKeyProperty = (key: string) =>
	Buffer.byteLength(`capObjectKey${key}`, "utf8") <= 124
		? { name: "capObjectKey", value: key }
		: { name: "capObjectKeySha256", value: getGoogleDriveObjectKeyHash(key) };

const getGoogleDriveObjectKeyProperties = (
	key: string,
	clearInherited = false,
): Record<string, string | null> => {
	const property = getGoogleDriveObjectKeyProperty(key);
	const properties: Record<string, string | null> = clearInherited
		? { capObjectKey: null, capObjectKeySha256: null }
		: {};
	properties[property.name] = property.value;
	return properties;
};

const googleDriveFileMatchesObjectKey = (
	file: GoogleDriveFile,
	key: string,
) => {
	const properties = file.appProperties;
	if (!properties) return false;
	const keyHash = getGoogleDriveObjectKeyHash(key);
	return (
		(properties.capObjectKey === key ||
			properties.capObjectKeySha256 === keyHash) &&
		(properties.capObjectKey === undefined ||
			properties.capObjectKey === key) &&
		(properties.capObjectKeySha256 === undefined ||
			properties.capObjectKeySha256 === keyHash)
	);
};

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

export const getGoogleDriveAccessToken = (
	config: GoogleDriveIntegrationConfig,
	tokenStore?: GoogleDriveTokenStore,
) => getCachedGoogleDriveAccessToken(config, tokenStore);

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

const getVideoNamesForUpload = (
	repo: StorageRepo,
	input: CreateGoogleDriveUploadInput,
) =>
	Effect.gen(function* () {
		const [ownerId, videoId] = input.key.split("/");
		if (!input.videoId || input.videoId !== videoId) return null;
		if (input.videoTitle !== undefined) {
			return getGoogleDriveVideoNames(input.videoTitle);
		}
		const video = yield* repo.getVideoForNameSync(input.videoId);
		if (
			Option.isNone(video) ||
			video.value.ownerId !== ownerId ||
			video.value.storageIntegrationId !== input.integrationId
		) {
			return null;
		}
		return getGoogleDriveVideoNames(video.value.name);
	}).pipe(Effect.mapError((cause) => new Storage.StorageError({ cause })));

const getNewDriveFileName = (
	repo: StorageRepo,
	input: CreateGoogleDriveUploadInput,
) =>
	Effect.gen(function* () {
		const parts = input.key.split("/");
		if (parts.length === 3 && parts[2] === "result.mp4") {
			const names = yield* getVideoNamesForUpload(repo, input);
			if (names) return names.fileName;
		}
		return getDriveFileName(input.key);
	});

const getDriveFolderParts = (
	key: string,
	config: GoogleDriveIntegrationConfig,
) => {
	const parts = key.split("/").filter(Boolean);
	if (parts.length < 2) return [];
	if (config.folderLayout === "userVideo") {
		if (parts[2] === "segments")
			return [parts[0] as string, parts[1] as string, "segments"];
		return [parts[0] as string, parts[1] as string];
	}

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
		const listUrl = appendSharedDriveListParams(
			`${DRIVE_API_BASE}/files?q=${encodeURIComponent(query)}&fields=files(id,name)&spaces=drive`,
			config,
		);
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
			appendSharedDriveCreateParams(`${DRIVE_API_BASE}/files`),
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

export const getGoogleDriveFolderLocation = (
	config: GoogleDriveIntegrationConfig,
	folderId: string,
	tokenStore?: GoogleDriveTokenStore,
) =>
	driveFetch(
		config,
		appendSharedDriveCreateParams(
			`${DRIVE_API_BASE}/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType,driveId,capabilities(canAddChildren)`,
		),
		undefined,
		tokenStore,
	).pipe(
		Effect.flatMap((response) =>
			Effect.tryPromise({
				try: () =>
					parseDriveJson<{
						id?: string;
						name?: string;
						mimeType?: string;
						driveId?: string;
						capabilities?: { canAddChildren?: boolean };
					}>(response),
				catch: (cause) => new Storage.StorageError({ cause }),
			}),
		),
		Effect.flatMap((folder) => {
			if (
				folder.id &&
				folder.name &&
				folder.mimeType === GOOGLE_DRIVE_FOLDER_MIME_TYPE &&
				folder.capabilities?.canAddChildren !== false
			) {
				return Effect.succeed<GoogleDriveFolderLocation>({
					id: folder.id,
					name: folder.name,
					driveId: folder.driveId ?? null,
				});
			}

			return Effect.fail(
				new Storage.StorageError({
					cause: new Error("Selected Google Drive location is not writable"),
				}),
			);
		}),
	);

const createGoogleDriveFolderWithId = (
	config: GoogleDriveIntegrationConfig,
	id: string,
	name: string,
	parentId: string,
	tokenStore?: GoogleDriveTokenStore,
) =>
	driveFetch(
		config,
		appendSharedDriveCreateParams(`${DRIVE_API_BASE}/files?fields=id,name`),
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
		appendSharedDriveCreateParams(
			`${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,mimeType,size`,
		),
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
	isVideoFolder,
	tokenStore,
}: {
	repo: StorageRepo;
	config: GoogleDriveIntegrationConfig;
	input: CreateGoogleDriveUploadInput;
	folderPath: string;
	name: string;
	parentId: string;
	isVideoFolder: boolean;
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

		yield* Effect.gen(function* () {
			const names = isVideoFolder
				? yield* getVideoNamesForUpload(repo, input)
				: null;
			const displayName = names?.folderName ?? name;
			if (displayName !== name) {
				yield* repo.updateObjectFileName(reserved, displayName);
			}
			yield* createGoogleDriveFolderWithId(
				config,
				folderId,
				displayName,
				parentId,
				tokenStore,
			);
		}).pipe(
			Effect.tapError(() =>
				repo.deleteObjectByKey(input.integrationId, folderObjectKey, folderId),
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
		const folderParts = getDriveFolderParts(input.key, config);
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
				isVideoFolder:
					pathParts.length === (config.folderLayout === "userVideo" ? 2 : 1) &&
					folderName === input.videoId,
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
		const headers: Record<string, string> = {
			"Content-Type": "application/json; charset=UTF-8",
			"X-Upload-Content-Type": contentType,
		};
		if (input.contentLength !== undefined) {
			headers["X-Upload-Content-Length"] = input.contentLength.toString();
		}
		// Google ties the resumable session's Access-Control-Allow-Origin to the
		// Origin sent on this initiation request, so browser direct PUTs are
		// CORS-blocked unless we set it here.
		const browserUploadOrigin = getGoogleDriveBrowserUploadOrigin();
		if (browserUploadOrigin) headers.Origin = browserUploadOrigin;

		const requireUploadUrl = (response: Response) =>
			Option.fromNullable(response.headers.get("Location")).pipe(
				Option.match({
					onNone: () =>
						Effect.fail(
							new Storage.StorageError({
								cause: new Error("Google Drive did not return an upload URL"),
							}),
						),
					onSome: Effect.succeed,
				}),
			);

		const startSessionForExistingFile = (fileId: string) =>
			driveFetch(
				config,
				appendSharedDriveCreateParams(
					`${DRIVE_UPLOAD_BASE}/files/${encodeURIComponent(fileId)}?uploadType=resumable&fields=id,name,mimeType,size,version`,
				),
				{
					method: "PATCH",
					headers,
					body: JSON.stringify({ mimeType: contentType }),
				},
				tokenStore,
			).pipe(Effect.flatMap(requireUploadUrl));

		const startSessionForNewFile = (fileId: string, parentId: string) =>
			Effect.gen(function* () {
				const fileName = yield* getNewDriveFileName(repo, input);
				const uploadUrl = yield* driveFetch(
					config,
					appendSharedDriveCreateParams(
						`${DRIVE_UPLOAD_BASE}/files?uploadType=resumable&fields=id,name,mimeType,size,version`,
					),
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							id: fileId,
							name: fileName,
							mimeType: contentType,
							parents: [parentId],
							appProperties: getGoogleDriveObjectKeyProperties(input.key),
						}),
					},
					tokenStore,
				).pipe(Effect.flatMap(requireUploadUrl));
				return { uploadUrl, fileName };
			});

		const existing = yield* repo.getObjectByKey(input.integrationId, input.key);
		let object: Option.Option.Value<typeof existing>;
		let newReservation = false;
		if (Option.isSome(existing)) {
			object = existing.value;
		} else {
			const fileId = yield* generateGoogleDriveFileId(config, tokenStore);
			object = yield* repo.reserveObject({
				integrationId: input.integrationId,
				ownerId: input.ownerId,
				videoId: input.videoId,
				objectKey: input.key,
				providerObjectId: fileId,
				contentType,
				contentLength: input.contentLength ?? null,
				metadata: {
					videoId: input.videoId ?? undefined,
					fileName: getDriveFileName(input.key),
					contentType,
				},
			});
			newReservation = object.providerObjectId === fileId;
		}

		let resolvedFileId = object.providerObjectId;
		let fileName = object.metadata?.fileName;
		let createdFile = false;
		let uploadUrl: string | undefined;
		if (!newReservation) {
			const patched = yield* startSessionForExistingFile(resolvedFileId).pipe(
				Effect.either,
			);
			if (Either.isRight(patched)) {
				uploadUrl = patched.right;
			} else if (!isDriveRequestStatus(patched.left, 404, 410)) {
				return yield* Effect.fail(patched.left);
			}
		}
		if (uploadUrl === undefined) {
			const parentId = yield* getGoogleDriveUploadParentId(
				repo,
				config,
				input,
				tokenStore,
			);
			const created = yield* startSessionForNewFile(
				resolvedFileId,
				parentId,
			).pipe(Effect.either);
			if (Either.isRight(created)) {
				uploadUrl = created.right.uploadUrl;
				fileName = created.right.fileName;
				createdFile = true;
			} else if (isDriveRequestStatus(created.left, 409)) {
				uploadUrl = yield* startSessionForExistingFile(resolvedFileId);
			} else if (
				!newReservation &&
				object.uploadStatus === "complete" &&
				isDriveRequestStatus(created.left, 400, 404, 410)
			) {
				const freshFileId = yield* generateGoogleDriveFileId(
					config,
					tokenStore,
				);
				const reserved = yield* repo.updateObjectIfCurrent(object, {
					providerObjectId: freshFileId,
					uploadStatus: "pending",
					contentType,
					contentLength: input.contentLength ?? null,
					preserveMetadata: true,
				});
				if (!reserved) {
					return yield* Effect.fail(
						new Storage.StorageError({
							cause: new Error(
								"Storage object changed while reserving a replacement upload; retry",
							),
						}),
					);
				}
				resolvedFileId = freshFileId;
				object = {
					...object,
					providerObjectId: freshFileId,
					uploadStatus: "pending",
				};
				const fresh = yield* startSessionForNewFile(freshFileId, parentId).pipe(
					Effect.either,
				);
				if (Either.isRight(fresh)) {
					uploadUrl = fresh.right.uploadUrl;
					fileName = fresh.right.fileName;
					createdFile = true;
				} else if (isDriveRequestStatus(fresh.left, 409)) {
					uploadUrl = yield* startSessionForExistingFile(freshFileId);
				} else {
					return yield* Effect.fail(fresh.left);
				}
			} else {
				return yield* Effect.fail(created.left);
			}
		}

		const saved = yield* repo.updateObjectIfCurrent(object, {
			providerObjectId: resolvedFileId,
			uploadSessionUrl: uploadUrl,
			uploadStatus: "pending",
			contentType,
			contentLength: input.contentLength ?? null,
			preserveMetadata: !createdFile,
			metadata: {
				...(object.metadata ?? {}),
				videoId: input.videoId ?? undefined,
				fileName,
				contentType,
			},
		});
		if (!saved) {
			return yield* Effect.fail(
				new Storage.StorageError({
					cause: new Error(
						"Storage object changed while starting an upload; retry",
					),
				}),
			);
		}
		return uploadUrl;
	});

export const getGoogleDriveFileMetadata = (
	config: GoogleDriveIntegrationConfig,
	fileId: string,
	tokenStore?: GoogleDriveTokenStore,
) =>
	driveFetch(
		config,
		appendSharedDriveCreateParams(
			`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,version,md5Checksum,parents,trashed,appProperties,capabilities(canRename)`,
		),
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
	const property = getGoogleDriveObjectKeyProperty(key);
	const legacyQuery = `appProperties has { key='capObjectKey' and value='${escapeDriveQueryValue(key)}' }`;
	const query = [
		property.name === "capObjectKey"
			? legacyQuery
			: `(${legacyQuery} or appProperties has { key='capObjectKeySha256' and value='${property.value}' })`,
		"trashed=false",
	].join(" and ");
	const params = new URLSearchParams({
		q: query,
		fields: "files(id,name,mimeType,size,modifiedTime,appProperties)",
		orderBy: "modifiedTime desc",
		pageSize: "10",
		spaces: "drive",
	});

	return driveFetch(
		config,
		appendSharedDriveListParams(
			`${DRIVE_API_BASE}/files?${params.toString()}`,
			config,
		),
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
			const files = (body.files ?? []).filter((file) =>
				googleDriveFileMatchesObjectKey(file, key),
			);
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
		appendSharedDriveCreateParams(
			`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
		),
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
			appendSharedDriveCreateParams(
				`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}?alt=media`,
			),
			{ headers },
			tokenStore,
		);

		return response;
	});

const discardGoogleDriveResponseBody = (response: Response) =>
	Effect.tryPromise({
		try: async () => {
			await response.body?.cancel();
			return response.status;
		},
		catch: (cause) => new Storage.StorageError({ cause }),
	});

const getUsableGoogleDriveFileSize = (file: GoogleDriveFile) => {
	const size = Number(file.size);
	return Number.isSafeInteger(size) && size > 0 ? size : null;
};

const googleDriveFileMatchesTarget = (
	file: GoogleDriveFile,
	input: {
		providerObjectId: string;
		mimeType: string;
		parentId: string | null;
		key: string;
	},
) =>
	input.parentId !== null &&
	file.id === input.providerObjectId &&
	!file.trashed &&
	file.mimeType === input.mimeType &&
	file.parents?.length === 1 &&
	file.parents[0] === input.parentId &&
	(input.mimeType === GOOGLE_DRIVE_FOLDER_MIME_TYPE ||
		googleDriveFileMatchesObjectKey(file, input.key));

export const deleteGoogleDriveFile = (
	config: GoogleDriveIntegrationConfig,
	fileId: string,
	tokenStore?: GoogleDriveTokenStore,
) =>
	driveFetch(
		config,
		appendSharedDriveCreateParams(
			`${DRIVE_API_BASE}/files/${encodeURIComponent(fileId)}`,
		),
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
		const fileName = yield* getNewDriveFileName(repo, input);
		const response = yield* driveFetch(
			config,
			appendSharedDriveCreateParams(
				`${DRIVE_API_BASE}/files/${encodeURIComponent(sourceFileId)}/copy?fields=id,name,mimeType,size`,
			),
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: fileName,
					parents: [parentId],
					appProperties: getGoogleDriveObjectKeyProperties(input.key, true),
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
			metadata: {
				videoId: input.videoId ?? undefined,
				fileName: copied.name ?? fileName,
				contentType: copied.mimeType ?? input.contentType,
			},
		});
	});

export const syncGoogleDriveVideoNames = (
	repo: StorageRepo,
	config: GoogleDriveIntegrationConfig,
	video: {
		id: Video.VideoId;
		ownerId: User.UserId;
		name: string;
		storageIntegrationId: Storage.StorageIntegrationId;
	},
	tokenStore?: GoogleDriveTokenStore,
) =>
	Effect.gen(function* () {
		const names = getGoogleDriveVideoNames(video.name);
		if (!names) {
			return yield* Effect.fail(
				new Storage.StorageError({
					cause: new Error("Video title cannot be used as a Google Drive name"),
				}),
			);
		}
		const integrationId = video.storageIntegrationId;
		const folderKey = getDriveFolderObjectKey(
			config.folderLayout === "userVideo"
				? `${video.ownerId}/${video.id}`
				: video.id,
		);
		const folder = yield* repo.getObjectByKey(integrationId, folderKey);
		const fileKey = `${video.ownerId}/${video.id}/result.mp4`;
		const file = yield* repo.getObjectByKey(integrationId, fileKey);
		let folderParentId = config.folderId;
		if (config.folderLayout === "userVideo" && Option.isSome(folder)) {
			const userFolder = yield* repo.getObjectByKey(
				integrationId,
				getDriveFolderObjectKey(video.ownerId),
			);
			if (
				Option.isNone(userFolder) ||
				userFolder.value.uploadStatus !== "complete"
			) {
				return yield* Effect.fail(
					new Storage.StorageError({
						cause: new Error("Google Drive user folder is not ready"),
					}),
				);
			}
			folderParentId = userFolder.value.providerObjectId;
		}
		const targets = [
			{
				object: folder,
				name: names.folderName,
				key: folderKey,
				parentId: folderParentId,
				mimeType: GOOGLE_DRIVE_FOLDER_MIME_TYPE,
			},
			{
				object: file,
				name: names.fileName,
				key: fileKey,
				parentId: Option.isSome(folder) ? folder.value.providerObjectId : null,
				mimeType: "video/mp4",
			},
		];
		const verifiedTargets: Array<{
			target: (typeof targets)[number];
			object: Option.Option.Value<(typeof targets)[number]["object"]>;
			before: GoogleDriveFile;
		}> = [];
		for (const target of targets) {
			if (Option.isNone(target.object)) continue;
			const object = target.object.value;
			if (
				object.videoId !== video.id ||
				object.integrationId !== integrationId ||
				object.objectKey !== target.key ||
				!target.parentId ||
				(object.uploadStatus !== "complete" &&
					!(object.uploadStatus === "pending" && target.key === fileKey))
			) {
				return yield* Effect.fail(
					new Storage.StorageError({
						cause: new Error("Google Drive name target is not ready"),
					}),
				);
			}
		}
		for (const target of targets) {
			if (Option.isNone(target.object)) continue;
			const object = target.object.value;
			const before = yield* getGoogleDriveFileMetadata(
				config,
				object.providerObjectId,
				tokenStore,
			);
			if (
				!googleDriveFileMatchesTarget(before, {
					providerObjectId: object.providerObjectId,
					mimeType: target.mimeType,
					parentId: target.parentId,
					key: target.key,
				})
			) {
				return yield* Effect.fail(
					new Storage.StorageError({
						cause: new Error("Google Drive name target identity changed"),
					}),
				);
			}
			if (object.uploadStatus === "pending") {
				const usableSize = getUsableGoogleDriveFileSize(before);
				if (
					usableSize === null ||
					(object.contentLength !== null && object.contentLength !== usableSize)
				) {
					return yield* Effect.fail(
						new Storage.StorageError({
							cause: new Error("Google Drive file is not ready to rename"),
						}),
					);
				}
			}
			verifiedTargets.push({ target, object, before });
		}
		for (const { target, object, before } of verifiedTargets) {
			if (before.name !== target.name) {
				if (before.capabilities?.canRename === false) {
					return yield* Effect.fail(
						new Storage.StorageError({
							cause: new Error("Google Drive file cannot be renamed"),
						}),
					);
				}
				const renameResponse = yield* driveFetch(
					config,
					appendSharedDriveCreateParams(
						`${DRIVE_API_BASE}/files/${encodeURIComponent(object.providerObjectId)}?fields=id,name`,
					),
					{
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ name: target.name }),
					},
					tokenStore,
				);
				yield* discardGoogleDriveResponseBody(renameResponse);
				const after = yield* getGoogleDriveFileMetadata(
					config,
					object.providerObjectId,
					tokenStore,
				);
				if (
					after.id !== before.id ||
					after.name !== target.name ||
					after.mimeType !== before.mimeType ||
					after.size !== before.size ||
					after.md5Checksum !== before.md5Checksum ||
					after.trashed !== before.trashed ||
					JSON.stringify(after.parents) !== JSON.stringify(before.parents) ||
					JSON.stringify(after.appProperties) !==
						JSON.stringify(before.appProperties)
				) {
					return yield* Effect.fail(
						new Storage.StorageError({
							cause: new Error("Google Drive name update did not verify"),
						}),
					);
				}
			}
			if (object.metadata?.fileName !== target.name) {
				const updated = yield* repo.updateObjectFileName(object, target.name);
				if (!updated) {
					const current = yield* repo.getObjectByKey(integrationId, target.key);
					if (
						Option.isNone(current) ||
						current.value.id !== object.id ||
						current.value.providerObjectId !== object.providerObjectId ||
						current.value.metadata?.fileName !== target.name
					)
						return false;
				}
			}
		}
		return true;
	}).pipe(Effect.mapError((cause) => new Storage.StorageError({ cause })));

export const parseVideoIdFromObjectKey = (key: string) =>
	Option.fromNullable(key.split("/")[1]).pipe(Option.filter((id) => id !== ""));
