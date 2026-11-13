import { createHash, randomBytes } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

type Json = Record<string, unknown>;

type StubVideo = {
	id: string;
	name: string;
	status: "uploading" | "processing" | "ready" | "errored";
	externalUserId: string | null;
	duration: number | null;
	playbackId: string;
	metadata: unknown;
	maxResolutionTier: string;
	createdAt: string;
	deleted: boolean;
	polls: number;
	readyReads: number;
	uploadId: string | null;
	parts: Map<number, { etag: string; bytes: Buffer; secret: string }>;
	file: Buffer | null;
	aborted: number;
};

type StubTranscript = {
	id: string;
	status: "uploading" | "queued" | "processing" | "complete" | "error";
	name: string;
	sourceType: "url" | "upload";
	sourceUrl: string | null;
	userId: string | null;
	metadata: unknown;
	language: string | null;
	createdAt: string;
	polls: number;
	contentLength: number | null;
	secret: string | null;
	file: Buffer | null;
	idempotencyKey: string | null;
	errorCode: string | null;
	deleted: boolean;
};

export type StubRequest = {
	method: string;
	path: string;
	query: Record<string, string>;
	headers: IncomingMessage["headers"];
	body: unknown;
	at: number;
};

export type CreditRefusal = "out_of_credit" | "insufficient_credits" | null;

export type ScriptedReply = {
	status: number;
	retryAfterSeconds?: number;
	delayMs?: number;
};

const DOCS = "https://cap.so/docs/api/rest-api";
const REST = "/api/developer/v1";
const SDK = "/api/developer/sdk/v1/upload/multipart";
const TRANSCRIPT_TEXT = "Morning everyone. Quick update from my side.";

const id = (bytes = 8) => randomBytes(bytes).toString("hex");

const apiError = (code: string, message: string, hint: string) => ({
	error: message,
	code,
	message,
	hint,
	docs: DOCS,
});

