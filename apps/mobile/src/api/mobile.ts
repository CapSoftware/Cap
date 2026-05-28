import { Mobile, type Storage } from "@cap/web-domain";
import { Schema } from "effect";
import * as FileSystem from "expo-file-system/legacy";

export type MobileApiKeyResponse = typeof Mobile.MobileApiKeyResponse.Type;
export type MobileSuccessResponse = typeof Mobile.MobileSuccessResponse.Type;
export type MobileAuthConfigResponse =
	typeof Mobile.MobileAuthConfigResponse.Type;
export type MobileBootstrapResponse =
	typeof Mobile.MobileBootstrapResponse.Type;
export type MobileCapsListResponse = typeof Mobile.MobileCapsListResponse.Type;
export type MobileCapSummary = typeof Mobile.MobileCapSummary.Type;
export type MobileFolder = typeof Mobile.MobileFolder.Type;
export type MobileCapDetail = typeof Mobile.MobileCapDetail.Type;
export type MobileComment = typeof Mobile.MobileComment.Type;
export type MobilePlaybackResponse = typeof Mobile.MobilePlaybackResponse.Type;
export type MobileDownloadResponse = typeof Mobile.MobileDownloadResponse.Type;
export type MobileCapSharingInput = typeof Mobile.MobileCapSharingInput.Type;
export type MobileCapTitleInput = typeof Mobile.MobileCapTitleInput.Type;
export type MobileCapPasswordInput = typeof Mobile.MobileCapPasswordInput.Type;
export type MobileFolderCreateInput =
	typeof Mobile.MobileFolderCreateInput.Type;
export type MobileUploadCreateInput =
	typeof Mobile.MobileUploadCreateInput.Type;
export type MobileUploadCreateResponse =
	typeof Mobile.MobileUploadCreateResponse.Type;

export type MobileApiClient = ReturnType<typeof createMobileApiClient>;

export type UploadFile = {
	uri: string;
	name: string;
	type: string;
	size?: number;
	durationSeconds?: number;
	width?: number;
	height?: number;
};

export type UploadProgress = {
	loaded: number;
	total: number;
};

type ClientOptions = {
	baseUrl: string;
	getToken: () => string | Promise<string | null> | null;
};

type RequestOptions = {
	method?: "GET" | "POST" | "PATCH" | "DELETE";
	query?: Record<string, string | number | null | undefined>;
	body?: unknown;
};

export class MobileApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly payload: unknown,
	) {
		super(message);
		this.name = "MobileApiError";
	}
}

const trimBaseUrl = (baseUrl: string) => baseUrl.replace(/\/+$/, "");

const decode = async <A, I>(
	schema: Schema.Schema<A, I, never>,
	value: unknown,
): Promise<A> => Schema.decodeUnknownPromise(schema)(value);

const appendQuery = (
	url: URL,
	query: Record<string, string | number | null | undefined> | undefined,
) => {
	if (!query) return;
	for (const [key, value] of Object.entries(query)) {
		if (value !== null && value !== undefined && value !== "") {
			url.searchParams.set(key, String(value));
		}
	}
};

const parseJson = async (response: Response) => {
	const text = await response.text();
	if (text.length === 0) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
};

export const createSessionRequestUrl = (
	baseUrl: string,
	redirectUri: string,
	provider?: "google" | "workos",
	organizationId?: string,
) => {
	const url = new URL("/api/mobile/session/request", trimBaseUrl(baseUrl));
	url.searchParams.set("redirectUri", redirectUri);
	if (provider) url.searchParams.set("provider", provider);
	if (organizationId) url.searchParams.set("organizationId", organizationId);
	return url.toString();
};

