export type RouteAuth = "secret" | "upload";

export type Route = {
	method: "GET" | "POST" | "DELETE";
	path: string;
	auth: RouteAuth;
	query: readonly string[];
	body: readonly string[];
	headers: readonly string[];
};

const REST = "/api/developer/v1";
const SDK = "/api/developer/sdk/v1/upload/multipart";

const route = (
	method: Route["method"],
	path: string,
	auth: RouteAuth,
	fields: {
		query?: readonly string[];
		body?: readonly string[];
		headers?: readonly string[];
	} = {},
): Route => ({
	method,
	path,
	auth,
	query: fields.query ?? [],
	body: fields.body ?? [],
	headers: fields.headers ?? [],
});

const TRANSCRIPT_OPTIONS = ["name", "language", "userId", "metadata"] as const;
const IDEMPOTENCY = ["Idempotency-Key"] as const;

export const ROUTES = {
	listVideos: route("GET", `${REST}/videos`, "secret", {
		query: ["userId", "limit", "offset"],
	}),
	getVideo: route("GET", `${REST}/videos/{id}`, "secret", {
		query: ["userId"],
	}),
	getVideoStatus: route("GET", `${REST}/videos/{id}/status`, "secret", {
		query: ["userId"],
	}),
	deleteVideo: route("DELETE", `${REST}/videos/{id}`, "secret", {
		query: ["userId"],
	}),
	importVideo: route("POST", `${REST}/videos`, "secret", {
		body: ["url", "name", "userId", "maxResolutionTier", "metadata"],
		headers: IDEMPOTENCY,
	}),
	createUpload: route("POST", `${REST}/uploads`, "secret", {
		body: ["name", "userId", "maxResolutionTier", "metadata"],
	}),
	renewUploadToken: route("POST", `${REST}/uploads/{id}/token`, "secret"),
	initiateUpload: route("POST", `${SDK}/initiate`, "upload", {
		body: ["videoId", "contentType", "contentLength"],
	}),
	partUrls: route("POST", `${SDK}/presign-part`, "upload", {
		body: ["videoId", "uploadId", "partNumbers"],
	}),
	completeUpload: route("POST", `${SDK}/complete`, "upload", {
		body: ["videoId", "uploadId", "parts", "durationInSecs"],
	}),
	abortUpload: route("POST", `${SDK}/abort`, "upload", {
		body: ["videoId", "uploadId"],
	}),
	createTranscript: route("POST", `${REST}/transcripts`, "secret", {
		body: ["url", "videoId", ...TRANSCRIPT_OPTIONS],
		headers: IDEMPOTENCY,
	}),
	createTranscriptUpload: route(
		"POST",
		`${REST}/transcripts/uploads`,
		"secret",
		{
			body: ["fileName", "contentLength", ...TRANSCRIPT_OPTIONS],
			headers: IDEMPOTENCY,
		},
	),
	startTranscript: route("POST", `${REST}/transcripts/{id}/start`, "secret"),
	getTranscript: route("GET", `${REST}/transcripts/{id}`, "secret", {
		query: ["include"],
	}),
	listTranscripts: route("GET", `${REST}/transcripts`, "secret", {
		query: ["userId", "status", "limit", "offset"],
	}),
	deleteTranscript: route("DELETE", `${REST}/transcripts/{id}`, "secret"),
	getUsage: route("GET", `${REST}/usage`, "secret"),
	listTransactions: route("GET", `${REST}/transactions`, "secret", {
		query: ["limit", "offset"],
	}),
} as const satisfies Record<string, Route>;

export type RouteName = keyof typeof ROUTES;
