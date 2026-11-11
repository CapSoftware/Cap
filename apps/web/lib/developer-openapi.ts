import { API_DOCS_URL } from "@/lib/api-errors";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const response = (name: string) => ({ $ref: `#/components/responses/${name}` });

const json = (schema: object, description: string) => ({
	description,
	content: { "application/json": { schema } },
});

const jsonBody = (name: string) => ({
	required: true,
	content: { "application/json": { schema: ref(name) } },
});

const dataEnvelope = (schema: object) => ({
	type: "object",
	required: ["data"],
	properties: { data: schema },
});

const videoIdParam = {
	name: "id",
	in: "path",
	required: true,
	description: "Developer video ID returned by createSdkVideo.",
	schema: { type: "string" },
};

const transcriptIdParam = {
	name: "id",
	in: "path",
	required: true,
	description: "Transcript ID returned when the transcript was created.",
	schema: { type: "string" },
};

const idempotencyKeyParam = {
	name: "Idempotency-Key",
	in: "header",
	required: false,
	description:
		"8 to 128 characters. Repeating a create request with the same key returns the same transcript instead of creating and billing a second one.",
	schema: { type: "string", minLength: 8, maxLength: 128 },
};

const transcriptOptionProperties = {
	name: {
		type: "string",
		maxLength: 255,
		description: "Display name. Defaults to the file name.",
	},
	language: {
		type: "string",
		description:
			'Two-letter language code such as "en", or "auto" to detect it. Defaults to "auto".',
	},
	userId: {
		type: "string",
		maxLength: 255,
		description: "Your own identifier for the end user, used to filter lists.",
	},
	metadata: {
		type: "object",
		additionalProperties: true,
		description: "Your own JSON object, under 8KB.",
	},
};

const transcriptSchema = {
	type: "object",
	required: [
		"id",
		"status",
		"name",
		"source",
		"costMicroCredits",
		"costDollars",
		"createdAt",
		"updatedAt",
	],
	properties: {
		id: { type: "string" },
		status: {
			type: "string",
			enum: ["uploading", "queued", "processing", "complete", "error"],
			description:
				"uploading waits for the file. queued and processing are in progress. complete and error are final.",
		},
		name: { type: "string" },
		source: {
			type: "object",
			required: ["type"],
			properties: {
				type: { type: "string", enum: ["upload", "url"] },
				url: { type: ["string", "null"] },
			},
		},
		durationSeconds: {
			type: ["number", "null"],
			description: "Measured audio length. Set when the transcript finishes.",
		},
		language: { type: ["string", "null"] },
		wordCount: { type: ["integer", "null"] },
		text: {
			type: ["string", "null"],
			description:
				"The transcript text. Returned by getTranscript once status is complete.",
		},
		costMicroCredits: {
			type: "integer",
			description:
				"Credits charged for this transcript. 0 until it completes, and 0 for failed transcripts. Audio length is measured by Cap and billed to the nearest second.",
		},
		costDollars: { type: "number" },
		error: {
			type: ["object", "null"],
			properties: {
				code: { type: "string" },
				message: { type: "string" },
			},
		},
		userId: { type: ["string", "null"] },
		metadata: { type: ["object", "null"], additionalProperties: true },
		createdAt: { type: "string", format: "date-time" },
		updatedAt: { type: "string", format: "date-time" },
		completedAt: { type: ["string", "null"], format: "date-time" },
	},
};

const secretAuth = [{ secretKey: [] }];
const publicAuth = [{ publicKey: [] }];

const restErrors = {
	"401": response("Unauthorized"),
	"429": response("RateLimited"),
	"500": response("InternalError"),
};

const sdkErrors = {
	"400": response("BadRequest"),
	"401": response("Unauthorized"),
	"403": response("Forbidden"),
	"404": response("NotFound"),
	"429": response("RateLimited"),
	"500": response("InternalError"),
};

const errorSchema = {
	type: "object",
	required: ["error"],
	properties: {
		error: {
			type: "string",
			description: "Human-readable error message.",
		},
		code: {
			type: "string",
			description:
				"Stable machine-readable error code, such as invalid_secret_key, rate_limited or not_found.",
		},
		message: {
			type: "string",
			description: "Same text as error.",
		},
		hint: {
			type: "string",
			description: "What to change before retrying.",
		},
		docs: {
			type: "string",
			format: "uri",
			description: "Documentation for this API.",
		},
	},
};

