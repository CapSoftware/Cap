import { Readable } from "node:stream";
import { decrypt, encrypt } from "@cap/database/crypto";
import { GoogleDrive } from "@cap/web-domain";
import { Effect, Option } from "effect";

export interface GoogleDriveTokens {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

export interface GoogleDriveUploadResult {
	fileId: string;
	webViewLink: string;
	webContentLink: string;
}

export interface GoogleDriveFileInfo {
	id: string;
	name: string;
	mimeType: string;
	size?: string;
	webViewLink?: string;
	webContentLink?: string;
}

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_API_URL = "https://www.googleapis.com/drive/v3";
const GOOGLE_DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3";

export const createGoogleDriveAccess = (config: {
	clientId: string;
	clientSecret: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	configId: GoogleDrive.GoogleDriveConfigId;
	onTokenRefresh?: (
		accessToken: string,
		expiresAt: number,
	) => Effect.Effect<void>;
}) =>
	Effect.gen(function* () {
		let currentAccessToken = config.accessToken;
		let currentExpiresAt = config.expiresAt;

		const refreshAccessToken = Effect.gen(function* () {
			const response = yield* Effect.tryPromise({
				try: () =>
					fetch(GOOGLE_OAUTH_TOKEN_URL, {
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({
							client_id: config.clientId,
							client_secret: config.clientSecret,
							refresh_token: config.refreshToken,
							grant_type: "refresh_token",
						}),
					}),
				catch: (e) => new GoogleDrive.GoogleDriveError({ cause: e }),
			});

			if (!response.ok) {
				const error = yield* Effect.tryPromise({
					try: () => response.text(),
					catch: (e) => new GoogleDrive.GoogleDriveError({ cause: e }),
				});
				return yield* Effect.fail(
					new GoogleDrive.GoogleDriveError({
						cause: new Error(`Token refresh failed: ${error}`),
					}),
				);
			}

			const data = yield* Effect.tryPromise({
				try: () =>
					response.json() as Promise<{
						access_token: string;
						expires_in: number;
					}>,
				catch: (e) => new GoogleDrive.GoogleDriveError({ cause: e }),
			});

			currentAccessToken = data.access_token;
			currentExpiresAt = Math.floor(Date.now() / 1000) + data.expires_in - 60;

			if (config.onTokenRefresh) {
				yield* config.onTokenRefresh(currentAccessToken, currentExpiresAt);
			}

			return currentAccessToken;
		});

		const getValidAccessToken = Effect.gen(function* () {
			const now = Math.floor(Date.now() / 1000);
			if (currentExpiresAt <= now) {
				return yield* refreshAccessToken;
			}
			return currentAccessToken;
		});

		const makeRequest = <T>(
			path: string,
			options: RequestInit = {},
		): Effect.Effect<T, GoogleDrive.GoogleDriveError> =>
			Effect.gen(function* () {
				const token = yield* getValidAccessToken;
				const response = yield* Effect.tryPromise({
					try: () =>
						fetch(`${GOOGLE_DRIVE_API_URL}${path}`, {
							...options,
							headers: {
								Authorization: `Bearer ${token}`,
								...options.headers,
							},
						}),
					catch: (e) => new GoogleDrive.GoogleDriveError({ cause: e }),
				});

				if (!response.ok) {
					const error = yield* Effect.tryPromise({
						try: () => response.text(),
						catch: (e) => new GoogleDrive.GoogleDriveError({ cause: e }),
					});
					return yield* Effect.fail(
						new GoogleDrive.GoogleDriveError({
							cause: new Error(`API request failed: ${error}`),
						}),
					);
				}

				return yield* Effect.tryPromise({
					try: () => response.json() as Promise<T>,
					catch: (e) => new GoogleDrive.GoogleDriveError({ cause: e }),
				});
			});

		const getUserInfo = Effect.gen(function* () {
			const token = yield* getValidAccessToken;
			const response = yield* Effect.tryPromise({
				try: () =>
					fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
						headers: { Authorization: `Bearer ${token}` },
					}),
				catch: (e) => new GoogleDrive.GoogleDriveError({ cause: e }),
			});

			if (!response.ok) {
				return yield* Effect.fail(
					new GoogleDrive.GoogleDriveError({
						cause: new Error("Failed to get user info"),
					}),
				);
			}

			return yield* Effect.tryPromise({
				try: () => response.json() as Promise<{ email: string; name: string }>,
				catch: (e) => new GoogleDrive.GoogleDriveError({ cause: e }),
			});
		});

