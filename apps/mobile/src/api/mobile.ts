import type { Mobile, Storage } from "@cap/web-domain";
import * as FileSystem from "expo-file-system/legacy";

export type MobileApiKeyResponse = typeof Mobile.MobileApiKeyResponse.Type;
export type MobileSuccessResponse = typeof Mobile.MobileSuccessResponse.Type;
export type MobileAuthConfigResponse =
	typeof Mobile.MobileAuthConfigResponse.Type;
export type MobileBootstrapResponse =
	typeof Mobile.MobileBootstrapResponse.Type;
export type MobileUser = typeof Mobile.MobileUser.Type;
export type MobileProfileInput = typeof Mobile.MobileProfileInput.Type;
export type MobileProfileImageInput =
	typeof Mobile.MobileProfileImageInput.Type;
export type MobileCapsListResponse = typeof Mobile.MobileCapsListResponse.Type;
export type MobileCapStatusesResponse =
	typeof Mobile.MobileCapStatusesResponse.Type;
export type MobileCapSummary = typeof Mobile.MobileCapSummary.Type;
export type MobileFolder = typeof Mobile.MobileFolder.Type;
export type MobileSpace = typeof Mobile.MobileSpace.Type;
export type MobileCapDetail = typeof Mobile.MobileCapDetail.Type;
export type MobileComment = typeof Mobile.MobileComment.Type;
export type MobilePlaybackResponse = typeof Mobile.MobilePlaybackResponse.Type;
export type MobileDownloadResponse = typeof Mobile.MobileDownloadResponse.Type;
export type MobileAnalyticsRange = typeof Mobile.MobileAnalyticsRange.Type;
export type MobileAnalyticsData = typeof Mobile.MobileAnalyticsData.Type;
export type MobileAnalyticsResponse =
	typeof Mobile.MobileAnalyticsResponse.Type;
export type MobileOrganizationSettings =
	typeof Mobile.MobileOrganizationSettings.Type;
export type MobileOrganizationSettingsInput =
	typeof Mobile.MobileOrganizationSettingsInput.Type;
export type MobileOrganizationIconInput =
	typeof Mobile.MobileOrganizationIconInput.Type;
export type MobileLoomImportResponse =
	typeof Mobile.MobileLoomImportResponse.Type;
export type MobileCapSharingInput = typeof Mobile.MobileCapSharingInput.Type;
export type MobileCapTitleInput = typeof Mobile.MobileCapTitleInput.Type;
export type MobileCapPasswordInput = typeof Mobile.MobileCapPasswordInput.Type;
export type MobileFolderCreateInput =
	typeof Mobile.MobileFolderCreateInput.Type;
type ContractMobileUploadCreateInput =
	typeof Mobile.MobileUploadCreateInput.Type;
export type MobileUploadCreateInput = Omit<
	ContractMobileUploadCreateInput,
	"organizationId" | "folderId"
> & {
	organizationId?: string;
	folderId?: string;
};
export type MobileUploadCreateResponse =
	typeof Mobile.MobileUploadCreateResponse.Type;
export type MobileRecordingCreateInput =
	typeof Mobile.MobileRecordingCreateInput.Type;
export type MobileRecordingCreateResponse =
	typeof Mobile.MobileRecordingCreateResponse.Type;
export type MobileRecordingUploadTargetsResponse =
	typeof Mobile.MobileRecordingUploadTargetsResponse.Type;
export type MobileRecordingCompleteInput =
	typeof Mobile.MobileRecordingCompleteInput.Type;
export type MobileContentReportReason =
	(typeof Mobile.MobileContentReportInput.Type)["reason"];

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
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
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

