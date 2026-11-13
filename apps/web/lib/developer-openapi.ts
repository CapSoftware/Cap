import { AI_GENERATION_LANGUAGE_CODES } from "@cap/web-domain";
import { API_DOCS_URL } from "@/lib/api-errors";
import {
	MICRO_CREDITS_PER_DOLLAR,
	UPLOAD_ADMISSION_DAYS,
} from "@/lib/developer-pricing";
import {
	DEVELOPER_KEY_REQUESTS_PER_MINUTE,
	DEVELOPER_OWNER_REQUESTS_PER_MINUTE,
	DEVELOPER_RATE_LIMIT_WINDOW_SECONDS,
	DEVELOPER_TRANSCRIPT_POLL_SECONDS,
	DEVELOPER_UPLOAD_TOKEN_REQUESTS_PER_MINUTE,
	DEVELOPER_VIDEO_STATUS_POLL_SECONDS,
} from "@/lib/developer-rate-limits";
import {
	TRANSCRIPT_FAILURE_CODES,
	transcriptFailureCodesText,
	transcriptRequestErrorsText,
} from "@/lib/developer-transcript-errors";
import {
	MAX_WEBHOOK_ENDPOINTS_PER_APP,
	WEBHOOK_DISABLE_AFTER_FAILURES,
	WEBHOOK_EVENT_TYPES,
	WEBHOOK_MAX_ATTEMPTS,
	WEBHOOK_TEST_EVENT_TYPE,
} from "@/lib/developer-webhook-events";
import { INFRA_MCP_PATH } from "@/lib/infra-mcp-path";
import { INFRA_RESOLUTION_TIERS } from "@/lib/infra-pricing";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const response = (name: string) => ({ $ref: `#/components/responses/${name}` });

const header = (name: string) => ({ $ref: `#/components/headers/${name}` });

const rateLimitHeaders = {
	"X-RateLimit-Limit": header("RateLimitLimit"),
	"X-RateLimit-Remaining": header("RateLimitRemaining"),
	"X-RateLimit-Reset": header("RateLimitReset"),
};