export const createMobileApiClient = ({ baseUrl, getToken }: ClientOptions) => {
	const origin = trimBaseUrl(baseUrl);

	const request = async <A, I>(
		path: string,
		schema: Schema.Schema<A, I, never>,
		options: RequestOptions = {},
	): Promise<A> => {
		const token = await getToken();
		if (!token) {
			throw new MobileApiError("Missing mobile session", 401, null);
		}

		const url = new URL(path, origin);
		appendQuery(url, options.query);
		const headers = new Headers({
			Authorization: `Bearer ${token}`,
		});
		let body: BodyInit | undefined;
		if (options.body !== undefined) {
			headers.set("Content-Type", "application/json");
			body = JSON.stringify(options.body);
		}

		const response = await fetch(url.toString(), {
			method: options.method ?? "GET",
			headers,
			body,
		});
		const payload = await parseJson(response);
		if (!response.ok) {
			throw new MobileApiError(
				`Mobile API request failed with ${response.status}`,
				response.status,
				payload,
			);
		}
		return decode(schema, payload);
	};

	const publicRequest = async <A, I>(
		path: string,
		schema: Schema.Schema<A, I, never>,
		options: Omit<RequestOptions, "query"> = {},
	): Promise<A> => {
		const url = new URL(path, origin);
		const headers = new Headers();
		let body: BodyInit | undefined;
		if (options.body !== undefined) {
			headers.set("Content-Type", "application/json");
			body = JSON.stringify(options.body);
		}

		const response = await fetch(url.toString(), {
			method: options.method ?? "GET",
			headers,
			body,
		});
		const payload = await parseJson(response);
		if (!response.ok) {
			throw new MobileApiError(
				`Mobile API request failed with ${response.status}`,
				response.status,
				payload,
			);
		}
		return decode(schema, payload);
	};

	return {
		getAuthConfig: () =>
			publicRequest(
				"/api/mobile/session/config",
				Mobile.MobileAuthConfigResponse,
			),
		requestEmailCode: (email: string) =>
			publicRequest(
				"/api/mobile/session/email/request",
				Mobile.MobileSuccessResponse,
				{
					method: "POST",
					body: { email },
				},
			),
		verifyEmailCode: (input: { email: string; code: string }) =>
			publicRequest(
				"/api/mobile/session/email/verify",
				Mobile.MobileApiKeyResponse,
				{
					method: "POST",
					body: input,
				},
			),
		bootstrap: () =>
			request("/api/mobile/bootstrap", Mobile.MobileBootstrapResponse),
		setActiveOrganization: (organizationId: string) =>
			request(
				"/api/mobile/user/active-organization",
				Mobile.MobileBootstrapResponse,
				{
					method: "PATCH",
					body: { organizationId },
				},
			),
		listCaps: (params: {
			folderId?: string | null;
			page?: number;
			limit?: number;
		}) =>
			request("/api/mobile/caps", Mobile.MobileCapsListResponse, {
				query: params,
			}),
		createFolder: (input: MobileFolderCreateInput) =>
			request("/api/mobile/folders", Mobile.MobileFolder, {
				method: "POST",
				body: input,
			}),
		getCap: (id: string) =>
			request(`/api/mobile/caps/${id}`, Mobile.MobileCapDetail),
		updateCapSharing: (id: string, input: MobileCapSharingInput) =>
			request(`/api/mobile/caps/${id}/sharing`, Mobile.MobileCapSummary, {
				method: "PATCH",
				body: input,
			}),
		updateCapTitle: (id: string, input: MobileCapTitleInput) =>
			request(`/api/mobile/caps/${id}/title`, Mobile.MobileCapSummary, {
				method: "PATCH",
				body: input,
			}),
		updateCapPassword: (id: string, input: MobileCapPasswordInput) =>
			request(`/api/mobile/caps/${id}/password`, Mobile.MobileCapSummary, {
				method: "PATCH",
				body: input,
			}),
		deleteCap: (id: string) =>
			request(`/api/mobile/caps/${id}`, Mobile.MobileSuccessResponse, {
				method: "DELETE",
			}),
		getPlayback: (id: string) =>
			request(`/api/mobile/caps/${id}/playback`, Mobile.MobilePlaybackResponse),
		getDownload: (id: string) =>
			request(`/api/mobile/caps/${id}/download`, Mobile.MobileDownloadResponse),
		createComment: (
			id: string,
			input: { content: string; timestamp: number | null },
		) =>
			request(`/api/mobile/caps/${id}/comments`, Mobile.MobileComment, {
				method: "POST",
				body: input,
			}),
		deleteComment: (id: string) =>
			request(`/api/mobile/comments/${id}`, Mobile.MobileSuccessResponse, {
				method: "DELETE",
			}),
		createReaction: (
			id: string,
			input: { content: string; timestamp: number | null },
		) =>
			request(`/api/mobile/caps/${id}/reactions`, Mobile.MobileComment, {
				method: "POST",
				body: input,
			}),
		createUpload: (input: MobileUploadCreateInput) =>
			request("/api/mobile/uploads", Mobile.MobileUploadCreateResponse, {
				method: "POST",
				body: input,
			}),
		updateUploadProgress: (
			id: string,
			input: { uploaded: number; total: number },
		) =>
			request(
				`/api/mobile/uploads/${id}/progress`,
				Mobile.MobileSuccessResponse,
				{
					method: "POST",
					body: input,
				},
			),
		completeUpload: (
			id: string,
			input: { rawFileKey: string; contentLength?: number },
		) =>
			request(
				`/api/mobile/uploads/${id}/complete`,
				Mobile.MobileSuccessResponse,
				{
					method: "POST",
					body: input,
				},
			),
		revokeSession: () =>
			request("/api/mobile/session/revoke", Mobile.MobileSuccessResponse, {
				method: "POST",
			}),
	};
};