const developerVideoSchema = {
	type: "object",
	required: ["id", "appId", "name", "createdAt", "updatedAt"],
	properties: {
		id: { type: "string", description: "Developer video ID." },
		appId: { type: "string", description: "Developer app that owns it." },
		externalUserId: {
			type: ["string", "null"],
			description: "Your user ID, as passed to createSdkVideo.",
		},
		name: { type: "string", description: "Video name." },
		duration: {
			type: ["number", "null"],
			description: "Duration in seconds, set when the upload completes.",
		},
		width: { type: ["integer", "null"], description: "Width in pixels." },
		height: { type: ["integer", "null"], description: "Height in pixels." },
		fps: { type: ["integer", "null"], description: "Frames per second." },
		s3Key: {
			type: ["string", "null"],
			description: "Storage key of the uploaded file.",
		},
		transcriptionStatus: {
			type: ["string", "null"],
			enum: ["PROCESSING", "COMPLETE", "ERROR", "SKIPPED", "NO_AUDIO", null],
			description: "Transcription state, when transcription applies.",
		},
		metadata: {
			type: ["object", "null"],
			additionalProperties: true,
			description: "Metadata passed to createSdkVideo.",
		},
		deletedAt: {
			type: ["string", "null"],
			format: "date-time",
			description: "Always null for videos returned by this API.",
		},
		createdAt: { type: "string", format: "date-time" },
		updatedAt: { type: "string", format: "date-time" },
	},
};