export async function startStubApi() {
	const secretKey = `csk_${id(15)}`;
	const videos = new Map<string, StubVideo>();
	const transcripts = new Map<string, StubTranscript>();
	const tokens = new Map<string, { videoId: string; expired: boolean }>();
	const requests: StubRequest[] = [];
	const secrets = new Set<string>([secretKey]);
	const state = {
		credit: null as CreditRefusal,
		rateLimited: 0,
		retryAfterSeconds: 1,
		unavailable: 0,
		uploadRateLimited: 0,
		readyAfterPolls: 2,
		failParts: new Map<number, number>(),
		partDelayMs: 0,
		completionBusy: 0,
		completionRetryAfterSeconds: null as number | null,
		videoListPagination: true,
		hang: null as ((request: StubRequest) => boolean) | null,
		dropAnswer: null as ((request: StubRequest) => boolean) | null,
		intercept: null as ((request: StubRequest) => ScriptedReply | null) | null,
		hlsAfterReads: 0,
		mp4AfterReads: 0,
		mp4Failed: false,
		failAfterAssembly: 0,
		refuseTranscriptFile: false,
		videoOutcome: "ready" as "ready" | "errored",
		transcriptOutcome: "complete" as "complete" | "insufficient_credits",
		usageAppId: "app_stub" as string | null,
	};
	let origin = "";

	const issueToken = (videoId: string) => {
		const token = `cut_${id(24)}.${id(16)}`;
		tokens.set(token, { videoId, expired: false });
		secrets.add(token);
		return {
			id: videoId,
			videoId,
			token,
			expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
			corsOrigin: null,
			maxBytes: null,
			status: "uploading",
			uploadUrl: `${origin}${SDK}`,
		};
	};

	const links = (video: StubVideo) => {
		const ready = video.status === "ready";
		const base = `${origin}/api/developer/playback/${video.playbackId}`;
		return {
			hlsUrl:
				ready && video.readyReads >= state.hlsAfterReads
					? `${base}/master.m3u8`
					: null,
			mp4Url:
				ready && !state.mp4Failed && video.readyReads >= state.mp4AfterReads
					? `${base}/video.mp4`
					: null,
			posterUrl: ready ? `${base}/poster.jpg` : null,
		};
	};

	const pages = (video: StubVideo) => ({
		shareUrl: `${origin}/dev/${video.playbackId}`,
		embedUrl: `${origin}/dev/${video.playbackId}/embed`,
	});

	const videoJson = (video: StubVideo) => ({
		id: video.id,
		appId: "app_stub",
		externalUserId: video.externalUserId,
		name: video.name,
		duration: video.duration,
		width: video.status === "ready" ? 1920 : null,
		height: video.status === "ready" ? 1080 : null,
		fps: null,
		status: video.status,
		errorReason: video.status === "errored" ? "The file is not a video" : null,
		transcriptionStatus: null,
		metadata: video.metadata ?? null,
		maxResolutionTier: video.maxResolutionTier,
		playbackId: video.playbackId,
		renditions: [],
		createdAt: video.createdAt,
		updatedAt: video.createdAt,
		deletedAt: null,
		addedInALaterRelease: { anything: true },
		...links(video),
		...pages(video),
	});

	const statusJson = (video: StubVideo) => ({
		id: video.id,
		externalUserId: video.externalUserId,
		duration: video.duration,
		width: null,
		height: null,
		transcriptionStatus: null,
		ready: video.status === "ready",
		status: video.status,
		errorReason: video.status === "errored" ? "The file is not a video" : null,
		playbackId: video.playbackId,
		renditions: [],
		...links(video),
	});

	const transcriptJson = (transcript: StubTranscript, withText = false) => {
		const complete = transcript.status === "complete";
		return {
			id: transcript.id,
			status: transcript.status,
			name: transcript.name,
			source:
				transcript.sourceType === "url"
					? { type: "url", url: transcript.sourceUrl }
					: { type: "upload", url: null },
			durationSeconds: complete ? 754.2 : null,
			language: complete ? "en" : null,
			wordCount: complete ? 7 : null,
			...(withText ? { text: complete ? TRANSCRIPT_TEXT : null } : {}),
			costMicroCredits: complete ? 2094 : 0,
			costDollars: complete ? 0.02094 : 0,
			error:
				transcript.status === "error"
					? {
							code: transcript.errorCode ?? "transcription_failed",
							message: "The transcript could not be created",
						}
					: null,
			userId: transcript.userId,
			metadata: transcript.metadata ?? null,
			createdAt: transcript.createdAt,
			updatedAt: transcript.createdAt,
			completedAt: complete ? transcript.createdAt : null,
			addedInALaterRelease: 1,
		};
	};

	const creditRefusal = (shape: "upload" | "transcript") => {
		const code = state.credit ?? "insufficient_credits";
		const message =
			code === "out_of_credit"
				? "This app is out of credit. Add at least $0.25 to resume."
				: "The balance is $0.05, so add at least $0.14834.";
		return shape === "upload"
			? {
					error: "Insufficient credits",
					code,
					message,
					standing: code === "out_of_credit" ? "grace" : "active",
					pausesAt: null,
					balanceMicroCredits: 5000,
					requiredMicroCredits: 19834,
					shortfallMicroCredits: 14834,
				}
			: apiError(code, message, "Add credits, then send the request again.");
	};

	const send = (
		response: ServerResponse,
		status: number,
		body: unknown,
		headers: Record<string, string> = {},
	) => {
		response.writeHead(status, {
			"Content-Type": "application/json",
			...headers,
		});
		response.end(JSON.stringify(body));
	};

	const unknownField = (
		response: ServerResponse,
		body: Json,
		allowed: readonly string[],
	) => {
		const stray = Object.keys(body).find((name) => !allowed.includes(name));
		if (stray === undefined) return false;
		send(response, 400, {
			...apiError(
				"invalid_request",
				`Invalid request: Unrecognized key: "${stray}"`,
				`This request accepts ${allowed.join(", ")}. Field names are case-sensitive.`,
			),
			issues: [
				{
					code: "unrecognized_keys",
					keys: [stray],
					path: [],
					message: `Unrecognized key: "${stray}"`,
				},
			],
		});
		return true;
	};

	const unknownQuery = (
		response: ServerResponse,
		query: Record<string, string>,
		allowed: readonly string[],
	) => {
		const stray = Object.keys(query).find((name) => !allowed.includes(name));
		if (stray === undefined) return false;
		send(
			response,
			400,
			apiError(
				"unknown_parameter",
				`Unknown query parameter ${stray}`,
				`This list accepts ${allowed.join(", ")}. Parameter names are case-sensitive.`,
			),
		);
		return true;
	};

	const videoNotFound = apiError(
		"video_not_found",
		"Video not found",
		"Check the video ID and that it belongs to this app. Deleted videos are not returned.",
	);
	const transcriptNotFound = apiError(
		"transcript_not_found",
		"Transcript not found",
		"Check the transcript ID and that it belongs to this app.",
	);

	const window = (query: Record<string, string>) => ({
		limit: Number(query.limit ?? 50),
		offset: Number(query.offset ?? 0),
	});

	const rest = (
		request: StubRequest,
		response: ServerResponse,
		path: string,
	) => {
		const body = (request.body ?? {}) as Json;
		const { method, query } = request;
		const [, resource, key, action] = path.split("/");

		if (resource === "videos" && key === undefined && method === "GET") {
			if (
				unknownQuery(response, query, [
					"userId",
					"externalUserId",
					"limit",
					"offset",
				])
			)
				return;
			const { limit, offset } = window(query);
			const found = [...videos.values()]
				.filter((video) => !video.deleted)
				.filter(
					(video) =>
						query.userId === undefined || video.externalUserId === query.userId,
				)
				.reverse();
			return send(response, 200, {
				data: found.slice(offset, offset + limit).map(videoJson),
				...(state.videoListPagination
					? {
							pagination: {
								limit,
								offset,
								hasMore: found.length > offset + limit,
							},
						}
					: {}),
			});
		}

		if (resource === "videos" && key !== undefined) {
			if (unknownQuery(response, query, ["userId", "externalUserId"])) return;
			const video = videos.get(key);
			const visible =
				video &&
				!video.deleted &&
				(query.userId === undefined || video.externalUserId === query.userId);
			if (!video || !visible) return send(response, 404, videoNotFound);
			if (method === "GET" && action === undefined) {
				const data = videoJson(video);
				if (video.status === "ready") video.readyReads++;
				return send(response, 200, { data });
			}
			if (method === "GET" && action === "status") {
				if (video.status === "processing") {
					video.polls++;
					if (video.polls >= state.readyAfterPolls) {
						video.status = state.videoOutcome;
					}
				}
				const data = statusJson(video);
				if (video.status === "ready") video.readyReads++;
				return send(response, 200, { data });
			}
			if (method === "DELETE" && action === undefined) {
				video.deleted = true;
				return send(response, 200, { success: true });
			}
		}

		if (resource === "uploads" && key === undefined && method === "POST") {
			if (
				unknownField(response, body, [
					"name",
					"userId",
					"maxResolutionTier",
					"metadata",
					"corsOrigin",
					"timeoutSeconds",
					"maxBytes",
				])
			)
				return;
			if (state.credit) return send(response, 402, creditRefusal("upload"));
			const video: StubVideo = {
				id: id(),
				name: typeof body.name === "string" ? body.name : "Untitled",
				status: "uploading",
				externalUserId: typeof body.userId === "string" ? body.userId : null,
				duration: null,
				playbackId: id(12),
				metadata: body.metadata,
				maxResolutionTier:
					typeof body.maxResolutionTier === "string"
						? body.maxResolutionTier
						: "1080p",
				createdAt: new Date().toISOString(),
				deleted: false,
				polls: 0,
				readyReads: 0,
				uploadId: null,
				parts: new Map(),
				file: null,
				aborted: 0,
			};
			videos.set(video.id, video);
			return send(response, 200, {
				data: {
					...issueToken(video.id),
					playbackId: video.playbackId,
					...pages(video),
				},
			});
		}

		if (
			resource === "uploads" &&
			key !== undefined &&
			action === "token" &&
			method === "POST"
		) {
			if (
				unknownField(response, body, [
					"corsOrigin",
					"timeoutSeconds",
					"maxBytes",
				])
			)
				return;
			const video = videos.get(key);
			if (!video || video.deleted) return send(response, 404, videoNotFound);
			if (video.duration !== null) {
				return send(
					response,
					409,
					apiError(
						"upload_already_completed",
						"Upload already completed",
						"Create a new upload.",
					),
				);
			}
			return send(response, 200, { data: issueToken(video.id) });
		}

		if (resource === "transcripts" && key === undefined && method === "POST") {
			if (
				unknownField(response, body, [
					"url",
					"name",
					"language",
					"userId",
					"metadata",
				])
			)
				return;
			if (state.credit) return send(response, 402, creditRefusal("transcript"));
			const transcript = newTranscript(body, "url", request);
			transcript.sourceUrl = String(body.url);
			transcript.status = "queued";
			return send(response, 200, { data: transcriptJson(transcript) });
		}

		if (
			resource === "transcripts" &&
			key === "uploads" &&
			action === undefined &&
			method === "POST"
		) {
			if (
				unknownField(response, body, [
					"fileName",
					"contentLength",
					"name",
					"language",
					"userId",
					"metadata",
				])
			)
				return;
			if (state.credit) return send(response, 402, creditRefusal("transcript"));
			const transcript = newTranscript(body, "upload", request);
			transcript.contentLength = Number(body.contentLength);
			transcript.secret = id(32);
			const url = `${origin}/storage/transcripts/${transcript.id}?X-Amz-Expires=3600&X-Amz-Signature=${transcript.secret}`;
			secrets.add(transcript.secret);
			secrets.add(url);
			return send(response, 200, {
				data: {
					...transcriptJson(transcript),
					upload: {
						method: "PUT",
						url,
						headers: { "Content-Length": String(transcript.contentLength) },
						expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
					},
				},
			});
		}

		if (resource === "transcripts" && key === undefined && method === "GET") {
			if (
				unknownQuery(response, query, ["userId", "status", "limit", "offset"])
			)
				return;
			const { limit, offset } = window(query);
			const found = [...transcripts.values()]
				.filter((transcript) => !transcript.deleted)
				.filter(
					(transcript) =>
						(query.userId === undefined ||
							transcript.userId === query.userId) &&
						(query.status === undefined || transcript.status === query.status),
				)
				.reverse();
			return send(response, 200, {
				data: found
					.slice(offset, offset + limit)
					.map((transcript) => transcriptJson(transcript)),
				pagination: { limit, offset, hasMore: found.length > offset + limit },
			});
		}

		if (resource === "transcripts" && key !== undefined) {
			const transcript = transcripts.get(key);
			if (!transcript || transcript.deleted) {
				return send(response, 404, transcriptNotFound);
			}
			if (method === "POST" && action === "start") {
				if (transcript.status === "uploading") {
					if (transcript.file === null) {
						return send(
							response,
							409,
							apiError(
								"upload_not_found",
								"The file has not been uploaded yet",
								"PUT the file to the upload URL, then start again.",
							),
						);
					}
					transcript.status = "queued";
				}
				return send(response, 200, { data: transcriptJson(transcript) });
			}
			if (method === "GET" && action === undefined) {
				if (unknownQuery(response, query, ["include"])) return;
				if (
					transcript.status === "queued" ||
					transcript.status === "processing"
				) {
					transcript.polls++;
					transcript.status = "processing";
					if (transcript.polls >= state.readyAfterPolls) {
						if (state.transcriptOutcome === "complete") {
							transcript.status = "complete";
						} else {
							transcript.status = "error";
							transcript.errorCode = state.transcriptOutcome;
						}
					}
				}
				const include = (query.include ?? "").split(",");
				const complete = transcript.status === "complete";
				return send(response, 200, {
					data: {
						...transcriptJson(transcript, true),
						...(include.includes("words")
							? {
									words: complete
										? [{ text: "Morning", start: 0, end: 0.4, confidence: 0.9 }]
										: null,
								}
							: {}),
						...(include.includes("segments")
							? {
									segments: complete
										? [{ text: "Morning everyone.", start: 0, end: 1.1 }]
										: null,
								}
							: {}),
					},
				});
			}
			if (method === "DELETE" && action === undefined) {
				transcript.deleted = true;
				return send(response, 200, { success: true });
			}
		}

		if (resource === "usage" && key === undefined && method === "GET") {
			return send(response, 200, {
				data: {
					...(state.usageAppId === null ? {} : { appId: state.usageAppId }),
					balanceMicroCredits: 500000,
					balanceDollars: "5.00",
					totalVideos: videos.size,
					uploadingVideos: 0,
					totalDurationMinutes: 87.5,
					standing: {
						state: state.credit === "out_of_credit" ? "grace" : "active",
						pausesAt: null,
					},
					upload: {
						allowed: state.credit === null,
						reason: state.credit,
						requiredMicroCredits: 1736,
						shortfallMicroCredits: state.credit === null ? 0 : 1236,
						message:
							state.credit === null
								? null
								: "The balance is $0.005, so add at least $0.01236.",
					},
					storage: {
						minutesByTier: { "1080p": 87.5, "1440p": 0, "2160p": 0 },
						dailyMicroCredits: 247,
						monthlyMicroCredits: 7438,
					},
					availableMicroCredits: 460000,
					heldMicroCredits: 40000,
					speech: {
						periodStart: "2026-11-01T00:00:00.000Z",
						seconds: 2262,
						microCredits: 6283,
						transcripts: 3,
					},
					rates: {
						microCreditsPerDollar: 100000,
						storageDollarsPer1000MinutesPerMonth: {
							"1080p": 0.85,
							"1440p": 1.45,
							"2160p": 2.8,
						},
						speechDollarsPerHour: 0.1,
						uploadAdmissionDays: 7,
					},
				},
			});
		}

		if (resource === "transactions" && key === undefined && method === "GET") {
			if (unknownQuery(response, query, ["limit", "offset"])) return;
			const { limit, offset } = window(query);
			const rows = Array.from({ length: 3 }, (_, index) => ({
				id: `txn_${index}`,
				type: index === 2 ? "topup" : "storage_daily",
				description: index === 2 ? "Top-up" : "Storage",
				note: null,
				amountMicroCredits: index === 2 ? 500000 : -247,
				amountDollars: index === 2 ? "+5.00" : "-0.00247",
				balanceAfterMicroCredits: 500000 - index * 247,
				balanceAfterDollars: "5.00",
				referenceType: null,
				referenceId: null,
				createdAt: new Date(2026, 10, 12 - index).toISOString(),
				accountId: "internal",
			}));
			return send(response, 200, {
				data: rows.slice(offset, offset + limit),
				pagination: { limit, offset, hasMore: rows.length > offset + limit },
			});
		}

		send(
			response,
			404,
			apiError(
				"not_found",
				`No API route matches ${request.path}`,
				"Check the method and path against the OpenAPI description at /openapi.json.",
			),
		);
	};

	const newTranscript = (
		body: Json,
		sourceType: "url" | "upload",
		request: StubRequest,
	) => {
		const transcript: StubTranscript = {
			id: id(),
			status: "uploading",
			name:
				typeof body.name === "string"
					? body.name
					: typeof body.fileName === "string"
						? body.fileName
						: "Untitled",
			sourceType,
			sourceUrl: null,
			userId: typeof body.userId === "string" ? body.userId : null,
			metadata: body.metadata,
			language: typeof body.language === "string" ? body.language : null,
			createdAt: new Date().toISOString(),
			polls: 0,
			contentLength: null,
			secret: null,
			file: null,
			idempotencyKey:
				typeof request.headers["idempotency-key"] === "string"
					? request.headers["idempotency-key"]
					: null,
			errorCode: null,
			deleted: false,
		};
		transcripts.set(transcript.id, transcript);
		return transcript;
	};

	const sdk = (
		request: StubRequest,
		response: ServerResponse,
		action: string,
	) => {
		const credential = request.headers.authorization?.split(" ")[1] ?? "";
		const token = tokens.get(credential);
		if (!token) {
			return send(
				response,
				401,
				apiError(
					"invalid_upload_token",
					"Upload token is not valid",
					"Create an upload from your server.",
				),
			);
		}
		if (token.expired) {
			return send(
				response,
				401,
				apiError(
					"upload_token_expired",
					"Upload token has expired",
					"Get a new token for the same video from your server.",
				),
			);
		}
		if (state.uploadRateLimited > 0) {
			state.uploadRateLimited--;
			return send(
				response,
				429,
				apiError(
					"rate_limited",
					"Rate limit exceeded",
					"Wait for the Retry-After seconds, then retry. Each upload token allows 1200 requests per minute.",
				),
				{ "Retry-After": String(state.retryAfterSeconds) },
			);
		}
		const body = (request.body ?? {}) as Json;
		if (body.videoId !== undefined && body.videoId !== token.videoId) {
			return send(
				response,
				403,
				apiError(
					"video_mismatch",
					"This upload token is for a different video",
					"Leave videoId out.",
				),
			);
		}
		const video = videos.get(token.videoId);
		if (!video || video.deleted) return send(response, 404, videoNotFound);
		const uploadNotFound = apiError(
			"upload_not_found",
			"No open upload matches the uploadId",
			"Call initiate again and upload the parts again.",
		);

		if (action === "initiate") {
			video.uploadId ??= `upload_${id()}`;
			return send(response, 200, { uploadId: video.uploadId });
		}
		if (body.uploadId !== video.uploadId || video.uploadId === null) {
			return send(response, 404, uploadNotFound);
		}
		if (action === "presign-part") {
			const numbers = Array.isArray(body.partNumbers) ? body.partNumbers : [];
			if (numbers.length < 1 || numbers.length > 50) {
				return send(
					response,
					400,
					apiError(
						"invalid_part_count",
						"Ask for 1 to 50 parts at a time",
						"Split the part numbers across several presign requests.",
					),
				);
			}
			return send(response, 200, {
				parts: numbers.map((partNumber) => {
					const secret = id(32);
					const url = `${origin}/storage/videos/${video.id}/${partNumber}?uploadId=${video.uploadId}&X-Amz-Signature=${secret}`;
					secrets.add(secret);
					secrets.add(url);
					return { partNumber, presignedUrl: url };
				}),
			});
		}
		if (action === "complete") {
			if (state.completionBusy > 0) {
				state.completionBusy--;
				return send(
					response,
					409,
					apiError(
						"completion_in_progress",
						"Another request is completing this upload. Try again shortly.",
						"Wait for the Retry-After seconds, then send the same request again. Do not abort or delete.",
					),
					state.completionRetryAfterSeconds === null
						? {}
						: { "Retry-After": String(state.completionRetryAfterSeconds) },
				);
			}
			if (video.duration !== null)
				return send(response, 200, { success: true });
			const record = () => {
				if (state.failAfterAssembly > 0) {
					state.failAfterAssembly--;
					return send(
						response,
						500,
						apiError(
							"internal_error",
							"Failed to complete upload",
							"Retry with backoff. If the error persists, contact hello@cap.so.",
						),
					);
				}
				if (state.credit) {
					video.file = null;
					return send(response, 402, {
						...creditRefusal("upload"),
						fileRemoved: true,
					});
				}
				video.duration = Number(body.durationInSecs);
				video.status = "processing";
				return send(response, 200, { success: true });
			};
			if (video.file !== null) return record();
			const listed = Array.isArray(body.parts) ? (body.parts as Json[]) : [];
			const matches =
				listed.length > 0 &&
				listed.every(
					(part) =>
						video.parts.get(Number(part.partNumber))?.etag === part.etag &&
						video.parts.get(Number(part.partNumber))?.bytes.length ===
							part.size,
				);
			if (!matches || !(Number(body.durationInSecs) > 0)) {
				return send(
					response,
					400,
					apiError(
						"parts_mismatch",
						"A listed part is missing from storage",
						"Upload the missing part again.",
					),
				);
			}
			if (state.credit) return send(response, 402, creditRefusal("upload"));
			video.file = Buffer.concat(
				listed
					.map((part) => Number(part.partNumber))
					.sort((a, b) => a - b)
					.map(
						(partNumber) =>
							video.parts.get(partNumber)?.bytes ?? Buffer.alloc(0),
					),
			);
			return record();
		}
		if (action === "abort") {
			video.uploadId = null;
			video.parts.clear();
			video.aborted++;
			return send(response, 200, { success: true });
		}
		send(
			response,
			404,
			apiError("not_found", "No API route", "Check the path."),
		);
	};

	const storage = async (
		request: StubRequest,
		response: ServerResponse,
		bytes: Buffer,
	) => {
		const [, , kind, key, part] = request.path.split("/");
		const signature = request.query["X-Amz-Signature"] ?? "";
		if (request.method !== "PUT" || !secrets.has(signature)) {
			response.writeHead(403).end();
			return;
		}
		if (kind === "transcripts") {
			const transcript = transcripts.get(key ?? "");
			const declared = Number(request.headers["content-length"]);
			if (
				state.refuseTranscriptFile ||
				!transcript ||
				transcript.secret !== signature ||
				declared !== transcript.contentLength ||
				bytes.length !== transcript.contentLength
			) {
				response.writeHead(403).end();
				return;
			}
			transcript.file = bytes;
			response.writeHead(200).end();
			return;
		}
		const video = videos.get(key ?? "");
		const partNumber = Number(part);
		if (!video || request.query.uploadId !== video.uploadId) {
			response.writeHead(404).end();
			return;
		}
		if (state.partDelayMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, state.partDelayMs));
		}
		const failures = state.failParts.get(partNumber) ?? 0;
		if (failures > 0) {
			state.failParts.set(partNumber, failures - 1);
			response.writeHead(500).end();
			return;
		}
		const etag = `"${createHash("md5").update(bytes).digest("hex")}"`;
		video.parts.set(partNumber, { etag, bytes, secret: signature });
		response.writeHead(200, { ETag: etag }).end();
	};

	const silent = {
		writeHead: () => silent,
		end: () => silent,
	} as unknown as ServerResponse;

	const server = createServer((incoming, answer) => {
		const chunks: Buffer[] = [];
		incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
		incoming.on("end", () => {
			const url = new URL(incoming.url ?? "/", origin);
			const bytes = Buffer.concat(chunks);
			const isStorage = url.pathname.startsWith("/storage/");
			let body: unknown = null;
			if (!isStorage && bytes.length > 0) {
				try {
					body = JSON.parse(bytes.toString("utf8"));
				} catch {
					body = undefined;
				}
			}
			const request: StubRequest = {
				method: incoming.method ?? "GET",
				path: url.pathname,
				query: Object.fromEntries(url.searchParams),
				headers: incoming.headers,
				body,
				at: Date.now(),
			};
			requests.push(request);
			if (state.hang?.(request)) return;
			const response = state.dropAnswer?.(request) ? silent : answer;
			if (isStorage) {
				void storage(request, response, bytes);
				return;
			}
			if (url.pathname.startsWith(`${SDK}/`)) {
				return sdk(request, response, url.pathname.slice(SDK.length + 1));
			}
			if (url.pathname.startsWith(`${REST}/`)) {
				if (incoming.headers.authorization !== `Bearer ${secretKey}`) {
					return send(
						response,
						401,
						apiError(
							"invalid_secret_key",
							"Invalid secret key",
							"Send Authorization: Bearer csk_... with a secret key from https://cap.so/dashboard/infra.",
						),
					);
				}
				const scripted = state.intercept?.(request) ?? null;
				if (scripted) {
					const limited = scripted.status === 429;
					setTimeout(
						() =>
							send(
								response,
								scripted.status,
								limited
									? apiError(
											"rate_limited",
											"Rate limit exceeded",
											"Wait for the Retry-After seconds, then retry.",
										)
									: apiError(
											"internal_error",
											"Internal server error",
											"Retry with backoff.",
										),
								scripted.retryAfterSeconds === undefined
									? {}
									: { "Retry-After": String(scripted.retryAfterSeconds) },
							),
						scripted.delayMs ?? 0,
					);
					return;
				}
				if (state.rateLimited > 0) {
					state.rateLimited--;
					return send(
						response,
						429,
						apiError(
							"rate_limited",
							"Rate limit exceeded",
							"Wait for the Retry-After seconds, then retry.",
						),
						{ "Retry-After": String(state.retryAfterSeconds) },
					);
				}
				if (state.unavailable > 0) {
					state.unavailable--;
					return send(
						response,
						503,
						apiError(
							"speech_unavailable",
							"Transcription is temporarily unavailable",
							"Retry later.",
						),
					);
				}
				return rest(request, response, url.pathname.slice(REST.length));
			}
			send(
				response,
				404,
				apiError("not_found", "No API route", "Check the path."),
			);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	return {
		url: origin,
		secretKey,
		state,
		videos,
		transcripts,
		requests,
		secrets,
		expireTokens() {
			for (const token of tokens.values()) token.expired = true;
		},
		calls(method: string, suffix: string) {
			return requests.filter(
				(request) => request.method === method && request.path.endsWith(suffix),
			);
		},
		async close() {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

export type StubApi = Awaited<ReturnType<typeof startStubApi>>;