const responseObject = <A>(value: unknown): A => {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new MobileApiError(
			"Mobile API returned an invalid response",
			502,
			value,
		);
	}
	return value as A;
};

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
	provider?: "apple" | "google" | "workos",
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

	const request = async <A>(
		path: string,
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
		return responseObject<A>(payload);
	};

	const publicRequest = async <A>(
		path: string,
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
		return responseObject<A>(payload);
	};

	return {
		getAuthConfig: () =>
			publicRequest<MobileAuthConfigResponse>("/api/mobile/session/config"),
		requestEmailCode: (email: string) =>
			publicRequest<MobileSuccessResponse>(
				"/api/mobile/session/email/request",
				{
					method: "POST",
					body: { email },
				},
			),
		verifyEmailCode: (input: { email: string; code: string }) =>
			publicRequest<MobileApiKeyResponse>("/api/mobile/session/email/verify", {
				method: "POST",
				body: input,
			}),
		bootstrap: () => request<MobileBootstrapResponse>("/api/mobile/bootstrap"),
		requestAccountDeletion: () =>
			request<MobileSuccessResponse>("/api/mobile/user/account-deletion", {
				method: "POST",
				body: { confirmation: "DELETE" },
			}),
		blockUser: (userId: string) =>
			request<MobileSuccessResponse>("/api/mobile/user/blocks", {
				method: "POST",
				body: { userId },
			}),
		setActiveOrganization: (organizationId: string) =>
			request<MobileBootstrapResponse>("/api/mobile/user/active-organization", {
				method: "PATCH",
				body: { organizationId },
			}),
		updateProfile: (input: MobileProfileInput) =>
			request<MobileUser>("/api/mobile/user/profile", {
				method: "PATCH",
				body: input,
			}),
		updateProfileImage: (input: MobileProfileImageInput) =>
			request<MobileUser>("/api/mobile/user/profile/image", {
				method: "PUT",
				body: input,
			}),
		removeProfileImage: () =>
			request<MobileUser>("/api/mobile/user/profile/image", {
				method: "DELETE",
			}),
		listCaps: (params: {
			folderId?: string | null;
			spaceId?: string | null;
			page?: number;
			limit?: number;
		}) =>
			request<MobileCapsListResponse>("/api/mobile/caps", {
				query: params,
			}),
		getCapStatuses: (ids: readonly string[]) =>
			request<MobileCapStatusesResponse>("/api/mobile/caps/statuses", {
				method: "POST",
				body: { ids },
			}),
		createFolder: (input: MobileFolderCreateInput) =>
			request<MobileFolder>("/api/mobile/folders", {
				method: "POST",
				body: input,
			}),
		getCap: (id: string) =>
			request<MobileCapDetail>(`/api/mobile/caps/${encodeURIComponent(id)}`),
		reportCap: (id: string, reason: MobileContentReportReason) =>
			request<MobileSuccessResponse>(
				`/api/mobile/caps/${encodeURIComponent(id)}/report`,
				{
					method: "POST",
					body: { reason },
				},
			),
		updateCapSharing: (id: string, input: MobileCapSharingInput) =>
			request<MobileCapSummary>(
				`/api/mobile/caps/${encodeURIComponent(id)}/sharing`,
				{
					method: "PATCH",
					body: input,
				},
			),
		updateCapTitle: (id: string, input: MobileCapTitleInput) =>
			request<MobileCapSummary>(
				`/api/mobile/caps/${encodeURIComponent(id)}/title`,
				{
					method: "PATCH",
					body: input,
				},
			),
		updateCapPassword: (id: string, input: MobileCapPasswordInput) =>
			request<MobileCapSummary>(
				`/api/mobile/caps/${encodeURIComponent(id)}/password`,
				{
					method: "PATCH",
					body: input,
				},
			),
		deleteCap: (id: string) =>
			request<MobileSuccessResponse>(
				`/api/mobile/caps/${encodeURIComponent(id)}`,
				{
					method: "DELETE",
				},
			),
		getPlayback: (id: string) =>
			request<MobilePlaybackResponse>(
				`/api/mobile/caps/${encodeURIComponent(id)}/playback`,
			),
		getDownload: (id: string) =>
			request<MobileDownloadResponse>(
				`/api/mobile/caps/${encodeURIComponent(id)}/download`,
			),
		getCapAnalytics: (id: string, range: MobileAnalyticsRange) =>
			request<MobileAnalyticsResponse>(
				`/api/mobile/caps/${encodeURIComponent(id)}/analytics`,
				{ query: { range } },
			),
		getOrganizationSettings: () =>
			request<MobileOrganizationSettings>("/api/mobile/organization/settings"),
		updateOrganizationSettings: (input: MobileOrganizationSettingsInput) =>
			request<MobileOrganizationSettings>("/api/mobile/organization/settings", {
				method: "PATCH",
				body: input,
			}),
		updateOrganizationIcon: (input: MobileOrganizationIconInput) =>
			request<MobileOrganizationSettings>(
				"/api/mobile/organization/settings/icon",
				{
					method: "PUT",
					body: input,
				},
			),
		removeOrganizationIcon: () =>
			request<MobileOrganizationSettings>(
				"/api/mobile/organization/settings/icon",
				{ method: "DELETE" },
			),
		importLoom: (loomUrl: string) =>
			request<MobileLoomImportResponse>("/api/mobile/imports/loom", {
				method: "POST",
				body: { loomUrl },
			}),
		createComment: (
			id: string,
			input: { content: string; timestamp: number | null },
		) =>
			request<MobileComment>(
				`/api/mobile/caps/${encodeURIComponent(id)}/comments`,
				{
					method: "POST",
					body: input,
				},
			),
		deleteComment: (id: string) =>
			request<MobileSuccessResponse>(
				`/api/mobile/comments/${encodeURIComponent(id)}`,
				{
					method: "DELETE",
				},
			),
		createReaction: (
			id: string,
			input: { content: string; timestamp: number | null },
		) =>
			request<MobileComment>(
				`/api/mobile/caps/${encodeURIComponent(id)}/reactions`,
				{
					method: "POST",
					body: input,
				},
			),
		createUpload: (input: MobileUploadCreateInput) =>
			request<MobileUploadCreateResponse>("/api/mobile/uploads", {
				method: "POST",
				body: input,
			}),
		updateUploadProgress: (
			id: string,
			input: { uploaded: number; total: number },
		) =>
			request<MobileSuccessResponse>(
				`/api/mobile/uploads/${encodeURIComponent(id)}/progress`,
				{
					method: "POST",
					body: input,
				},
			),
		completeUpload: (
			id: string,
			input: { rawFileKey: string; contentLength?: number },
		) =>
			request<MobileSuccessResponse>(
				`/api/mobile/uploads/${encodeURIComponent(id)}/complete`,
				{
					method: "POST",
					body: input,
				},
			),
		createRecording: (input: MobileRecordingCreateInput) =>
			request<MobileRecordingCreateResponse>("/api/mobile/recordings", {
				method: "POST",
				body: input,
			}),
		createRecordingUploadTargets: (id: string, subpaths: string[]) =>
			request<MobileRecordingUploadTargetsResponse>(
				`/api/mobile/recordings/${encodeURIComponent(id)}/segments/targets`,
				{
					method: "POST",
					body: { subpaths },
				},
			),
		completeRecording: (id: string, input: MobileRecordingCompleteInput) =>
			request<MobileSuccessResponse>(
				`/api/mobile/recordings/${encodeURIComponent(id)}/complete`,
				{
					method: "POST",
					body: input,
				},
			),
		revokeSession: () =>
			request<MobileSuccessResponse>("/api/mobile/session/revoke", {
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
	const info = await FileSystem.getInfoAsync(file.uri);
	if (!info.exists || info.isDirectory) {
		throw new Error("The recording file is no longer available.");
	}
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