export const developerOpenApiSpec = (baseUrl: string) => ({
	openapi: "3.1.0",
	info: {
		title: "Cap Developer API",
		version: "1.0.0",
		summary: "Create, upload and manage videos recorded through Cap.",
		description: [
			"The Cap Developer API lets your product record, upload and manage videos with Cap.",
			"",
			"Use the SDK operations (public `cpk_` key, safe in browsers) to create a video and upload it with S3 multipart upload: createSdkVideo, initiateSdkUpload, presignSdkUploadPart for each part, then completeSdkUpload.",
			"Use the REST operations (secret `csk_` key, server-side only) to list, inspect and delete videos and read credit usage.",
			"",
			"Create a developer app and its keys at https://cap.so/dashboard/infra. Development apps accept any origin, so use one to test before switching to a production app with allowed domains.",
			"",
			"Authentication, origin, rate-limit, unknown-route and unexpected errors include `error`, `code`, `message`, `hint` and `docs` fields. Other handler errors may include only `error`; request-body validation errors return `success: false` with the failing fields. Each key is limited to 60 requests per minute; a 429 response carries Retry-After.",
		].join("\n"),
		termsOfService: "https://cap.so/terms",
		contact: { name: "Cap", email: "hello@cap.so", url: "https://cap.so" },
	},
	externalDocs: { description: "REST API guide", url: API_DOCS_URL },
	servers: [{ url: baseUrl, description: "Cap" }],
	tags: [
		{
			name: "Videos",
			description: "Manage developer videos (secret key).",
		},
		{
			name: "Transcripts",
			description: "Turn audio or video into text (secret key).",
		},
		{
			name: "Usage",
			description: "Credit balance and totals (secret key).",
		},
		{
			name: "SDK",
			description: "Create and upload videos (public key).",
		},
	],
	paths: {
		"/api/developer/v1/videos": {
			get: {
				operationId: "listDeveloperVideos",
				summary: "List videos",
				description:
					"Lists the app's videos, newest first. Filter by your own user ID and page with limit and offset.",
				tags: ["Videos"],
				security: secretAuth,
				parameters: [
					{
						name: "userId",
						in: "query",
						required: false,
						description: "Only return videos created with this userId.",
						schema: { type: "string", maxLength: 255 },
					},
					{
						name: "limit",
						in: "query",
						required: false,
						description: "Maximum videos to return.",
						schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
					},
					{
						name: "offset",
						in: "query",
						required: false,
						description: "Number of videos to skip.",
						schema: { type: "integer", minimum: 0, default: 0 },
					},
				],
				responses: {
					"200": json(
						{
							type: "object",
							required: ["data"],
							properties: {
								data: { type: "array", items: ref("DeveloperVideo") },
							},
						},
						"The app's videos.",
					),
					...restErrors,
				},
			},
		},
		"/api/developer/v1/videos/{id}": {
			get: {
				operationId: "getDeveloperVideo",
				summary: "Get a video",
				description: "Returns one video owned by the app.",
				tags: ["Videos"],
				security: secretAuth,
				parameters: [videoIdParam],
				responses: {
					"200": json(dataEnvelope(ref("DeveloperVideo")), "The video."),
					"404": response("NotFound"),
					...restErrors,
				},
			},
			delete: {
				operationId: "deleteDeveloperVideo",
				summary: "Delete a video",
				description:
					"Deletes a video owned by the app. It stops appearing in list and get results.",
				tags: ["Videos"],
				security: secretAuth,
				parameters: [videoIdParam],
				responses: {
					"200": json(ref("Success"), "The video was deleted."),
					"404": response("NotFound"),
					...restErrors,
				},
			},
		},
		"/api/developer/v1/videos/{id}/status": {
			get: {
				operationId: "getDeveloperVideoStatus",
				summary: "Get video status",
				description:
					"Returns whether the video is ready to play, with its dimensions, duration and transcription state. Poll this after completeSdkUpload.",
				tags: ["Videos"],
				security: secretAuth,
				parameters: [videoIdParam],
				responses: {
					"200": json(dataEnvelope(ref("VideoStatus")), "The video status."),
					"404": response("NotFound"),
					...restErrors,
				},
			},
		},
		"/api/developer/v1/transcripts": {
			get: {
				operationId: "listTranscripts",
				summary: "List transcripts",
				description:
					"Returns the app's transcripts, newest first, without their text. Paginate with limit and offset until pagination.hasMore is false.",
				tags: ["Transcripts"],
				security: secretAuth,
				parameters: [
					{
						name: "userId",
						in: "query",
						required: false,
						description: "Only return transcripts created with this userId.",
						schema: { type: "string", maxLength: 255 },
					},
					{
						name: "status",
						in: "query",
						required: false,
						description: "Only return transcripts in this status.",
						schema: {
							type: "string",
							enum: ["uploading", "queued", "processing", "complete", "error"],
						},
					},
					{
						name: "limit",
						in: "query",
						required: false,
						description: "Number of transcripts to return.",
						schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
					},
					{
						name: "offset",
						in: "query",
						required: false,
						description: "Number of transcripts to skip.",
						schema: { type: "integer", minimum: 0, default: 0 },
					},
				],
				responses: {
					"200": json(ref("TranscriptList"), "A page of transcripts."),
					"400": response("BadRequest"),
					...restErrors,
				},
			},
			post: {
				operationId: "createTranscript",
				summary: "Transcribe a URL",
				description:
					"Creates a transcript from a public audio or video URL and starts it. The URL must use http or https on the default port and resolve to a public address. Requires an available credit balance of at least 1,000 micro-credits. Poll getTranscript every few seconds until status is complete or error.",
				tags: ["Transcripts"],
				security: secretAuth,
				parameters: [idempotencyKeyParam],
				requestBody: jsonBody("CreateTranscriptRequest"),
				responses: {
					"200": json(
						dataEnvelope(ref("Transcript")),
						"The queued transcript.",
					),
					"400": response("BadRequest"),
					"402": response("PaymentRequired"),
					"403": response("Forbidden"),
					"409": response("Conflict"),
					"503": response("Unavailable"),
					...restErrors,
				},
			},
		},
		"/api/developer/v1/transcripts/uploads": {
			post: {
				operationId: "createTranscriptUpload",
				summary: "Transcribe a file",
				description:
					"Creates a transcript in the uploading status and returns a signed URL. PUT the file to upload.url with a Content-Length equal to contentLength, then call startTranscript. Files can be up to 2 GB. Requires a credit balance of at least 1,000 micro-credits.",
				tags: ["Transcripts"],
				security: secretAuth,
				parameters: [idempotencyKeyParam],
				requestBody: jsonBody("CreateTranscriptUploadRequest"),
				responses: {
					"200": json(
						dataEnvelope(ref("TranscriptUpload")),
						"The transcript and where to upload its file.",
					),
					"400": response("BadRequest"),
					"402": response("PaymentRequired"),
					"403": response("Forbidden"),
					"409": response("Conflict"),
					"503": response("Unavailable"),
					...restErrors,
				},
			},
		},
		"/api/developer/v1/transcripts/{id}/start": {
			post: {
				operationId: "startTranscript",
				summary: "Start an uploaded transcript",
				description:
					"Checks that the file was uploaded and starts transcription. Calling it again for a transcript that already started returns the transcript unchanged.",
				tags: ["Transcripts"],
				security: secretAuth,
				parameters: [transcriptIdParam],
				responses: {
					"200": json(
						dataEnvelope(ref("Transcript")),
						"The queued transcript.",
					),
					"400": response("BadRequest"),
					"402": response("PaymentRequired"),
					"403": response("Forbidden"),
					"404": response("NotFound"),
					"409": response("Conflict"),
					"503": response("Unavailable"),
					...restErrors,
				},
			},
		},
		"/api/developer/v1/transcripts/{id}": {
			get: {
				operationId: "getTranscript",
				summary: "Get a transcript",
				description:
					"Returns the transcript with its status and, once complete, its text. Add include=words or include=segments for timings in seconds.",
				tags: ["Transcripts"],
				security: secretAuth,
				parameters: [
					transcriptIdParam,
					{
						name: "include",
						in: "query",
						required: false,
						description:
							"Comma-separated extras to return with a complete transcript: words, segments.",
						schema: { type: "string" },
					},
				],
				responses: {
					"200": json(dataEnvelope(ref("TranscriptDetail")), "The transcript."),
					"404": response("NotFound"),
					...restErrors,
				},
			},
			delete: {
				operationId: "deleteTranscript",
				summary: "Delete a transcript",
				description:
					"Deletes the transcript, its text and its stored files. A transcript deleted before it completes is not charged.",
				tags: ["Transcripts"],
				security: secretAuth,
				parameters: [transcriptIdParam],
				responses: {
					"200": json(ref("Success"), "The transcript was deleted."),
					"404": response("NotFound"),
					...restErrors,
				},
			},
		},
		"/api/developer/v1/usage": {
			get: {
				operationId: "getDeveloperUsage",
				summary: "Get usage",
				description:
					"Returns the app's remaining credit balance and the count and total minutes of its videos.",
				tags: ["Usage"],
				security: secretAuth,
				responses: {
					"200": json(dataEnvelope(ref("Usage")), "The app's usage."),
					...restErrors,
				},
			},
		},
		"/api/developer/sdk/v1/videos/create": {
			post: {
				operationId: "createSdkVideo",
				summary: "Create a video",
				description:
					"Creates a video record and returns its ID with share and embed URLs. Requires a credit balance of at least 5,000 micro-credits. Upload the file next with initiateSdkUpload.",
				tags: ["SDK"],
				security: publicAuth,
				requestBody: jsonBody("CreateVideoRequest"),
				responses: {
					"200": json(ref("CreateVideoResponse"), "The created video."),
					"402": response("PaymentRequired"),
					...sdkErrors,
				},
			},
		},
		"/api/developer/sdk/v1/upload/multipart/initiate": {
			post: {
				operationId: "initiateSdkUpload",
				summary: "Start a multipart upload",
				description:
					"Starts an S3 multipart upload for a created video and returns the uploadId used by the other upload operations.",
				tags: ["SDK"],
				security: publicAuth,
				requestBody: jsonBody("InitiateUploadRequest"),
				responses: {
					"200": json(ref("InitiateUploadResponse"), "The upload started."),
					"409": response("UploadCompleted"),
					...sdkErrors,
				},
			},
		},
		"/api/developer/sdk/v1/upload/multipart/presign-part": {
			post: {
				operationId: "presignSdkUploadPart",
				summary: "Presign an upload part",
				description:
					"Returns a presigned URL. PUT the bytes for this part to it and keep the ETag response header for completeSdkUpload.",
				tags: ["SDK"],
				security: publicAuth,
				requestBody: jsonBody("PresignPartRequest"),
				responses: {
					"200": json(ref("PresignPartResponse"), "The presigned part URL."),
					"409": response("UploadCompleted"),
					...sdkErrors,
				},
			},
		},
		"/api/developer/sdk/v1/upload/multipart/complete": {
			post: {
				operationId: "completeSdkUpload",
				summary: "Complete a multipart upload",
				description:
					"Finishes the upload, records duration and dimensions, and debits 5,000 micro-credits per minute of video (at most 4 hours). Repeating the call after the upload completed returns success without charging again.",
				tags: ["SDK"],
				security: publicAuth,
				requestBody: jsonBody("CompleteUploadRequest"),
				responses: {
					"200": json(ref("Success"), "The upload completed."),
					"402": response("PaymentRequired"),
					...sdkErrors,
				},
			},
		},
		"/api/developer/sdk/v1/upload/multipart/abort": {
			post: {
				operationId: "abortSdkUpload",
				summary: "Abort a multipart upload",
				description: "Cancels an unfinished upload and discards its parts.",
				tags: ["SDK"],
				security: publicAuth,
				requestBody: jsonBody("AbortUploadRequest"),
				responses: {
					"200": json(ref("Success"), "The upload was aborted."),
					...sdkErrors,
				},
			},
		},
	},
	components: {
		securitySchemes: {
			secretKey: {
				type: "http",
				scheme: "bearer",
				bearerFormat: "csk_...",
				description:
					"Secret key from https://cap.so/dashboard/infra. Server-side only.",
			},
			publicKey: {
				type: "http",
				scheme: "bearer",
				bearerFormat: "cpk_...",
				description:
					"Public key from https://cap.so/dashboard/infra. Production apps also require an Origin header from an allowed domain.",
			},
		},
		schemas: {
			Error: errorSchema,
			ValidationError: {
				type: "object",
				required: ["success", "error"],
				properties: {
					success: { type: "boolean", const: false },
					error: {
						type: "object",
						description: "Zod validation error describing the failing fields.",
						additionalProperties: true,
					},
				},
			},
			Success: {
				type: "object",
				required: ["success"],
				properties: { success: { type: "boolean", const: true } },
			},
			DeveloperVideo: developerVideoSchema,
			Transcript: transcriptSchema,
			TranscriptList: {
				type: "object",
				required: ["data", "pagination"],
				properties: {
					data: { type: "array", items: ref("Transcript") },
					pagination: {
						type: "object",
						required: ["limit", "offset", "hasMore"],
						properties: {
							limit: { type: "integer" },
							offset: { type: "integer" },
							hasMore: { type: "boolean" },
						},
					},
				},
			},
			TranscriptDetail: {
				allOf: [
					ref("Transcript"),
					{
						type: "object",
						properties: {
							words: {
								type: ["array", "null"],
								items: {
									type: "object",
									required: ["text", "start", "end"],
									properties: {
										text: { type: "string" },
										start: { type: "number" },
										end: { type: "number" },
										confidence: { type: ["number", "null"] },
									},
								},
							},
							segments: {
								type: ["array", "null"],
								items: {
									type: "object",
									required: ["text", "start", "end"],
									properties: {
										text: { type: "string" },
										start: { type: "number" },
										end: { type: "number" },
									},
								},
							},
						},
					},
				],
			},
			TranscriptUpload: {
				allOf: [
					ref("Transcript"),
					{
						type: "object",
						required: ["upload"],
						properties: {
							upload: {
								type: ["object", "null"],
								description:
									"Where to PUT the file. null when a repeated request finds the transcript already started.",
								required: ["method", "url", "headers", "expiresAt"],
								properties: {
									method: { type: "string", const: "PUT" },
									url: { type: "string", format: "uri" },
									headers: {
										type: "object",
										additionalProperties: { type: "string" },
									},
									expiresAt: { type: "string", format: "date-time" },
								},
							},
						},
					},
				],
			},
			CreateTranscriptRequest: {
				type: "object",
				required: ["url"],
				properties: {
					url: {
						type: "string",
						format: "uri",
						maxLength: 2048,
						description: "Public http or https URL of an audio or video file.",
					},
					...transcriptOptionProperties,
				},
			},
			CreateTranscriptUploadRequest: {
				type: "object",
				required: ["contentLength"],
				properties: {
					fileName: { type: "string", maxLength: 255 },
					contentLength: {
						type: "integer",
						minimum: 1,
						maximum: 2147483648,
						description: "Exact size of the file in bytes.",
					},
					...transcriptOptionProperties,
				},
			},
			VideoStatus: {
				type: "object",
				required: ["id", "ready"],
				properties: {
					id: { type: "string" },
					duration: { type: ["number", "null"] },
					width: { type: ["integer", "null"] },
					height: { type: ["integer", "null"] },
					transcriptionStatus:
						developerVideoSchema.properties.transcriptionStatus,
					ready: {
						type: "boolean",
						description: "True once duration and width are known.",
					},
				},
			},
			Usage: {
				type: "object",
				required: [
					"balanceMicroCredits",
					"balanceDollars",
					"totalVideos",
					"totalDurationMinutes",
				],
				properties: {
					balanceMicroCredits: {
						type: "integer",
						description: "Remaining balance. 100,000 micro-credits = $1.",
					},
					balanceDollars: {
						type: "string",
						description: "Remaining balance in dollars, two decimals.",
					},
					totalVideos: { type: "integer" },
					totalDurationMinutes: { type: "number" },
				},
			},
			CreateVideoRequest: {
				type: "object",
				properties: {
					name: { type: "string", maxLength: 255 },
					userId: {
						type: "string",
						maxLength: 255,
						description: "Your own user ID, for filtering listDeveloperVideos.",
					},
					metadata: {
						type: "object",
						additionalProperties: true,
						description: "Arbitrary JSON under 8 KB.",
					},
				},
			},
			CreateVideoResponse: {
				type: "object",
				required: ["videoId", "s3Key", "shareUrl", "embedUrl"],
				properties: {
					videoId: { type: "string" },
					s3Key: { type: "string" },
					shareUrl: { type: "string", format: "uri" },
					embedUrl: { type: "string", format: "uri" },
				},
			},
			InitiateUploadRequest: {
				type: "object",
				required: ["videoId"],
				properties: {
					videoId: { type: "string" },
					contentType: {
						type: "string",
						enum: [
							"video/mp4",
							"video/webm",
							"video/quicktime",
							"video/x-matroska",
							"video/avi",
							"application/octet-stream",
						],
						default: "video/mp4",
					},
				},
			},
			InitiateUploadResponse: {
				type: "object",
				required: ["uploadId"],
				properties: { uploadId: { type: "string" } },
			},
			PresignPartRequest: {
				type: "object",
				required: ["videoId", "uploadId", "partNumber"],
				properties: {
					videoId: { type: "string" },
					uploadId: { type: "string" },
					partNumber: { type: "integer", minimum: 1, maximum: 10000 },
				},
			},
			PresignPartResponse: {
				type: "object",
				required: ["presignedUrl"],
				properties: { presignedUrl: { type: "string", format: "uri" } },
			},
			CompleteUploadRequest: {
				type: "object",
				required: ["videoId", "uploadId", "parts", "durationInSecs"],
				properties: {
					videoId: { type: "string" },
					uploadId: { type: "string" },
					parts: {
						type: "array",
						items: {
							type: "object",
							required: ["partNumber", "etag", "size"],
							properties: {
								partNumber: { type: "integer", minimum: 1, maximum: 10000 },
								etag: { type: "string" },
								size: {
									type: "number",
									minimum: 0,
									description: "Part size in bytes.",
								},
							},
						},
					},
					durationInSecs: { type: "number", exclusiveMinimum: 0 },
					width: { type: "number" },
					height: { type: "number" },
					fps: { type: "number" },
				},
			},
			AbortUploadRequest: {
				type: "object",
				required: ["videoId", "uploadId"],
				properties: {
					videoId: { type: "string" },
					uploadId: { type: "string" },
				},
			},
		},
		responses: {
			BadRequest: {
				description: "The request body failed validation.",
				content: {
					"application/json": {
						schema: { oneOf: [ref("ValidationError"), ref("Error")] },
					},
				},
			},
			Unauthorized: json(
				ref("Error"),
				"The API key is missing, invalid or revoked.",
			),
			PaymentRequired: json(
				ref("Error"),
				"The app does not have enough credits.",
			),
			Forbidden: json(
				ref("Error"),
				"A production app was called without an allowed Origin, or the account cannot use this feature yet.",
			),
			NotFound: json(
				ref("Error"),
				"The video, transcript or route does not exist.",
			),
			Conflict: json(
				ref("Error"),
				"The request conflicts with the current state, for example a file that has not been uploaded yet or a reused Idempotency-Key.",
			),
			Unavailable: json(
				ref("Error"),
				"Transcription is temporarily unavailable. Retry later.",
			),
			UploadCompleted: json(
				ref("Error"),
				"The video's upload already completed. Create a new video to upload again.",
			),
			RateLimited: {
				...json(
					ref("Error"),
					"More than 60 requests in a minute for this key.",
				),
				headers: {
					"Retry-After": {
						description: "Seconds until the limit resets.",
						schema: { type: "integer" },
					},
				},
			},
			InternalError: json(
				ref("Error"),
				"Unexpected server error. Retry with backoff.",
			),
		},
	},
});