const targetHeaders = (headers: Record<string, string>) => {
	const result = new Headers();
	for (const [key, value] of Object.entries(headers)) {
		result.set(key, value);
	}
	return result;
};

const isNativeUploadUri = (uri: string) =>
	uri.startsWith("file://") || uri.startsWith("content://");

const getLocalFileSize = async (file: UploadFile) => {
	if (typeof file.size === "number" && file.size > 0) return file.size;

	const info = await FileSystem.getInfoAsync(file.uri);
	if (!info.exists || info.isDirectory) return 0;
	return info.size;
};

const uploadNativeFile = async (
	method: "POST" | "PUT",
	url: string,
	file: UploadFile,
	options: FileSystem.FileSystemUploadOptions,
	onProgress?: (progress: UploadProgress) => void,
) => {
	const task = FileSystem.createUploadTask(
		url,
		file.uri,
		{
			...options,
			httpMethod: method,
		},
		(data) => {
			onProgress?.({
				loaded: data.totalBytesSent,
				total: data.totalBytesExpectedToSend,
			});
		},
	);
	const response = await task.uploadAsync();
	if (!response || response.status < 200 || response.status >= 300) {
		throw new MobileApiError(
			"Upload target rejected the file",
			response?.status ?? 0,
			response?.body ?? null,
		);
	}
};

const uploadWithXhr = (
	method: "POST" | "PUT",
	url: string,
	headers: Headers,
	body: FormData | Blob,
	onProgress?: (progress: UploadProgress) => void,
) =>
	new Promise<void>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open(method, url);
		headers.forEach((value, key) => {
			xhr.setRequestHeader(key, value);
		});
		xhr.upload.onprogress = (event) => {
			onProgress?.({
				loaded: event.loaded,
				total: event.lengthComputable ? event.total : 0,
			});
		};
		xhr.onload = () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				resolve();
				return;
			}
			reject(
				new MobileApiError(
					"Upload target rejected the file",
					xhr.status,
					xhr.responseText,
				),
			);
		};
		xhr.onerror = () => {
			reject(new Error("Upload failed"));
		};
		xhr.send(body);
	});

const fileBlob = async (file: UploadFile) => {
	const response = await fetch(file.uri);
	return response.blob();
};

export const uploadToTarget = async (
	target: Storage.UploadTarget,
	file: UploadFile,
	onProgress?: (progress: UploadProgress) => void,
) => {
	if (target.type === "s3Post") {
		if (isNativeUploadUri(file.uri)) {
			await uploadNativeFile(
				"POST",
				target.url,
				file,
				{
					fieldName: "file",
					mimeType: file.type,
					parameters: target.fields,
					uploadType: FileSystem.FileSystemUploadType.MULTIPART,
				},
				onProgress,
			);
			return;
		}

		const formData = new FormData();
		for (const [key, value] of Object.entries(target.fields)) {
			formData.append(key, value);
		}
		formData.append("file", {
			uri: file.uri,
			name: file.name,
			type: file.type,
		} as unknown as Blob);
		await uploadWithXhr(
			"POST",
			target.url,
			new Headers(),
			formData,
			onProgress,
		);
		return;
	}

	const headers = { ...target.headers };
	let size = file.size;
	if (
		target.type === "driveResumable" &&
		typeof size === "number" &&
		size > 0
	) {
		headers["Content-Range"] = `bytes 0-${size - 1}/${size}`;
	}

	if (isNativeUploadUri(file.uri)) {
		if (target.type === "driveResumable" && !size) {
			size = await getLocalFileSize(file);
			if (size > 0) {
				headers["Content-Range"] = `bytes 0-${size - 1}/${size}`;
			}
		}

		await uploadNativeFile(
			"PUT",
			target.url,
			file,
			{
				headers,
				uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
			},
			onProgress,
		);
		return;
	}

	const blob = await fileBlob(file);
	if (target.type === "driveResumable" && !size && blob.size > 0) {
		headers["Content-Range"] = `bytes 0-${blob.size - 1}/${blob.size}`;
	}
	await uploadWithXhr(
		"PUT",
		target.url,
		targetHeaders(headers),
		blob,
		onProgress,
	);
};