const json = (schema: object, description: string) => ({
	description,
	headers: rateLimitHeaders,
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
	description: "Developer video ID returned by createUpload.",
	schema: { type: "string" },
};

const USER_SCOPE_RULES =
	"The match is exact: case and accents count. Spaces around the value are ignored. A value that is empty or only spaces returns 400 invalid_user_id and a parameter sent more than once returns 400 repeated_parameter.";

const videoUserScopeParams = [
	{
		name: "userId",
		in: "query",
		required: false,
		description: `Answer 404 video_not_found unless the video was created with this userId, so a server can pass its signed-in user straight through. ${USER_SCOPE_RULES} Any other query parameter returns 400 unknown_parameter.`,
		schema: { type: "string", minLength: 1, maxLength: 255 },
	},
	{
		name: "externalUserId",
		in: "query",
		required: false,
		description:
			"Another name for userId. Sending both with different values returns 400 conflicting_parameters.",
		schema: { type: "string", minLength: 1, maxLength: 255 },
	},
];

const transcriptIdParam = {
	name: "id",
	in: "path",
	required: true,
	description: "Transcript ID returned when the transcript was created.",
	schema: { type: "string" },
};

const uploadIdempotencyKeyParam = {
	name: "Idempotency-Key",
	in: "header",
	required: false,
	description:
		"8 to 128 characters from letters, digits, dot, dash and underscore. Repeating the request with the same key returns the same video with a new upload token instead of creating a second one. A repeat must send the same name, userId, maxResolutionTier and metadata, otherwise it is refused with 409 idempotency_conflict naming the field. corsOrigin, timeoutSeconds and maxBytes only shape the new token, so they may change. A key for a video that was deleted is refused with 409 idempotency_conflict, and once the upload completed the repeat answers 409 upload_already_completed.",
	schema: {
		type: "string",
		minLength: 8,
		maxLength: 128,
		pattern: "^[A-Za-z0-9._-]+$",
	},
};

const idempotencyKeyParam = {
	name: "Idempotency-Key",
	in: "header",
	required: false,
	description:
		"8 to 128 characters from letters, digits, dot, dash and underscore. Repeating a create request with the same key and the same body returns the same transcript instead of creating and billing a second one, and returns a new upload URL while the transcript still waits for its file. The same key with a different body is refused with 409 idempotency_conflict.",
	schema: {
		type: "string",
		minLength: 8,
		maxLength: 128,
		pattern: "^[A-Za-z0-9._-]+$",
	},
};

const uploadMaxBytes = {
	type: "integer",
	minimum: 1,
	maximum: 36_000_000_000,
	description:
		"Largest file this token may upload, in bytes. A larger file is refused with code file_too_large, at initiateSdkUpload when it declares contentLength and at completeSdkUpload from the bytes in storage. Leave it out for no cap beyond the 36 GB limit.",
};

const transcriptOptionProperties = {
	name: {
		type: "string",
		maxLength: 255,
		description: "Display name. Defaults to the file name.",
	},
	language: {
		type: "string",
		enum: ["auto", ...AI_GENERATION_LANGUAGE_CODES],
		default: "auto",
		description:
			"The language of the audio, if you know it. With a code, Cap skips language detection, uses its model for that language and reports that code as the transcript's language. It does not translate, and audio in another language is still transcribed as spoken. Leave it out or send auto to have Cap detect the language.",
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
				type: {
					type: "string",
					enum: ["upload", "url", "video"],
					description:
						"upload for a file sent to Cap, url for a public URL, video for a video the app stores.",
				},
				url: {
					type: ["string", "null"],
					description:
						"The URL the transcript was created from, without its query string or fragment. null for an upload and for a stored video.",
				},
			},
		},
		videoId: {
			type: ["string", "null"],
			description:
				"The video this transcript was created from with videoId. null for every other transcript. When a transcript of a video completes with speech, Cap writes a WebVTT captions file for the video in that language, from the newest completed transcript of the video in that language.",
		},
		durationSeconds: {
			type: ["number", "null"],
			description: "Measured audio length. Set when the transcript finishes.",
		},
		language: {
			type: ["string", "null"],
			description:
				"The language of the audio: the code sent in the request, or the one Cap detected when the request left it out or sent auto. null until the transcript completes, and null when no speech was found.",
		},
		wordCount: {
			type: ["integer", "null"],
			description:
				"Words in the transcript. 0 on a complete transcript means no speech was found in the audio.",
		},
		text: {
			type: ["string", "null"],
			description:
				"The transcript text. Returned by getTranscript once status is complete. An empty string when the audio has no speech.",
		},
		costMicroCredits: {
			type: "integer",
			description:
				"Credits charged for this transcript. 0 until it completes, and 0 for failed transcripts. Audio length is measured by Cap and billed to the nearest second. Audio with no speech is billed for its length and completes with empty text.",
		},
		costDollars: { type: "number" },
		error: {
			type: ["object", "null"],
			properties: {
				code: {
					type: "string",
					enum: TRANSCRIPT_FAILURE_CODES.map((failure) => failure.code),
					description: transcriptFailureCodesText(),
				},
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

const webhookIdParam = {
	name: "id",
	in: "path",
	required: true,
	description: "Webhook endpoint ID returned by createWebhookEndpoint.",
	schema: { type: "string" },
};

const WEBHOOK_URL_RULES =
	"The URL must be https on the default port, at most 2,048 characters, with no username or password, and its host must resolve to a public address. Anything else returns 400 with code invalid_webhook_url.";

const webhookEventsProperty = {
	type: "array",
	minItems: 1,
	uniqueItems: true,
	items: { type: "string", enum: [...WEBHOOK_EVENT_TYPES] },
	description: "The event types sent to this endpoint.",
};

const WEBHOOK_VERIFY_NOTE =
	"Verify Cap-Signature before trusting the body, and use the event id to ignore a delivery you have already handled.";

const videoEventDescription = (type: string) =>
	`Cap sends this request to every enabled endpoint subscribed to ${type}. Answer with any 2xx status within 10 seconds. Any other answer, a redirect or no answer is retried, up to ${WEBHOOK_MAX_ATTEMPTS} attempts over about a day. ${WEBHOOK_VERIFY_NOTE}`;

const webhookDelivery = (
	type: string,
	summary: string,
	data: object,
	description: string = videoEventDescription(type),
) => ({
	post: {
		operationId: `receive${type
			.split(".")
			.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
			.join("")}`,
		summary,
		description,
		tags: ["Webhooks"],
		security: [],
		parameters: [
			{
				name: "Cap-Signature",
				in: "header",
				required: true,
				description:
					't=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" keyed with the endpoint\'s signing secret>. Reject a timestamp more than five minutes old.',
				schema: { type: "string" },
			},
			{
				name: "Cap-Event-Id",
				in: "header",
				required: true,
				description: "The event's id, the same value as id in the body.",
				schema: { type: "string" },
			},
			{
				name: "Cap-Event-Type",
				in: "header",
				required: true,
				description: "The event's type, the same value as type in the body.",
				schema: { type: "string" },
			},
		],
		requestBody: {
			required: true,
			content: {
				"application/json": {
					schema: {
						type: "object",
						required: ["id", "type", "createdAt", "data"],
						properties: {
							id: {
								type: "string",
								description:
									"Identifies the event. A retry, and a delivery to another endpoint, carry the same id.",
							},
							type: { type: "string", const: type },
							createdAt: { type: "string", format: "date-time" },
							data,
						},
					},
				},
			},
		},
		responses: {
			"2XX": { description: "The event was received." },
		},
	},
});

const secretAuth = [{ secretKey: [] }];
const uploadTokenAuth = [{ uploadToken: [] }];

const restErrors = {
	"401": response("Unauthorized"),
	"403": response("Forbidden"),
	"429": response("RateLimited"),
	"500": response("InternalError"),
};

const sdkErrors = {
	"400": response("BadRequest"),
	"401": response("Unauthorized"),
	"403": response("Forbidden"),
	"404": response("NotFound"),
	"415": response("UnsupportedMediaType"),
	"429": response("RateLimited"),
	"500": response("InternalError"),
};

const errorSchema = {
	type: "object",
	required: ["error", "code"],
	properties: {
		error: {
			type: "string",
			description: "Human-readable error message.",
		},
		code: {
			type: "string",
			description:
				"Stable machine-readable error code, such as invalid_secret_key, video_not_found, invalid_request or rate_limited. Switch on this, not on the error text.",
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

const PLAYER_PAGE_DESCRIPTION =
	"Hosted player page for the video, built from its playbackId. Public, needs no API key and works before the video is ready. Takes the query parameter t (seconds) to start at a time.";
const PLAYER_EMBED_DESCRIPTION =
	"The hosted player with nothing around it, for an iframe on any origin. Built from the playbackId. Takes the query parameters autoplay=1, muted=1, loop=1, t (seconds to start at) and controls=0.";

const playbackProperties = {
	status: {
		type: "string",
		enum: ["uploading", "processing", "ready", "errored"],
		description:
			"uploading until the upload completes, processing until the first output can be played, then ready or errored.",
	},
	errorReason: {
		type: ["string", "null"],
		description:
			"Why processing failed, when status is errored. A failed video is not billed and its files are removed 24 hours after processing started.",
	},
	playbackId: {
		type: ["string", "null"],
		description: "Unguessable ID that the playback URLs are built from.",
	},
	renditions: {
		type: "array",
		description:
			"Encoded HLS renditions, largest first. Empty until hlsUrl is set.",
		items: {
			type: "object",
			required: ["name", "width", "height", "bitrate", "bytes"],
			properties: {
				name: { type: "string", description: "Tier name, such as 1080p." },
				width: { type: "integer" },
				height: { type: "integer" },
				bitrate: {
					type: "integer",
					description: "Average bits per second.",
				},
				bytes: { type: "integer", description: "Stored bytes." },
				codecs: { type: ["string", "null"] },
			},
		},
	},
	hlsUrl: {
		type: ["string", "null"],
		format: "uri",
		description:
			"Adaptive HLS master playlist. Null until it is encoded, which can be after the video is ready. Players built on hls.js can add ?segments=short for shorter playlists on long videos.",
	},
	mp4Url: {
		type: ["string", "null"],
		format: "uri",
		description:
			"Progressive MP4. Null until it is encoded, which can be after the video is ready.",
	},
	posterUrl: {
		type: ["string", "null"],
		format: "uri",
		description: "Poster image. Null until ready.",
	},
	takenDown: {
		type: "boolean",
		description:
			"True when Cap has taken the video down after a report. Its playback URLs are null, its playback files answer 410 Gone to new requests, and its page and embed show only that the video is not available, until Cap restores it. Signed media links a player already loaded keep working until they expire, at most 18 hours later. status is unchanged, and the video is stored and billed as before. Email hello@cap.so about a takedown.",
	},
	outputs: {
		type: "object",
		required: ["hls", "mp4"],
		description:
			"Whether each output is still coming. ready means its URL is set, except while takenDown is true, when every URL is null. processing means it is being encoded, or will be retried, so check again later. failed means it will not be produced. none is only for videos uploaded before encoding existed.",
		properties: {
			hls: {
				type: "string",
				enum: ["processing", "ready", "failed", "none"],
				description: "State of hlsUrl.",
			},
			mp4: {
				type: "string",
				enum: ["processing", "ready", "failed", "none"],
				description: "State of mp4Url.",
			},
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
			description: "Your user ID, as passed to createUpload.",
		},
		name: { type: "string", description: "Video name." },
		duration: {
			type: ["number", "null"],
			description:
				"Duration in seconds. Set when the upload completes and replaced by the measured value during processing. Null for a failed video that processing had not measured yet, even if a length was reported when the upload completed.",
		},
		width: {
			type: ["integer", "null"],
			description: "Measured source width in pixels.",
		},
		height: {
			type: ["integer", "null"],
			description: "Measured source height in pixels.",
		},
		fps: {
			type: ["integer", "null"],
			description: "Measured frames per second.",
		},
		transcriptionStatus: {
			type: ["string", "null"],
			enum: ["PROCESSING", "COMPLETE", "ERROR", "SKIPPED", "NO_AUDIO", null],
			description: "Transcription state, when transcription applies.",
		},
		metadata: {
			type: ["object", "null"],
			additionalProperties: true,
			description: "Metadata passed to createUpload.",
		},
		...playbackProperties,
		shareUrl: {
			type: ["string", "null"],
			format: "uri",
			description: `${PLAYER_PAGE_DESCRIPTION} Null only for a video with no playbackId.`,
		},
		embedUrl: {
			type: ["string", "null"],
			format: "uri",
			description: `${PLAYER_EMBED_DESCRIPTION} Null only for a video with no playbackId.`,
		},
		maxResolutionTier: {
			type: "string",
			enum: ["1080p", "1440p", "2160p"],
			description: "Highest resolution this video is encoded at.",
		},
		storedBytes: {
			type: ["integer", "null"],
			description:
				"Bytes stored for the source and every encoded output. 0 once a failed video's files have been removed.",
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
		summary: "Host video in your product and turn audio or video into text.",
		description: [
			"The Cap Developer API does two things for your product. It hosts video: upload a file, Cap encodes it, and you play it back as adaptive HLS or MP4 or with the hosted player. It turns speech into text: send an audio or video file and get a transcript back, with timings.",
			"",
			"Use the REST operations (secret `csk_` key, server-side only) to create uploads, list, inspect and delete videos, transcribe audio and video, and read credit usage.",
			"To upload a video, call createUpload from your server. It creates the video and returns an upload token (`cut_`) for that one video. Send the token from the browser as the Bearer credential of the SDK operations: initiateSdkUpload, presignSdkUploadPart for up to 50 parts at a time, then completeSdkUpload. If the token expires before the upload completes, renewUploadToken returns a new one for the same video and the upload continues with the same uploadId.",
			"A public `cpk_` key cannot create or upload videos. Only an upload token made with the secret key can.",
			`To transcribe a file at a public URL, call createTranscript. To transcribe a file you hold, call createTranscriptUpload, PUT the file to the URL it returns, then call startTranscript. Poll getTranscript every ${DEVELOPER_TRANSCRIPT_POLL_SECONDS} seconds until its status is \`complete\` or \`error\`.`,
			"",
			`After completeSdkUpload, poll getDeveloperVideoStatus every ${DEVELOPER_VIDEO_STATUS_POLL_SECONDS} seconds until its status is \`ready\` or \`errored\`. A short video is usually ready on the first check.`,
			"",
			"Create a developer app and its keys at https://cap.so/dashboard/infra. A step by step guide with browser, Node and Python examples is at https://cap.so/docs/api/get-started.",
			"",
			"Every error is a JSON object with an `error` string and a stable `code`, and usually a `hint` that says what to change. Validation errors (code `invalid_request`) add an `issues` array naming each failing field. A request body must be JSON sent with `Content-Type: application/json`: malformed JSON returns 400 `invalid_json` and any other content type returns 415 `unsupported_media_type`. A known path called with a method it does not support returns 405 `method_not_allowed` with an Allow header, and an unknown path returns 404 `not_found`. A 4xx response will not succeed if the same request is sent again, with two exceptions that say to wait and repeat it: 429, and 409 with code `completion_in_progress`. Retry 5xx with backoff.",
			"",
			`A secret key is limited to ${DEVELOPER_KEY_REQUESTS_PER_MINUTE} requests per minute across the REST operations, all the keys of one account together to ${DEVELOPER_OWNER_REQUESTS_PER_MINUTE}, and each upload token to ${DEVELOPER_UPLOAD_TOKEN_REQUESTS_PER_MINUTE} requests per minute across the SDK operations. Responses to an accepted key or token carry X-RateLimit-Limit, X-RateLimit-Remaining and X-RateLimit-Reset, and a 429 also carries Retry-After. Remaining and Reset are what the server that answered has counted, so they are a guide and Remaining can read higher than what is left. A 429 is authoritative: wait for its Retry-After seconds, at most ${DEVELOPER_RATE_LIMIT_WINDOW_SECONDS}, then retry.`,
			"",
			"The REST operations take a secret key and send no CORS headers, so a page cannot call them. Call them from your server. The SDK operations and the playback URLs can be called from any origin.",
			"",
			`Agents can use the same operations as tools through the hosted MCP server at ${baseUrl}${INFRA_MCP_PATH} (Streamable HTTP). Send the secret key as Authorization: Bearer. Its requests count toward the same per-key limit. Setup for Claude Code, Cursor and Codex is at https://cap.so/docs/api/get-started#10-use-with-agents-mcp.`,
		].join("\n"),
		termsOfService: "https://cap.so/terms",
		contact: { name: "Cap", email: "hello@cap.so", url: "https://cap.so" },
		"x-mcp": {
			url: `${baseUrl}${INFRA_MCP_PATH}`,
			transport: "streamable-http",
			authorization: "Authorization: Bearer <secret key>",
			documentation:
				"https://cap.so/docs/api/get-started#10-use-with-agents-mcp",
		},
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
			description: `Turn audio or video into text (secret key). Requests can be refused with these codes. ${transcriptRequestErrorsText()}`,
		},
		{
			name: "Usage",
			description: "Credit balance and totals (secret key).",
		},
		{
			name: "Uploads",
			description: "Create an upload and its upload token (secret key).",
		},
		{
			name: "SDK",
			description: "Upload a video's file from the browser (upload token).",
		},
		{
			name: "Webhooks",
			description:
				"Have Cap call your server when a video is ready or has failed (secret key).",
		},
	],
	webhooks: {
		"video.ready": webhookDelivery(
			"video.ready",
			"A video is ready to play",
			ref("DeveloperVideo"),
		),
		"video.errored": webhookDelivery(
			"video.errored",
			"A video could not be processed",
			ref("DeveloperVideo"),
		),
		[WEBHOOK_TEST_EVENT_TYPE]: webhookDelivery(
			WEBHOOK_TEST_EVENT_TYPE,
			"A test event sent by sendWebhookTestEvent",
			{
				type: "object",
				required: ["webhookId"],
				properties: { webhookId: { type: "string" } },
			},
			`Cap sends this request once, to the one endpoint named in sendWebhookTestEvent, whether or not that endpoint is enabled. It is never retried: what the endpoint answers within 10 seconds is returned by sendWebhookTestEvent. ${WEBHOOK_VERIFY_NOTE}`,
		),
	},
	paths: {
		"/api/developer/v1/videos": {
			get: {
				operationId: "listDeveloperVideos",
				summary: "List videos",
				description:
					"Lists the app's videos, newest first, in an order that stays the same between calls. Filter by your own user ID and page with limit and offset until pagination.hasMore is false. An unknown or repeated query parameter, an empty userId or an out-of-range limit or offset returns 400 rather than an unfiltered list.",
				tags: ["Videos"],
				security: secretAuth,
				parameters: [
					{
						name: "userId",
						in: "query",
						required: false,
						description: `Only return videos created with this userId. Videos return it as externalUserId. ${USER_SCOPE_RULES}`,
						schema: { type: "string", minLength: 1, maxLength: 255 },
					},
					{
						name: "externalUserId",
						in: "query",
						required: false,
						description:
							"Another name for the userId filter. Sending both with different values returns 400 conflicting_parameters.",
						schema: { type: "string", minLength: 1, maxLength: 255 },
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
					"200": json(ref("DeveloperVideoList"), "The app's videos."),
					"400": response("BadRequest"),
					...restErrors,
				},
			},
		},
		"/api/developer/v1/videos/{id}": {
			get: {
				operationId: "getDeveloperVideo",
				summary: "Get a video",
				description:
					"Returns one video owned by the app. Send userId to return it only when it was created with that userId.",
				tags: ["Videos"],
				security: secretAuth,
				parameters: [videoIdParam, ...videoUserScopeParams],
				responses: {
					"200": json(dataEnvelope(ref("DeveloperVideo")), "The video."),
					"400": response("BadRequest"),
					"404": response("NotFound"),
					...restErrors,
				},
			},
			delete: {
				operationId: "deleteDeveloperVideo",
				summary: "Delete a video",
				description:
					"Deletes a video owned by the app. It stops appearing in list and get results. Deleting a video this app already deleted returns success, so the call is safe to repeat; an ID that never belonged to this app returns 404. Send userId to delete it only when it was created with that userId.",
				tags: ["Videos"],
				security: secretAuth,
				parameters: [videoIdParam, ...videoUserScopeParams],
				responses: {
					"200": json(ref("Success"), "The video was deleted."),
					"400": response("BadRequest"),
					"404": response("NotFound"),
					...restErrors,
				},
			},
		},
		"/api/developer/v1/videos/{id}/status": {
			get: {
				operationId: "getDeveloperVideoStatus",
				summary: "Get video status",
				description: `Returns the processing status and, once ready, the playback URLs, with dimensions, duration and transcription state. Poll this every ${DEVELOPER_VIDEO_STATUS_POLL_SECONDS} seconds after completeSdkUpload. A video can be ready while hlsUrl is still null, so a player that wants HLS keeps polling until hlsUrl is set. Send userId to return the status only when the video was created with that userId.`,
				tags: ["Videos"],
				security: secretAuth,
				parameters: [videoIdParam, ...videoUserScopeParams],
				responses: {
					"200": json(dataEnvelope(ref("VideoStatus")), "The video status."),
					"400": response("BadRequest"),
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
					"Returns the app's transcripts, newest first, without their text. Paginate with limit and offset until pagination.hasMore is false. An unknown query parameter or an out-of-range limit or offset returns 400.",
				tags: ["Transcripts"],
				security: secretAuth,
				parameters: [
					{
						name: "userId",
						in: "query",
						required: false,
						description:
							"Only return transcripts created with exactly this userId. The match is case-sensitive and accent-sensitive. An empty value returns 400 with code invalid_user_id.",
						schema: { type: "string", minLength: 1, maxLength: 255 },
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
				description: `Creates a transcript from a public audio or video URL, or from a video the app already stores, and starts it. Send exactly one of url or videoId. The URL must use http or https on the default port and resolve to a public address, and the file must finish downloading within 15 minutes. With videoId the video must belong to this app, not be deleted and be ready: Cap reads its stored MP4 directly, so nothing is downloaded and the URL size limit does not apply. An unknown or deleted video returns 404 video_not_found, and one that is not ready returns 409 video_not_ready. A video transcript costs the transcript price only, $0.10 per audio hour. Requires an available credit balance of at least 1,000 micro-credits. Starting holds up to the cost of four hours ($0.40) until the audio is measured, then the hold drops to the real cost. A stored video is held for its known length. A transcript whose hold the available balance cannot cover ends with insufficient_credits before the file is downloaded. Poll getTranscript every ${DEVELOPER_TRANSCRIPT_POLL_SECONDS} seconds until status is complete or error. An app can have 20 transcripts queued or processing at once: another is refused with 429 too_many_transcripts and a Retry-After header. A field the request does not know returns 400 with code invalid_request.`,
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
					"404": response("NotFound"),
					"409": response("Conflict"),
					"415": response("UnsupportedMediaType"),
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
					"Creates a transcript in the uploading status and returns a signed URL. PUT the file to upload.url with a Content-Length equal to contentLength, then call startTranscript. Files can be up to 2 GB. Requires an available credit balance of at least 1,000 micro-credits. Starting holds up to the cost of four hours ($0.40) until the audio is measured, then the hold drops to the real cost. A field the request does not know returns 400 with code invalid_request.",
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
					"409": response("Conflict"),
					"415": response("UnsupportedMediaType"),
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
					"Checks that the file was uploaded and starts transcription. Calling it again for a transcript that already started returns the transcript unchanged. An app can have 20 transcripts queued or processing at once: another is refused with 429 too_many_transcripts and a Retry-After header.",
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
				description: `Returns the transcript with its status and, once complete, its text. Poll it every ${DEVELOPER_TRANSCRIPT_POLL_SECONDS} seconds until status is complete or error. Audio with no speech is billed for its length and completes with an empty text and a wordCount of 0. A transcript that ends in error is never charged. Add include=words or include=segments for timings in seconds.`,
				tags: ["Transcripts"],
				security: secretAuth,
				parameters: [
					transcriptIdParam,
					{
						name: "include",
						in: "query",
						required: false,
						description:
							"Comma-separated extras to return with a complete transcript: words, segments. Any other value is refused with 400 invalid_include.",
						schema: { type: "string" },
					},
				],
				responses: {
					"200": json(dataEnvelope(ref("TranscriptDetail")), "The transcript."),
					"400": response("BadRequest"),
					"404": response("NotFound"),
					...restErrors,
				},
			},
			delete: {
				operationId: "deleteTranscript",
				summary: "Delete a transcript",
				description:
					"Deletes the transcript, its text and its stored files. A transcript deleted before its audio is sent to speech recognition is not charged. One deleted after that is still charged for the length of its audio when it finishes, because the audio was already transcribed. Deleting a transcript this app already deleted returns success again, so the call is safe to repeat. An ID that never belonged to this app returns 404.",
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
					"Returns the app's remaining credit balance, the count and total minutes of its videos, its standing, what it needs to take an upload, what storage costs it per day and the rates those costs are worked out from.",
				tags: ["Usage"],
				security: secretAuth,
				responses: {
					"200": json(dataEnvelope(ref("Usage")), "The app's usage."),
					...restErrors,
				},
			},
		},
		"/api/developer/v1/transactions": {
			get: {
				operationId: "listTransactions",
				summary: "List transactions",
				description:
					"Returns every credit and charge on the app's balance, newest first: top-ups, codes, the Cap Pro credit, daily storage, transcripts and adjustments. Each row carries its amount, the balance it left, and the ID of what it paid for. Paginate with limit and offset until pagination.hasMore is false. An unknown query parameter or an out-of-range limit or offset returns 400.",
				tags: ["Usage"],
				security: secretAuth,
				parameters: [
					{
						name: "limit",
						in: "query",
						required: false,
						description: "Number of transactions to return.",
						schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
					},
					{
						name: "offset",
						in: "query",
						required: false,
						description: "Number of transactions to skip.",
						schema: { type: "integer", minimum: 0, default: 0 },
					},
				],
				responses: {
					"200": json(ref("TransactionList"), "A page of transactions."),
					"400": response("BadRequest"),
					...restErrors,
				},
			},
		},
		"/api/developer/v1/uploads": {
			post: {
				operationId: "createUpload",
				summary: "Create an upload",
				description:
					"Creates a video record and returns an upload token for that one video, with the video's ID and its share and embed URLs. Call this from your server, then give the token to the browser that uploads the file. The token is the only credential the upload operations accept. It works until expiresAt, and stops working once the upload completes, the video is deleted or the secret key that created it is revoked. When corsOrigin is set, the upload operations also refuse a request whose Origin header differs: this is a convenience for browsers, and the token is the security boundary. Creating and uploading are free. The app must be in good standing with a balance that covers 7 days of storage for everything it stores, otherwise this returns 402 with the amount needed. Set maxBytes to refuse a file larger than that many bytes. Send an Idempotency-Key so a retried request returns the same video with a new token instead of creating a second one. A field the request does not know returns 400 with code invalid_request and names the field, so a misspelt userId never creates a video with no user.",
				tags: ["Uploads"],
				security: secretAuth,
				parameters: [uploadIdempotencyKeyParam],
				requestBody: jsonBody("CreateUploadRequest"),
				responses: {
					"200": json(dataEnvelope(ref("Upload")), "The created upload."),
					"400": response("BadRequest"),
					"402": response("UploadPaymentRequired"),
					"409": response("Conflict"),
					"415": response("UnsupportedMediaType"),
					...restErrors,
				},
			},
		},
		"/api/developer/v1/uploads/{id}/token": {
			post: {
				operationId: "renewUploadToken",
				summary: "Renew an upload token",
				description:
					"Returns a new upload token for a video whose upload has not completed. Call this from your server when an upload operation answers 401 with code upload_token_expired, or with invalid_upload_token after the secret key was regenerated, then give the new token to the browser. The upload continues where it stopped: keep the uploadId and the ETags already collected, sign the remaining parts and call completeSdkUpload with the new token. A browser that lost its uploadId calls initiateSdkUpload, which returns the open upload again when it was opened in the last 6 hours. The new token carries only the options sent with this request, so send corsOrigin and maxBytes again if the first token had them. Earlier tokens keep working until their own expiresAt. Returns 404 with code video_not_found when the video is deleted or belongs to another app, and 409 with code upload_already_completed once the upload completed.",
				tags: ["Uploads"],
				security: secretAuth,
				parameters: [videoIdParam],
				requestBody: jsonBody("RenewUploadTokenRequest"),
				responses: {
					"200": json(
						dataEnvelope(ref("UploadToken")),
						"A new token for the same video.",
					),
					"400": response("BadRequest"),
					"404": response("NotFound"),
					"409": response("UploadCompleted"),
					"415": response("UnsupportedMediaType"),
					...restErrors,
				},
			},
		},
		"/api/developer/v1/webhooks": {
			get: {
				operationId: "listWebhookEndpoints",
				summary: "List webhook endpoints",
				description:
					"Lists the app's webhook endpoints, newest first. Signing secrets are never returned here. An unknown query parameter or an out-of-range limit or offset returns 400.",
				tags: ["Webhooks"],
				security: secretAuth,
				parameters: [
					{
						name: "limit",
						in: "query",
						required: false,
						description: "Maximum endpoints to return.",
						schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
					},
					{
						name: "offset",
						in: "query",
						required: false,
						description: "Number of endpoints to skip.",
						schema: { type: "integer", minimum: 0, default: 0 },
					},
				],
				responses: {
					"200": json(ref("WebhookEndpointList"), "The app's endpoints."),
					"400": response("BadRequest"),
					...restErrors,
				},
			},
			post: {
				operationId: "createWebhookEndpoint",
				summary: "Create a webhook endpoint",
				description: `Registers a URL that Cap calls when a video is ready or has failed. The response carries the endpoint's signing secret: store it, because it is never returned again. ${WEBHOOK_URL_RULES} An app can have ${MAX_WEBHOOK_ENDPOINTS_PER_APP} endpoints; one more returns 409 with code webhook_limit_reached. A field the request does not know returns 400 with code invalid_request.`,
				tags: ["Webhooks"],
				security: secretAuth,
				requestBody: jsonBody("CreateWebhookEndpointRequest"),
				responses: {
					"200": json(
						dataEnvelope(ref("WebhookEndpointWithSecret")),
						"The created endpoint and its signing secret.",
					),
					"400": response("BadRequest"),
					"409": response("WebhookLimitReached"),
					"415": response("UnsupportedMediaType"),
					...restErrors,
				},
			},
		},
		"/api/developer/v1/webhooks/{id}": {
			get: {
				operationId: "getWebhookEndpoint",
				summary: "Get a webhook endpoint",
				description:
					"Returns one endpoint owned by the app, with the result of its last delivery.",
				tags: ["Webhooks"],
				security: secretAuth,
				parameters: [webhookIdParam],
				responses: {
					"200": json(dataEnvelope(ref("WebhookEndpoint")), "The endpoint."),
					"404": response("WebhookNotFound"),
					...restErrors,
				},
			},
			patch: {
				operationId: "updateWebhookEndpoint",
				summary: "Update a webhook endpoint",
				description: `Changes an endpoint's URL, its event types or whether it is enabled. Send at least one of them. Setting enabled to true turns an endpoint back on after Cap disabled it and clears its failure count. The signing secret does not change; use rotateWebhookSecret for that. ${WEBHOOK_URL_RULES}`,
				tags: ["Webhooks"],
				security: secretAuth,
				parameters: [webhookIdParam],
				requestBody: jsonBody("UpdateWebhookEndpointRequest"),
				responses: {
					"200": json(
						dataEnvelope(ref("WebhookEndpoint")),
						"The updated endpoint.",
					),
					"400": response("BadRequest"),
					"404": response("WebhookNotFound"),
					"415": response("UnsupportedMediaType"),
					...restErrors,
				},
			},
			delete: {
				operationId: "deleteWebhookEndpoint",
				summary: "Delete a webhook endpoint",
				description:
					"Deletes an endpoint. Deliveries still waiting to be retried are dropped. Deleting an endpoint this app already deleted returns success, so the call is safe to repeat; an ID that never belonged to this app returns 404.",
				tags: ["Webhooks"],
				security: secretAuth,
				parameters: [webhookIdParam],
				responses: {
					"200": json(ref("Success"), "The endpoint was deleted."),
					"404": response("WebhookNotFound"),
					...restErrors,
				},
			},
		},
		"/api/developer/v1/webhooks/{id}/rotate-secret": {
			post: {
				operationId: "rotateWebhookSecret",
				summary: "Rotate a webhook signing secret",
				description:
					"Replaces the endpoint's signing secret and returns the new one. Store it, because it is never returned again. The old secret stops working at once: every delivery from this moment, including a retry of an earlier event, is signed with the new secret. Deploy a receiver that accepts both secrets first, rotate, then remove the old one.",
				tags: ["Webhooks"],
				security: secretAuth,
				parameters: [webhookIdParam],
				responses: {
					"200": json(
						dataEnvelope(ref("WebhookEndpointWithSecret")),
						"The endpoint and its new signing secret.",
					),
					"404": response("WebhookNotFound"),
					...restErrors,
				},
			},
		},
		"/api/developer/v1/webhooks/{id}/test": {
			post: {
				operationId: "sendWebhookTestEvent",
				summary: "Send a test event",
				description: `Sends one signed ${WEBHOOK_TEST_EVENT_TYPE} event to the endpoint and waits up to 10 seconds for the answer. It is sent once and never retried, it works on a disabled endpoint, and a failure does not count towards disabling the endpoint. The response says whether the endpoint answered with a 2xx status. Nothing your endpoint returns in its body is read or stored.`,
				tags: ["Webhooks"],
				security: secretAuth,
				parameters: [webhookIdParam],
				responses: {
					"200": json(
						dataEnvelope(ref("WebhookTestResult")),
						"What the endpoint answered.",
					),
					"404": response("WebhookNotFound"),
					...restErrors,
				},
			},
		},
		"/api/developer/sdk/v1/upload/multipart/initiate": {
			post: {
				operationId: "initiateSdkUpload",
				summary: "Start a multipart upload",
				description:
					"Starts an S3 multipart upload for the token's video and returns the uploadId used by the other upload operations. Calling it again returns the upload that is already open when it was opened in the last 6 hours, so parts sent earlier are kept. Send contentLength to be refused before any byte is sent when the file is over the token's maxBytes or the 36 GB limit (400 with code file_too_large).",
				tags: ["SDK"],
				security: uploadTokenAuth,
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
				summary: "Presign upload parts",
				description:
					"Returns presigned URLs, each valid for one hour. Send partNumbers to sign up to 50 parts in one request and get parts back, or partNumber to sign one part and get presignedUrl back. PUT the bytes for each part to its URL and keep the ETag response header for completeSdkUpload. Every part except the last must be at least 5 MB (5,242,880 bytes). More than 50 part numbers, or none, returns 400 with code invalid_part_count. A part number above the last one the upload's size limit allows (maxBytes divided by 5,242,880 and rounded up, or 6,867 with no maxBytes) returns 400 with code part_number_too_large and signs nothing, so number the parts from 1 with no gaps. Signing does not contact storage, so an uploadId that is wrong or was aborted is not refused here: the PUT to its URL fails, and completeSdkUpload answers 404 with code upload_not_found.",
				tags: ["SDK"],
				security: uploadTokenAuth,
				requestBody: jsonBody("PresignPartRequest"),
				responses: {
					"200": json(
						ref("PresignPartResponse"),
						"The presigned URL of one part, or of each part asked for.",
					),
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
					"Finishes the upload and records duration and dimensions (at most 4 hours). Nothing is charged. The balance must cover 7 days of storage for everything the app stores including this video, otherwise this returns 402 with the amount needed. A 402 whose body has fileRemoved true means the file was already assembled and has been removed, so upload it again after a top-up; any other 402 leaves the upload open. Returns 409 with code completion_in_progress while another request is completing the same upload: wait and send the same request again, and do not abort or delete. Stored video is billed daily by resolution tier. Repeating the call after the upload completed returns success. Mistakes in the request return 400 with code parts_required (parts is empty), parts_mismatch (a listed part is missing, repeated or has a different ETag), part_too_small (a part other than the last is under 5 MB) or file_too_large (the parts add up to more than 36 GB or more than the token's maxBytes: the upload has been aborted and the video can take a new, smaller one), and 404 with code upload_not_found when the uploadId is wrong or was aborted: call initiateSdkUpload again and upload the parts again.",
				tags: ["SDK"],
				security: uploadTokenAuth,
				requestBody: jsonBody("CompleteUploadRequest"),
				responses: {
					"200": json(ref("Success"), "The upload completed."),
					"402": response("UploadPaymentRequired"),
					"409": response("CompletionInProgress"),
					...sdkErrors,
				},
			},
		},
		"/api/developer/sdk/v1/upload/multipart/abort": {
			post: {
				operationId: "abortSdkUpload",
				summary: "Abort a multipart upload",
				description:
					"Cancels an unfinished upload and discards its parts. Abort is safe to repeat: when no open upload matches the uploadId, for example because it was already aborted, it answers 200 with success true again.",
				tags: ["SDK"],
				security: uploadTokenAuth,
				requestBody: jsonBody("AbortUploadRequest"),
				responses: {
					"200": json(ref("Success"), "The upload was aborted."),
					"409": response("CompletionInProgress"),
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
			uploadToken: {
				type: "http",
				scheme: "bearer",
				bearerFormat: "cut_...",
				description:
					"Upload token returned by createUpload. It is bound to one video, expires at expiresAt and stops working once the upload completes or the video is deleted. Safe to send to the browser that uploads the file.",
			},
		},
		schemas: {
			Error: errorSchema,
			ValidationError: {
				allOf: [
					ref("Error"),
					{
						type: "object",
						required: ["issues"],
						properties: {
							code: { type: "string", const: "invalid_request" },
							issues: {
								type: "array",
								description: "One entry for each failing field.",
								items: {
									type: "object",
									required: ["path", "message"],
									additionalProperties: true,
									properties: {
										path: {
											type: "array",
											items: { type: ["string", "number"] },
											description: "Where the field is in the request.",
										},
										message: { type: "string" },
										code: { type: "string" },
									},
								},
							},
						},
					},
				],
			},
			UploadPaymentRequired: {
				type: "object",
				required: [
					"error",
					"code",
					"message",
					"standing",
					"pausesAt",
					"balanceMicroCredits",
					"requiredMicroCredits",
					"shortfallMicroCredits",
				],
				properties: {
					error: { type: "string" },
					code: {
						type: "string",
						enum: ["no_account", "out_of_credit", "insufficient_credits"],
						description:
							"out_of_credit when the app is not in good standing, insufficient_credits when the balance does not cover the upload rule, no_account when the app has no credit account.",
					},
					message: {
						type: "string",
						description: "Says how much to add before uploading.",
					},
					standing: { type: "string", enum: ["active", "grace", "paused"] },
					pausesAt: {
						type: ["string", "null"],
						format: "date-time",
						description: "When playback pauses. Null while active.",
					},
					balanceMicroCredits: { type: "integer" },
					requiredMicroCredits: {
						type: "integer",
						description: "Balance needed before this upload is accepted.",
					},
					shortfallMicroCredits: {
						type: "integer",
						description: "How much to add: required minus balance.",
					},
					fileRemoved: {
						type: "boolean",
						description:
							"Only on completeSdkUpload, and only true: the assembled file was removed, so upload it again after adding credit.",
					},
				},
			},
			Success: {
				type: "object",
				required: ["success"],
				properties: { success: { type: "boolean", const: true } },
			},
			DeveloperVideo: developerVideoSchema,
			DeveloperVideoList: {
				type: "object",
				required: ["data", "pagination"],
				properties: {
					data: { type: "array", items: ref("DeveloperVideo") },
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
							upload: {
								type: "object",
								description:
									"Present while status is uploading. To get a new upload URL after this time, repeat the create request with the same Idempotency-Key.",
								required: ["expiresAt"],
								properties: {
									expiresAt: {
										type: "string",
										format: "date-time",
										description: "When the latest upload URL stops working.",
									},
								},
							},
							words: {
								type: ["array", "null"],
								description:
									"Each word with its start and end in seconds. A start is usually within 0.1 seconds, and an end can run up to 0.4 seconds late, often to the start of the next word.",
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
				description: "Send exactly one of url or videoId.",
				oneOf: [{ required: ["url"] }, { required: ["videoId"] }],
				additionalProperties: false,
				properties: {
					url: {
						type: "string",
						format: "uri",
						maxLength: 2048,
						description:
							"Public http or https URL of an audio or video file. Leave it out when you send videoId.",
					},
					videoId: {
						type: "string",
						minLength: 1,
						maxLength: 64,
						description:
							"ID of a ready video of this app. Cap transcribes its stored MP4 directly. Leave it out when you send url.",
					},
					...transcriptOptionProperties,
				},
			},
			CreateTranscriptUploadRequest: {
				type: "object",
				required: ["contentLength"],
				additionalProperties: false,
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
					externalUserId: developerVideoSchema.properties.externalUserId,
					duration: { type: ["number", "null"] },
					width: { type: ["integer", "null"] },
					height: { type: ["integer", "null"] },
					transcriptionStatus:
						developerVideoSchema.properties.transcriptionStatus,
					ready: {
						type: "boolean",
						description: "True once status is ready.",
					},
					...playbackProperties,
				},
			},
			Transaction: {
				type: "object",
				required: [
					"id",
					"type",
					"description",
					"note",
					"amountMicroCredits",
					"amountDollars",
					"balanceAfterMicroCredits",
					"balanceAfterDollars",
					"referenceType",
					"referenceId",
					"createdAt",
				],
				properties: {
					id: {
						type: "string",
						description:
							"The transaction's ID. Quote it when asking about a row.",
					},
					type: {
						type: "string",
						description:
							"The kind of row: topup, topup_failed, topup_pending, pro_credit, storage_daily, transcription or adjustment. Treat a value you do not know as a row to show as it is.",
					},
					description: {
						type: "string",
						description:
							"The name the console shows for the row, for example Top-up, Code redeemed, Auto top-up, Storage, Transcription or Adjustment.",
					},
					note: {
						type: ["string", "null"],
						description:
							"A sentence of explanation for rows that need one, such as an adjustment or a declined auto top-up.",
					},
					amountMicroCredits: {
						type: "integer",
						description:
							"Positive for credit added, negative for a charge, 0 for a row that moved nothing. 100,000 micro-credits = $1.",
					},
					amountDollars: {
						type: "string",
						description:
							"The same amount in dollars, exact: two decimals for whole cents, five otherwise.",
					},
					balanceAfterMicroCredits: {
						type: "integer",
						description: "The balance once this row was applied.",
					},
					balanceAfterDollars: { type: "string" },
					referenceType: {
						type: ["string", "null"],
						enum: [
							"developer_video",
							"developer_transcript",
							"stripe_payment_intent",
							"stripe_checkout_session",
							"manual",
							"pro_monthly_credit",
							"storage_day",
							"auto_top_up",
							"auto_top_up_failed",
							"auto_top_up_pending",
							"stripe_refund",
							"stripe_dispute",
							null,
						],
						description: "What referenceId identifies.",
					},
					referenceId: {
						type: ["string", "null"],
						description:
							"The transcript ID, the UTC day a storage charge is for, the month of a Cap Pro credit, or the payment or checkout a top-up came from.",
					},
					createdAt: { type: "string", format: "date-time" },
				},
			},
			TransactionList: {
				type: "object",
				required: ["data", "pagination"],
				properties: {
					data: { type: "array", items: ref("Transaction") },
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
			Usage: {
				type: "object",
				required: [
					"balanceMicroCredits",
					"balanceDollars",
					"availableMicroCredits",
					"heldMicroCredits",
					"speech",
					"totalVideos",
					"uploadingVideos",
					"totalDurationMinutes",
					"standing",
					"upload",
					"storage",
					"rates",
				],
				properties: {
					balanceMicroCredits: {
						type: "integer",
						description: "Remaining balance. 100,000 micro-credits = $1.",
					},
					availableMicroCredits: {
						type: "integer",
						description:
							"The balance minus credit held by running transcripts. This is what a new transcript or upload is checked against.",
					},
					heldMicroCredits: {
						type: "integer",
						description:
							"Credit held by transcripts that are running now. A hold is not a charge and is released when the transcript finishes or fails.",
					},
					speech: {
						type: "object",
						description:
							"Speech to text charged in the current calendar month (UTC). Deleted transcripts stay counted.",
						required: ["periodStart", "seconds", "microCredits", "transcripts"],
						properties: {
							periodStart: {
								type: "string",
								format: "date-time",
								description: "Start of the month, 00:00 UTC on the 1st.",
							},
							seconds: {
								type: "number",
								description: "Measured audio seconds of completed transcripts.",
							},
							microCredits: {
								type: "integer",
								description: "Micro-credits charged for them.",
							},
							transcripts: {
								type: "integer",
								description: "How many transcripts completed.",
							},
						},
					},
					balanceDollars: {
						type: "string",
						description:
							"Remaining balance in dollars, exact and never rounded up: two decimals for whole cents, five otherwise.",
					},
					totalVideos: {
						type: "integer",
						description:
							"Videos that are stored and ready to play. A video that is still uploading or encoding, or that failed or was refused, is not counted.",
					},
					uploadingVideos: {
						type: "integer",
						description:
							"Videos that were created and have not completed an upload.",
					},
					totalDurationMinutes: {
						type: "number",
						description:
							"Combined length of the videos counted in totalVideos. Equal to the sum of storage.minutesByTier.",
					},
					standing: {
						type: "object",
						required: ["state", "pausesAt"],
						properties: {
							state: {
								type: "string",
								enum: ["active", "grace", "paused"],
								description:
									"active: in good standing. grace: a daily storage charge was more than the balance, uploads are blocked and playback continues until pausesAt. paused: playback is paused until credits are added.",
							},
							pausesAt: {
								type: ["string", "null"],
								format: "date-time",
								description:
									"When playback pauses, 7 days after the app first fell short. Null while active.",
							},
						},
					},
					upload: {
						type: "object",
						required: [
							"allowed",
							"reason",
							"requiredMicroCredits",
							"shortfallMicroCredits",
							"message",
						],
						properties: {
							allowed: {
								type: "boolean",
								description: "Whether the app can create a video right now.",
							},
							reason: {
								type: ["string", "null"],
								enum: [
									"no_account",
									"out_of_credit",
									"insufficient_credits",
									null,
								],
							},
							requiredMicroCredits: {
								type: "integer",
								description:
									"Balance needed to upload: 7 days of storage for everything stored.",
							},
							shortfallMicroCredits: {
								type: "integer",
								description:
									"How much to add before uploading. 0 when allowed.",
							},
							message: { type: ["string", "null"] },
						},
					},
					storage: {
						type: "object",
						required: [
							"minutesByTier",
							"dailyMicroCredits",
							"monthlyMicroCredits",
						],
						properties: {
							minutesByTier: {
								type: "object",
								description:
									"Minutes stored in each resolution tier. A video counts in the lower of its maxResolutionTier and the tier of its source by pixel count: up to 2,073,600 pixels, up to 4,194,304 pixels, and above.",
								required: ["1080p", "1440p", "2160p"],
								properties: {
									"1080p": { type: "number" },
									"1440p": { type: "number" },
									"2160p": { type: "number" },
								},
							},
							dailyMicroCredits: {
								type: "integer",
								description:
									"What one day of storage costs at what is stored now.",
							},
							monthlyMicroCredits: {
								type: "integer",
								description: "The same over a 30 day month.",
							},
						},
					},
					rates: {
						type: "object",
						description:
							"The prices and rules the other fields are built from.",
						required: [
							"microCreditsPerDollar",
							"storageDollarsPer1000MinutesPerMonth",
							"speechDollarsPerHour",
							"uploadAdmissionDays",
						],
						properties: {
							microCreditsPerDollar: {
								type: "integer",
								const: MICRO_CREDITS_PER_DOLLAR,
							},
							storageDollarsPer1000MinutesPerMonth: {
								type: "object",
								description:
									"Dollars to store 1,000 minutes for a 30 day month, by resolution tier. Storage is charged daily.",
								required: [...INFRA_RESOLUTION_TIERS],
								properties: Object.fromEntries(
									INFRA_RESOLUTION_TIERS.map((tier) => [
										tier,
										{ type: "number" },
									]),
								),
							},
							speechDollarsPerHour: {
								type: "number",
								description: "Dollars to transcribe one hour of audio.",
							},
							uploadAdmissionDays: {
								type: "integer",
								const: UPLOAD_ADMISSION_DAYS,
								description:
									"An upload is accepted when the balance covers this many days of storage for everything the app stores.",
							},
						},
					},
				},
			},
			CreateUploadRequest: {
				type: "object",
				additionalProperties: false,
				properties: {
					name: { type: "string", maxLength: 255 },
					userId: {
						type: "string",
						maxLength: 255,
						description: "Your own user ID, for filtering listDeveloperVideos.",
					},
					maxResolutionTier: {
						type: "string",
						enum: ["1080p", "1440p", "2160p"],
						default: "1080p",
						description: "Highest resolution to encode this video at.",
					},
					metadata: {
						type: "object",
						additionalProperties: true,
						description: "Arbitrary JSON under 8 KB.",
					},
					corsOrigin: {
						type: "string",
						description:
							"Exact origin of the page that uploads, such as https://app.example.com, with no path or trailing slash. When set, the upload operations refuse a request whose Origin header differs. Leave it out to accept any origin.",
					},
					timeoutSeconds: {
						type: "integer",
						minimum: 60,
						maximum: 86400,
						default: 3600,
						description:
							"How long the upload token works. The upload must complete within this time, or the token must be renewed with renewUploadToken.",
					},
					maxBytes: uploadMaxBytes,
				},
			},
			RenewUploadTokenRequest: {
				type: "object",
				additionalProperties: false,
				description:
					"Options for the new token. It carries only what is sent here, not the options of the token it replaces.",
				properties: {
					corsOrigin: {
						type: "string",
						description:
							"Exact origin of the page that uploads. Leave it out to accept any origin.",
					},
					timeoutSeconds: {
						type: "integer",
						minimum: 60,
						maximum: 86400,
						default: 3600,
						description: "How long the new token works.",
					},
					maxBytes: uploadMaxBytes,
				},
			},
			UploadToken: {
				type: "object",
				required: [
					"id",
					"videoId",
					"token",
					"expiresAt",
					"corsOrigin",
					"maxBytes",
					"status",
					"uploadUrl",
				],
				properties: {
					id: { type: "string", description: "Equals videoId." },
					videoId: { type: "string" },
					token: {
						type: "string",
						description:
							"New upload token (`cut_...`) for this video. It is returned once.",
					},
					expiresAt: { type: "string", format: "date-time" },
					corsOrigin: { type: ["string", "null"] },
					maxBytes: { type: ["integer", "null"] },
					status: { type: "string", const: "uploading" },
					uploadUrl: {
						type: "string",
						format: "uri",
						description:
							"Base URL of the upload operations: append /initiate, /presign-part, /complete or /abort.",
					},
				},
			},
			Upload: {
				type: "object",
				required: [
					"id",
					"videoId",
					"token",
					"expiresAt",
					"corsOrigin",
					"maxBytes",
					"status",
					"uploadUrl",
					"playbackId",
					"shareUrl",
					"embedUrl",
				],
				properties: {
					id: {
						type: "string",
						description:
							"The upload's ID. Each video takes one upload, so this equals videoId.",
					},
					videoId: { type: "string" },
					token: {
						type: "string",
						description:
							"Upload token (`cut_...`) for this video. Send it as the Bearer credential of the upload operations. It is returned once.",
					},
					expiresAt: { type: "string", format: "date-time" },
					corsOrigin: { type: ["string", "null"] },
					maxBytes: {
						type: ["integer", "null"],
						description:
							"The size cap the token carries, or null when it has none beyond the 36 GB limit.",
					},
					status: { type: "string", const: "uploading" },
					uploadUrl: {
						type: "string",
						format: "uri",
						description:
							"Base URL of the upload operations: append /initiate, /presign-part, /complete or /abort.",
					},
					playbackId: { type: "string" },
					shareUrl: {
						type: "string",
						format: "uri",
						description: PLAYER_PAGE_DESCRIPTION,
					},
					embedUrl: {
						type: "string",
						format: "uri",
						description: PLAYER_EMBED_DESCRIPTION,
					},
				},
			},
			InitiateUploadRequest: {
				type: "object",
				properties: {
					videoId: {
						type: "string",
						description:
							"Optional. The token already names the video; a different videoId returns 403 with code video_mismatch.",
					},
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
					contentLength: {
						type: "integer",
						minimum: 1,
						description:
							"Optional size of the whole file in bytes. When it is over the token's maxBytes or the 36 GB limit, the upload is refused here instead of at completeSdkUpload. The stored size is checked at completeSdkUpload either way.",
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
				required: ["uploadId"],
				oneOf: [{ required: ["partNumbers"] }, { required: ["partNumber"] }],
				properties: {
					videoId: {
						type: "string",
						description:
							"Optional. The token already names the video; a different videoId returns 403 with code video_mismatch.",
					},
					uploadId: { type: "string" },
					partNumbers: {
						type: "array",
						minItems: 1,
						maxItems: 50,
						items: { type: "integer", minimum: 1, maximum: 10000 },
						description:
							"Part numbers to sign in this request. The response has parts.",
					},
					partNumber: {
						type: "integer",
						minimum: 1,
						maximum: 10000,
						description:
							"One part number to sign. The response has presignedUrl.",
					},
				},
			},
			PresignPartResponse: {
				oneOf: [
					{
						type: "object",
						required: ["parts"],
						description: "Answer to a request with partNumbers.",
						properties: {
							parts: {
								type: "array",
								items: {
									type: "object",
									required: ["partNumber", "presignedUrl"],
									properties: {
										partNumber: { type: "integer" },
										presignedUrl: { type: "string", format: "uri" },
									},
								},
							},
						},
					},
					{
						type: "object",
						required: ["presignedUrl"],
						description: "Answer to a request with partNumber.",
						properties: { presignedUrl: { type: "string", format: "uri" } },
					},
				],
			},
			CompleteUploadRequest: {
				type: "object",
				required: ["uploadId", "parts", "durationInSecs"],
				properties: {
					videoId: {
						type: "string",
						description:
							"Optional. The token already names the video; a different videoId returns 403 with code video_mismatch.",
					},
					uploadId: { type: "string" },
					parts: {
						type: "array",
						minItems: 1,
						description:
							"Every uploaded part. Each part except the last must be at least 5 MB.",
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
				required: ["uploadId"],
				properties: {
					videoId: {
						type: "string",
						description:
							"Optional. The token already names the video; a different videoId returns 403 with code video_mismatch.",
					},
					uploadId: { type: "string" },
				},
			},
			WebhookEndpoint: {
				type: "object",
				required: [
					"id",
					"url",
					"events",
					"enabled",
					"disabledReason",
					"secretPrefix",
					"lastDeliveryAt",
					"lastDeliveryStatus",
					"lastResponseStatus",
					"lastErrorCode",
					"consecutiveFailures",
					"createdAt",
					"updatedAt",
				],
				properties: {
					id: { type: "string" },
					url: { type: "string", format: "uri" },
					events: webhookEventsProperty,
					enabled: {
						type: "boolean",
						description: "Events are only sent to an enabled endpoint.",
					},
					disabledReason: {
						type: ["string", "null"],
						enum: ["delivery_failures", null],
						description: `delivery_failures when Cap disabled the endpoint after at least ${WEBHOOK_DISABLE_AFTER_FAILURES} failed attempts in a row over five days or more. null otherwise.`,
					},
					secretPrefix: {
						type: "string",
						description:
							"The first characters of the signing secret, to tell endpoints apart. The secret itself is only returned when the endpoint is created.",
					},
					lastDeliveryAt: {
						type: ["string", "null"],
						format: "date-time",
						description: "When Cap last called the endpoint.",
					},
					lastDeliveryStatus: {
						type: ["string", "null"],
						enum: ["succeeded", "failed", null],
					},
					lastResponseStatus: {
						type: ["integer", "null"],
						description:
							"The HTTP status the endpoint last answered with, or null when it did not answer.",
					},
					lastErrorCode: {
						type: ["string", "null"],
						enum: [
							"http_error",
							"redirect",
							"timeout",
							"connection_failed",
							"private_address",
							"invalid_url",
							"https_required",
							"credentials_in_url",
							"unsupported_port",
							null,
						],
						description:
							"Why the last delivery failed: http_error for a status outside 2xx, redirect for a 3xx (redirects are not followed), timeout for no answer in 10 seconds, connection_failed when the connection or TLS handshake failed, private_address when the host resolved to a private or reserved address. null after a success.",
					},
					consecutiveFailures: {
						type: "integer",
						description: "Failed attempts since the last success.",
					},
					createdAt: { type: "string", format: "date-time" },
					updatedAt: {
						type: "string",
						format: "date-time",
						description:
							"When the endpoint's settings last changed. Deliveries do not move it.",
					},
				},
			},
			WebhookEndpointWithSecret: {
				allOf: [
					ref("WebhookEndpoint"),
					{
						type: "object",
						required: ["secret"],
						properties: {
							secret: {
								type: "string",
								description:
									"The signing secret, starting with cws_. Returned once, when the endpoint is created.",
							},
						},
					},
				],
			},
			WebhookEndpointList: {
				type: "object",
				required: ["data", "pagination"],
				properties: {
					data: { type: "array", items: ref("WebhookEndpoint") },
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
			CreateWebhookEndpointRequest: {
				type: "object",
				additionalProperties: false,
				required: ["url"],
				properties: {
					url: { type: "string", format: "uri", maxLength: 2048 },
					events: {
						...webhookEventsProperty,
						description:
							"The event types to send. Leave it out to receive every type.",
					},
					enabled: { type: "boolean", default: true },
				},
			},
			UpdateWebhookEndpointRequest: {
				type: "object",
				additionalProperties: false,
				minProperties: 1,
				properties: {
					url: { type: "string", format: "uri", maxLength: 2048 },
					events: webhookEventsProperty,
					enabled: { type: "boolean" },
				},
			},
			WebhookTestResult: {
				type: "object",
				required: [
					"eventId",
					"type",
					"delivered",
					"responseStatus",
					"errorCode",
					"durationMs",
				],
				properties: {
					eventId: { type: "string" },
					type: { type: "string", const: WEBHOOK_TEST_EVENT_TYPE },
					delivered: {
						type: "boolean",
						description: "true when the endpoint answered with a 2xx status.",
					},
					responseStatus: { type: ["integer", "null"] },
					errorCode: {
						type: ["string", "null"],
						description:
							"Why the delivery failed, with the same values as lastErrorCode. null when delivered.",
					},
					durationMs: { type: "integer" },
				},
			},
		},
		responses: {
			BadRequest: json(
				{ anyOf: [ref("ValidationError"), ref("Error")] },
				"The request is malformed or failed validation. The code says which: invalid_json, invalid_request (with issues), or a code specific to the operation.",
			),
			Unauthorized: json(
				ref("Error"),
				"The API key is missing, invalid or revoked. On the upload operations the code is invalid_upload_token when the upload token is missing, malformed or altered, or when the secret key that created it was revoked (the hint says so, and renewUploadToken with the current key continues the upload), and upload_token_expired once it has expired.",
			),
			PaymentRequired: json(
				ref("Error"),
				"The app cannot start a transcript. The code is out_of_credit when the app is not in good standing and insufficient_credits when the available balance is under the minimum, and the message says how much to add.",
			),
			UploadPaymentRequired: json(
				ref("UploadPaymentRequired"),
				"The app is out of credit or its balance does not cover 7 days of storage. The body says how much is needed.",
			),
			Forbidden: json(
				ref("Error"),
				"The request is not allowed. The code is public_key_not_allowed when a public key was sent where a secret key or upload token is required. On the upload operations the code is origin_not_allowed when the Origin header differs from the token's corsOrigin, and video_mismatch when the body names a video other than the token's. Elsewhere, the account cannot use this feature yet.",
			),
			NotFound: json(
				ref("Error"),
				"The video, transcript, upload or route does not exist. The code is video_not_found, transcript_not_found, upload_not_found or not_found.",
			),
			UnsupportedMediaType: json(
				ref("Error"),
				"The body was sent without Content-Type: application/json (code unsupported_media_type).",
			),
			Conflict: json(
				ref("Error"),
				"The request conflicts with the current state, for example a file that has not been uploaded yet or a reused Idempotency-Key.",
			),
			Unavailable: json(
				ref("Error"),
				"Transcription is temporarily unavailable. Retry later.",
			),
			CompletionInProgress: json(
				ref("Error"),
				"Another request is completing this upload (code completion_in_progress). On complete it carries a Retry-After header: wait for those seconds, then send the same request again, and repeat while it answers this way, which can last up to 15 minutes if an earlier request was cut off. Do not abort or delete. On complete, code upload_removed means the upload was removed after a day unrecorded: create a new upload and upload again. On abort, code upload_already_completed means the upload completed and the token no longer works.",
			),
			UploadCompleted: json(
				ref("Error"),
				"The video's upload already completed (code upload_already_completed), so its upload token no longer works and cannot be renewed. Create a new upload to upload again.",
			),
			RateLimited: {
				...json(
					ref("Error"),
					`More requests in a minute than the credential allows: ${DEVELOPER_KEY_REQUESTS_PER_MINUTE} for a secret key, ${DEVELOPER_OWNER_REQUESTS_PER_MINUTE} for all the keys of one account, ${DEVELOPER_UPLOAD_TOKEN_REQUESTS_PER_MINUTE} for an upload token (code rate_limited).`,
				),
				headers: {
					...rateLimitHeaders,
					"Retry-After": {
						description: `Seconds to wait before retrying, at most ${DEVELOPER_RATE_LIMIT_WINDOW_SECONDS}.`,
						schema: { type: "integer" },
					},
				},
			},
			InternalError: json(
				ref("Error"),
				"Unexpected server error (code internal_error). Retry with backoff.",
			),
			WebhookNotFound: json(
				ref("Error"),
				"No webhook endpoint with this ID belongs to the app (code webhook_not_found).",
			),
			WebhookLimitReached: json(
				ref("Error"),
				`The app already has ${MAX_WEBHOOK_ENDPOINTS_PER_APP} webhook endpoints (code webhook_limit_reached). Delete one first.`,
			),
		},
		headers: {
			RateLimitLimit: {
				description: `Requests the credential may make per minute: ${DEVELOPER_KEY_REQUESTS_PER_MINUTE} for a secret key, ${DEVELOPER_UPLOAD_TOKEN_REQUESTS_PER_MINUTE} for an upload token.`,
				schema: { type: "integer" },
			},
			RateLimitRemaining: {
				description:
					"Requests left this minute as counted by the server that answered. A guide: it can read higher than what is left. 0 on a 429.",
				schema: { type: "integer" },
			},
			RateLimitReset: {
				description:
					"Seconds until the count on the server that answered starts again. On a 429, the same value as Retry-After.",
				schema: { type: "integer" },
			},
		},
	},
});