		const createFolder = (
			name: string,
			parentId?: string,
		): Effect.Effect<
			{ id: string; name: string },
			GoogleDrive.GoogleDriveError
		> =>
			makeRequest("/files", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name,
					mimeType: "application/vnd.google-apps.folder",
					parents: parentId ? [parentId] : undefined,
				}),
			});

		const listFolders = Effect.gen(function* () {
			const result = yield* makeRequest<{
				files: Array<{ id: string; name: string }>;
			}>(
				"/files?" +
					new URLSearchParams({
						q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
						fields: "files(id, name)",
						pageSize: "100",
					}),
			);
			return result.files;
		});

		const uploadFile = (
			fileName: string,
			mimeType: string,
			data: ArrayBuffer | Uint8Array | Readable,
			folderId?: string,
		): Effect.Effect<GoogleDriveUploadResult, GoogleDrive.GoogleDriveError> =>
			Effect.gen(function* () {
				const token = yield* getValidAccessToken;

				const metadata = {
					name: fileName,
					mimeType,
					parents: folderId ? [folderId] : undefined,
				};

				let body: ArrayBuffer | Uint8Array;
				if (data instanceof Readable) {
					body = yield* Effect.promise(async () => {
						const chunks: Uint8Array[] = [];
						for await (const chunk of data) {
							chunks.push(chunk);
						}
						return Buffer.concat(chunks);
					});
				} else {
					body = data;
				}

				const boundary = "cap_upload_boundary_" + Date.now();
				const delimiter = "\r\n--" + boundary + "\r\n";
				const closeDelimiter = "\r\n--" + boundary + "--";

				const metadataPart = `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}`;
				const mediaPart = `${delimiter}Content-Type: ${mimeType}\r\n\r\n`;

				const encoder = new TextEncoder();
				const metadataBytes = encoder.encode(metadataPart);
				const mediaPartBytes = encoder.encode(mediaPart);
				const closeBytes = encoder.encode(closeDelimiter);

				const bodyData =
					body instanceof ArrayBuffer ? new Uint8Array(body) : body;
				const fullBody = new Uint8Array(
					metadataBytes.length +
						mediaPartBytes.length +
						bodyData.length +
						closeBytes.length,
				);
				fullBody.set(metadataBytes, 0);
				fullBody.set(mediaPartBytes, metadataBytes.length);
				fullBody.set(bodyData, metadataBytes.length + mediaPartBytes.length);
				fullBody.set(
					closeBytes,
					metadataBytes.length + mediaPartBytes.length + bodyData.length,
				);

				const response = yield* Effect.tryPromise({
					try: () =>
						fetch(
							`${GOOGLE_DRIVE_UPLOAD_URL}/files?uploadType=multipart&fields=id,webViewLink,webContentLink`,
							{
								method: "POST",
								headers: {
									Authorization: `Bearer ${token}`,
									"Content-Type": `multipart/related; boundary=${boundary}`,
								},
								body: fullBody,
							},
						),
					catch: (e) => new GoogleDrive.GoogleDriveError({ cause: e }),
				});

				if (!response.ok) {
					const error = yield* Effect.tryPromise({
						try: () => response.text(),
						catch: (e) => new GoogleDrive.GoogleDriveError({ cause: e }),
					});
					return yield* Effect.fail(
						new GoogleDrive.GoogleDriveError({
							cause: new Error(`Upload failed: ${error}`),
						}),
					);
				}

				const result = yield* Effect.tryPromise({
					try: () =>
						response.json() as Promise<{
							id: string;
							webViewLink: string;
							webContentLink: string;
						}>,
					catch: (e) => new GoogleDrive.GoogleDriveError({ cause: e }),
				});

				return {
					fileId: result.id,
					webViewLink: result.webViewLink,
					webContentLink: result.webContentLink,
				};
			});

		const getFile = (
			fileId: string,
		): Effect.Effect<GoogleDriveFileInfo, GoogleDrive.GoogleDriveError> =>
			makeRequest(
				`/files/${fileId}?fields=id,name,mimeType,size,webViewLink,webContentLink`,
			);

		const getFileContent = (
			fileId: string,
		): Effect.Effect<ArrayBuffer, GoogleDrive.GoogleDriveError> =>
			Effect.gen(function* () {
				const token = yield* getValidAccessToken;
				const response = yield* Effect.tryPromise({
					try: () =>
						fetch(`${GOOGLE_DRIVE_API_URL}/files/${fileId}?alt=media`, {
							headers: { Authorization: `Bearer ${token}` },
						}),
					catch: (e) => new GoogleDrive.GoogleDriveError({ cause: e }),
				});

				if (!response.ok) {
					return yield* Effect.fail(
						new GoogleDrive.GoogleDriveError({
							cause: new Error(`Failed to get file content`),
						}),
					);
				}

				return yield* Effect.tryPromise({
					try: () => response.arrayBuffer(),
					catch: (e) => new GoogleDrive.GoogleDriveError({ cause: e }),
				});
			});

		const getSignedUrl = (
			fileId: string,
		): Effect.Effect<string, GoogleDrive.GoogleDriveError> =>
			Effect.gen(function* () {
				const token = yield* getValidAccessToken;
				return `${GOOGLE_DRIVE_API_URL}/files/${fileId}?alt=media&access_token=${encodeURIComponent(token)}`;
			});

		const makeFilePublic = (
			fileId: string,
		): Effect.Effect<void, GoogleDrive.GoogleDriveError> =>
			Effect.gen(function* () {
				const token = yield* getValidAccessToken;
				const response = yield* Effect.tryPromise({
					try: () =>
						fetch(`${GOOGLE_DRIVE_API_URL}/files/${fileId}/permissions`, {
							method: "POST",
							headers: {
								Authorization: `Bearer ${token}`,
								"Content-Type": "application/json",
							},
							body: JSON.stringify({
								type: "anyone",
								role: "reader",
							}),
						}),
					catch: (e) => new GoogleDrive.GoogleDriveError({ cause: e }),
				});

				if (!response.ok) {
					const error = yield* Effect.tryPromise({
						try: () => response.text(),
						catch: (e) => new GoogleDrive.GoogleDriveError({ cause: e }),
					});
					return yield* Effect.fail(
						new GoogleDrive.GoogleDriveError({
							cause: new Error(`Failed to make file public: ${error}`),
						}),
					);
				}
			});

		const deleteFile = (
			fileId: string,
		): Effect.Effect<void, GoogleDrive.GoogleDriveError> =>
			Effect.gen(function* () {
				const token = yield* getValidAccessToken;
				const response = yield* Effect.tryPromise({
					try: () =>
						fetch(`${GOOGLE_DRIVE_API_URL}/files/${fileId}`, {
							method: "DELETE",
							headers: { Authorization: `Bearer ${token}` },
						}),
					catch: (e) => new GoogleDrive.GoogleDriveError({ cause: e }),
				});

				if (!response.ok && response.status !== 404) {
					return yield* Effect.fail(
						new GoogleDrive.GoogleDriveError({
							cause: new Error("Failed to delete file"),
						}),
					);
				}
			});

		return {
			getUserInfo,
			createFolder,
			listFolders,
			uploadFile,
			getFile,
			getFileContent,
			getSignedUrl,
			makeFilePublic,
			deleteFile,
			refreshAccessToken,
		};
	});

export type GoogleDriveAccess = Effect.Effect.Success<
	ReturnType<typeof createGoogleDriveAccess>
>;
