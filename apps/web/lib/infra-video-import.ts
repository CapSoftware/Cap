import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	developerApps,
	developerVideoImports,
	developerVideos,
} from "@cap/database/schema";
import type { DeveloperVideoResolutionTier } from "@cap/database/types";
import { and, count, eq, gt, isNull, min } from "drizzle-orm";
import { apiErrorBody } from "@/lib/api-errors";
import { admitDeveloperVideoUpload } from "@/lib/developer-video-charge";
import { announceDeveloperVideoEvent } from "@/lib/developer-webhook-dispatch";
import { scheduleAutoTopUp } from "@/lib/infra-auto-top-up";
import { uploadAdmissionError } from "@/lib/infra-standing";
import {
	STORED_BYTES_PER_SECOND,
	startsLikeAnImageOrDocument,
} from "@/lib/infra-upload";
import {
	INFRA_UPLOAD_CONTENT_TYPES,
	isNonVideoUploadContentType,
	isRefusedUploadContentType,
	UNREADABLE_VIDEO_REASON,
} from "@/lib/infra-video-formats";
import {
	IMPORT_MAX_BYTES,
	IMPORT_MAX_IN_FLIGHT_PER_APP,
	IMPORT_MAX_PER_KEY_PER_HOUR,
	IMPORT_MAX_REDIRECTS,
	IMPORT_PART_BYTES,
	IMPORT_PREFLIGHT_TIMEOUT_MS,
	IMPORT_RATE_WINDOW_MS,
	IMPORT_STALE_SLOT_MS,
	IMPORT_STALL_TIMEOUT_MS,
	IMPORT_TOTAL_TIMEOUT_MS,
} from "@/lib/infra-video-import-limits";
import {
	abortInfraUpload,
	completeInfraUpload,
	createInfraVideo,
	initiateInfraUpload,
	presignInfraUploadParts,
	type UploadPart,
} from "@/lib/infra-video-upload";
import {
	looksLikeHtml,
	looksLikePlaylist,
	MEDIA_CONTAINER_SNIFF_BYTES,
} from "@/lib/media-container";
import {
	assertPublicMediaUrl,
	fetchPublicMedia,
	PublicMediaFetchError,
	type PublicMediaGuards,
} from "@/lib/public-media-fetch";

export * from "@/lib/infra-video-import-limits";

const IMPORT_PART_PUT_TIMEOUT_MS = 2 * 60 * 1000;
const IMPORT_PART_PUT_ATTEMPTS = 3;

export type ImportErrorCode =
	| "url_not_allowed"
	| "url_unreachable"
	| "unsupported_format"
	| "too_large"
	| "timeout"
	| "insufficient_credits"
	| "storage_failed"
	| "cancelled";

const DOCS_HINT =
	"Send a public https URL that serves the video file itself, such as a link to an .mp4 on a CDN or storage bucket.";

const IMPORT_MESSAGES: Record<
	Exclude<ImportErrorCode, "insufficient_credits" | "cancelled">,
	{ status: 400 | 413 | 422 | 500; hint: string }
> = {
	url_not_allowed: { status: 400, hint: DOCS_HINT },
	url_unreachable: {
		status: 422,
		hint: "Check that the URL opens the file without signing in, then try again.",
	},
	unsupported_format: {
		status: 422,
		hint: `${DOCS_HINT} Web pages, playlists, images and documents are not imported.`,
	},
	too_large: {
		status: 413,
		hint: "Upload larger files with POST /api/developer/v1/uploads instead.",
	},
	timeout: {
		status: 422,
		hint: `The file must download within ${IMPORT_TOTAL_TIMEOUT_MS / 60_000} minutes. For slow hosts or very large files, use POST /api/developer/v1/uploads instead.`,
	},
	storage_failed: {
		status: 500,
		hint: "Retry with backoff. If the error persists, contact hello@cap.so.",
	},
};

export class ImportStop extends Error {
	constructor(
		readonly code: ImportErrorCode,
		message: string,
	) {
		super(message);
		this.name = "ImportStop";
	}
}

export function importErrorResponse(stop: ImportStop) {
	const known =
		stop.code in IMPORT_MESSAGES
			? IMPORT_MESSAGES[stop.code as keyof typeof IMPORT_MESSAGES]
			: IMPORT_MESSAGES.storage_failed;
	return {
		status: known.status,
		body: apiErrorBody(stop.code, stop.message, known.hint),
	};
}

const URL_NOT_ALLOWED_MESSAGES: Record<string, string> = {
	invalid_url: "The URL is not valid",
	unsupported_scheme: "The URL must start with https://",
	credentials_in_url: "The URL must not contain a username or password",
	unsupported_port: "The URL must use the default https port",
	private_address: "The URL must point to a public address",
};

const tooLarge = () =>
	new ImportStop(
		"too_large",
		`The file at the URL is larger than the ${IMPORT_MAX_BYTES / 1e9} GB limit`,
	);

// Turns anything a download throws into one of the import codes. The pinned
// lookup refuses a private answer at connect time with "private address",
// which is how a name that changes its answer after the check shows up.
export function importStopFor(
	error: unknown,
	stopped: "timeout" | "stall" | null,
): ImportStop {
	if (error instanceof ImportStop) return error;
	if (stopped === "timeout") {
		return new ImportStop(
			"timeout",
			`The file at the URL did not finish downloading within ${IMPORT_TOTAL_TIMEOUT_MS / 60_000} minutes`,
		);
	}
	if (stopped === "stall") {
		return new ImportStop(
			"timeout",
			`The URL stopped sending data for ${IMPORT_STALL_TIMEOUT_MS / 1000} seconds`,
		);
	}
	if (error instanceof PublicMediaFetchError) {
		if (error.problem === "too_large") return tooLarge();
		if (error.problem === "bad_status") {
			return new ImportStop("url_unreachable", error.message);
		}
		if (error.problem === "too_many_redirects") {
			return new ImportStop(
				"url_unreachable",
				`The URL redirected more than ${IMPORT_MAX_REDIRECTS} times`,
			);
		}
		return new ImportStop(
			"url_not_allowed",
			URL_NOT_ALLOWED_MESSAGES[error.problem] ?? error.message,
		);
	}
	const message = error instanceof Error ? error.message : String(error);
	if (/private address/i.test(message)) {
		return new ImportStop(
			"url_not_allowed",
			URL_NOT_ALLOWED_MESSAGES.private_address as string,
		);
	}
	return new ImportStop("url_unreachable", "The URL could not be reached");
}

export async function checkImportUrl(
	url: string,
	guards: Pick<PublicMediaGuards, "isBlocked"> = {},
): Promise<ImportStop | null> {
	try {
		await assertPublicMediaUrl(url, guards.isBlocked, { httpsOnly: true });
		return null;
	} catch (error) {
		return importStopFor(error, null);
	}
}

function contentTypeStop(contentType: string | null): ImportStop | null {
	if (!contentType) return null;
	if (
		isRefusedUploadContentType(contentType) ||
		isNonVideoUploadContentType(contentType)
	) {
		return new ImportStop(
			"unsupported_format",
			/^text\/html/i.test(contentType)
				? "The URL returned a web page, not a video file"
				: `The URL returned ${contentType.split(";")[0]}, not a video file`,
		);
	}
	return null;
}

export function headStop(head: Uint8Array): ImportStop | null {
	if (looksLikeHtml(head)) {
		return new ImportStop(
			"unsupported_format",
			"The URL returned a web page, not a video file",
		);
	}
	if (looksLikePlaylist(head)) {
		return new ImportStop(
			"unsupported_format",
			"The URL is a streaming playlist, not a video file",
		);
	}
	if (startsLikeAnImageOrDocument(head)) {
		return new ImportStop("unsupported_format", UNREADABLE_VIDEO_REASON);
	}
	return null;
}

function uploadContentType(contentType: string | null): string | undefined {
	const essence = contentType?.split(";")[0]?.trim().toLowerCase();
	return INFRA_UPLOAD_CONTENT_TYPES.find((allowed) => allowed === essence);
}

type DownloadGuards = PublicMediaGuards & {
	totalTimeoutMs?: number;
	stallTimeoutMs?: number;
	maxBytes?: number;
};

// Opens the URL through the public-only fetch with a total deadline and a
// stall timer that runs only while waiting on the source.
export async function openImportSource(url: string, guards: DownloadGuards) {
	const controller = new AbortController();
	let stopped: "timeout" | "stall" | null = null;
	const stop = (reason: "timeout" | "stall") => {
		stopped ??= reason;
		controller.abort();
	};
	const total = setTimeout(
		() => stop("timeout"),
		guards.totalTimeoutMs ?? IMPORT_TOTAL_TIMEOUT_MS,
	);
	const stallMs = guards.stallTimeoutMs ?? IMPORT_STALL_TIMEOUT_MS;
	let stall: ReturnType<typeof setTimeout> | undefined;
	// Settles as soon as either timer fires, even if the source never notices
	// the abort.
	const aborted = new Promise<never>((_, reject) => {
		controller.signal.addEventListener(
			"abort",
			() => reject(new Error("The import download was stopped")),
			{ once: true },
		);
	});
	aborted.catch(() => {});
	const waiting = async <T>(work: Promise<T>): Promise<T> => {
		stall = setTimeout(() => stop("stall"), stallMs);
		try {
			return await Promise.race([work, aborted]);
		} finally {
			clearTimeout(stall);
		}
	};
	const close = () => {
		clearTimeout(total);
		clearTimeout(stall);
		controller.abort();
	};
	try {
		const opened = await waiting(
			fetchPublicMedia(url, {
				maxBytes: guards.maxBytes ?? IMPORT_MAX_BYTES,
				maxRedirects: IMPORT_MAX_REDIRECTS,
				httpsOnly: true,
				signal: controller.signal,
				isBlocked: guards.isBlocked,
				request: guards.request,
			}),
		);
		const typeStop = contentTypeStop(
			opened.response.headers.get("content-type"),
		);
		if (typeStop) throw typeStop;
		const body = opened.response.body;
		if (!body) {
			throw new ImportStop("url_unreachable", "The URL returned no content");
		}
		const reader = body.getReader();
		return {
			contentLength: opened.contentLength,
			contentType: opened.response.headers.get("content-type"),
			signal: controller.signal,
			read: () => waiting(reader.read()),
			stopped: () => stopped,
			close: () => {
				reader.cancel().catch(() => {});
				close();
			},
		};
	} catch (error) {
		close();
		throw importStopFor(error, stopped);
	}
}

type ImportSource = Awaited<ReturnType<typeof openImportSource>>;

async function readHead(source: ImportSource) {
	const chunks: Uint8Array[] = [];
	let length = 0;
	let done = false;
	while (length < MEDIA_CONTAINER_SNIFF_BYTES) {
		const next = await source.read();
		if (next.done) {
			done = true;
			break;
		}
		chunks.push(next.value);
		length += next.value.length;
	}
	return { chunks, length, done };
}

function concat(chunks: Uint8Array[], length: number) {
	const out = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

export type ImportPreflight = {
	contentLength: number | null;
	contentType: string | null;
};

// Run before a video exists so the common mistakes (a web page, a private
// link, a dead link, a file over the limit) come back on the request itself.
export async function preflightImport(
	url: string,
	guards: DownloadGuards = {},
): Promise<ImportPreflight> {
	const source = await openImportSource(url, {
		totalTimeoutMs: IMPORT_PREFLIGHT_TIMEOUT_MS,
		...guards,
	});
	try {
		const head = await readHead(source);
		if (head.length === 0) {
			throw new ImportStop("url_unreachable", "The URL returned no content");
		}
		const sniffed = headStop(
			concat(head.chunks, head.length).subarray(0, MEDIA_CONTAINER_SNIFF_BYTES),
		);
		if (sniffed) throw sniffed;
		return {
			contentLength: source.contentLength,
			contentType: source.contentType,
		};
	} catch (error) {
		throw importStopFor(error, source.stopped());
	} finally {
		source.close();
	}
}

const MYSQL_NO_SUCH_TABLE = 1146;

// The table ships by deploy request. Code that reaches production first
// answers 503 rather than failing every import.
export function isMissingImportTable(error: unknown): boolean {
	for (let current = error, depth = 0; current && depth < 5; depth++) {
		if (typeof current !== "object") return false;
		const value = current as {
			errno?: unknown;
			code?: unknown;
			message?: unknown;
			cause?: unknown;
		};
		if (
			value.errno === MYSQL_NO_SUCH_TABLE ||
			value.code === "ER_NO_SUCH_TABLE" ||
			(typeof value.message === "string" &&
				/developer_video_imports/.test(value.message) &&
				/doesn't exist|does not exist|not found/i.test(value.message))
		) {
			return true;
		}
		current = value.cause;
	}
	return false;
}

export const importUnavailableBody = () =>
	apiErrorBody(
		"import_unavailable",
		"Importing from a URL is not available yet",
		"Upload the file with POST /api/developer/v1/uploads, or try the import again later.",
	);

type Reservation =
	| { state: "reserved" }
	| { state: "busy"; retryAfterSeconds: number }
	| { state: "rate_limited"; retryAfterSeconds: number }
	| { state: "starting" };

export async function reserveImportSlot(input: {
	appId: string;
	keyId: string;
	videoId: string;
	sourceUrl: string;
	now?: Date;
}): Promise<Reservation> {
	const now = input.now ?? new Date();
	return db().transaction(async (tx) => {
		await tx
			.select({ id: developerApps.id })
			.from(developerApps)
			.where(eq(developerApps.id, input.appId))
			.limit(1)
			.for("update");

		const [existing] = await tx
			.select({ state: developerVideoImports.state })
			.from(developerVideoImports)
			.where(eq(developerVideoImports.videoId, input.videoId))
			.limit(1);
		if (existing && existing.state !== "failed") return { state: "starting" };

		const [running] = await tx
			.select({ total: count(), oldest: min(developerVideoImports.startedAt) })
			.from(developerVideoImports)
			.where(
				and(
					eq(developerVideoImports.appId, input.appId),
					eq(developerVideoImports.state, "downloading"),
					gt(
						developerVideoImports.startedAt,
						new Date(now.getTime() - IMPORT_STALE_SLOT_MS),
					),
				),
			);
		if ((running?.total ?? 0) >= IMPORT_MAX_IN_FLIGHT_PER_APP) {
			return { state: "busy", retryAfterSeconds: 15 };
		}

		const [recent] = await tx
			.select({ total: count(), oldest: min(developerVideoImports.createdAt) })
			.from(developerVideoImports)
			.where(
				and(
					eq(developerVideoImports.keyId, input.keyId),
					gt(
						developerVideoImports.createdAt,
						new Date(now.getTime() - IMPORT_RATE_WINDOW_MS),
					),
				),
			);
		if ((recent?.total ?? 0) >= IMPORT_MAX_PER_KEY_PER_HOUR) {
			const oldest = recent?.oldest?.getTime() ?? now.getTime();
			return {
				state: "rate_limited",
				retryAfterSeconds: Math.max(
					1,
					Math.ceil((oldest + IMPORT_RATE_WINDOW_MS - now.getTime()) / 1000),
				),
			};
		}

		const row = {
			appId: input.appId,
			keyId: input.keyId,
			sourceUrl: input.sourceUrl,
			state: "downloading" as const,
			bytes: null,
			errorCode: null,
			startedAt: now,
			finishedAt: null,
			createdAt: now,
		};
		if (existing) {
			await tx
				.update(developerVideoImports)
				.set(row)
				.where(eq(developerVideoImports.videoId, input.videoId));
		} else {
			await tx
				.insert(developerVideoImports)
				.values({ videoId: input.videoId, ...row });
		}
		return { state: "reserved" };
	});
}

async function finishImport(
	videoId: string,
	outcome:
		| { state: "complete"; bytes: number }
		| { state: "failed"; code: ImportErrorCode },
) {
	await db()
		.update(developerVideoImports)
		.set(
			outcome.state === "complete"
				? { state: "complete", bytes: outcome.bytes, finishedAt: new Date() }
				: { state: "failed", errorCode: outcome.code, finishedAt: new Date() },
		)
		.where(
			and(
				eq(developerVideoImports.videoId, videoId),
				eq(developerVideoImports.state, "downloading"),
			),
		);
}

export const releaseImportSlot = (videoId: string, code: ImportErrorCode) =>
	finishImport(videoId, { state: "failed", code });

// Only a video still waiting for its file is failed: one the customer deleted
// or one an earlier attempt already handed to processing stays as it is.
async function failImportedVideo(
	appId: string,
	videoId: string,
	stop: ImportStop,
) {
	await finishImport(videoId, { state: "failed", code: stop.code });
	if (stop.code === "cancelled") return;
	const [result] = await db()
		.update(developerVideos)
		.set({
			status: "errored",
			errorReason: `Import failed: ${stop.message}`.slice(0, 512),
		})
		.where(
			and(
				eq(developerVideos.id, videoId),
				eq(developerVideos.appId, appId),
				eq(developerVideos.status, "uploading"),
				isNull(developerVideos.duration),
				isNull(developerVideos.deletedAt),
			),
		);
	if (result.affectedRows > 0) {
		announceDeveloperVideoEvent(
			{ id: videoId, appId },
			{ type: "video.errored" },
		);
	}
}

type StartImport = (videoId: string) => Promise<void>;

export type CreateImportInput = {
	appId: string;
	keyId: string;
	url: string;
	name?: string;
	userId?: string;
	metadata?: Record<string, unknown>;
	maxResolutionTier?: DeveloperVideoResolutionTier;
	idempotencyKey?: string;
	videoId: string;
};

export type CreateImportResult =
	| { status: 202; videoId: string; replayed: boolean }
	| {
			status: 400 | 402 | 404 | 409 | 413 | 422 | 429 | 500 | 503;
			body: Record<string, unknown>;
			headers?: Record<string, string>;
	  };

async function existingVideo(appId: string, videoId: string) {
	const [video] = await db()
		.select({ id: developerVideos.id })
		.from(developerVideos)
		.where(
			and(eq(developerVideos.id, videoId), eq(developerVideos.appId, appId)),
		)
		.limit(1);
	return video ?? null;
}

async function importSourceOf(videoId: string) {
	const [row] = await db()
		.select({
			sourceUrl: developerVideoImports.sourceUrl,
			state: developerVideoImports.state,
			errorCode: developerVideoImports.errorCode,
		})
		.from(developerVideoImports)
		.where(eq(developerVideoImports.videoId, videoId))
		.limit(1);
	return row ?? null;
}

// Read on every GET of one video, so a server that has the code before the
// table answers without the field rather than failing the read.
export async function developerVideoImportView(videoId: string) {
	try {
		const row = await importSourceOf(videoId);
		return (
			row && {
				sourceUrl: row.sourceUrl,
				state: row.state,
				errorCode: row.errorCode,
			}
		);
	} catch (error) {
		if (isMissingImportTable(error)) return null;
		throw error;
	}
}

const idempotencyConflict = () => ({
	status: 409 as const,
	body: apiErrorBody(
		"idempotency_conflict",
		"This Idempotency-Key was already used for a different request",
		"Use a new Idempotency-Key for a different video or URL.",
	),
});

export async function createInfraVideoImport(
	input: CreateImportInput,
	deps: { startImport: StartImport; guards?: DownloadGuards },
): Promise<CreateImportResult> {
	const refused = await checkImportUrl(input.url, deps.guards);
	if (refused) return importErrorResponse(refused);

	try {
		if (
			input.idempotencyKey &&
			(await existingVideo(input.appId, input.videoId))
		) {
			const source = await importSourceOf(input.videoId);
			if (!source || source.sourceUrl !== input.url) {
				return idempotencyConflict();
			}
			const replay = await createInfraVideo({
				appId: input.appId,
				name: input.name,
				userId: input.userId,
				metadata: input.metadata,
				maxResolutionTier: input.maxResolutionTier,
				idempotencyKey: input.idempotencyKey,
			});
			// The import recorded the file, which a keyed upload reports as
			// finished. A repeated import returns the video as it is now.
			const finished =
				replay.status === 409 &&
				replay.body.code === "upload_already_completed";
			if (replay.status !== 200 && !finished) return replay;
			return { status: 202, videoId: input.videoId, replayed: true };
		}

		const reservation = await reserveImportSlot({
			appId: input.appId,
			keyId: input.keyId,
			videoId: input.videoId,
			sourceUrl: input.url,
		});
		if (reservation.state === "starting") {
			return {
				status: 409,
				body: apiErrorBody(
					"import_starting",
					"An import with this Idempotency-Key is starting",
					"Send the same request again in a few seconds.",
				),
				headers: { "Retry-After": "5" },
			};
		}
		if (reservation.state === "busy") {
			return {
				status: 429,
				body: apiErrorBody(
					"too_many_imports",
					`This app already has ${IMPORT_MAX_IN_FLIGHT_PER_APP} imports downloading`,
					"Wait for one to finish (its video leaves the uploading status), then send the request again.",
				),
				headers: { "Retry-After": String(reservation.retryAfterSeconds) },
			};
		}
		if (reservation.state === "rate_limited") {
			return {
				status: 429,
				body: apiErrorBody(
					"import_rate_limited",
					`This key has started ${IMPORT_MAX_PER_KEY_PER_HOUR} imports in the last hour`,
					"Wait for the Retry-After seconds, or upload files with POST /api/developer/v1/uploads.",
				),
				headers: { "Retry-After": String(reservation.retryAfterSeconds) },
			};
		}
	} catch (error) {
		if (isMissingImportTable(error)) {
			return { status: 503, body: importUnavailableBody() };
		}
		throw error;
	}

	let preflight: ImportPreflight;
	try {
		preflight = await preflightImport(input.url, deps.guards);
	} catch (error) {
		const stop = importStopFor(error, null);
		await releaseImportSlot(input.videoId, stop.code);
		return importErrorResponse(stop);
	}

	if (preflight.contentLength !== null) {
		const admission = await admitDeveloperVideoUpload({
			appId: input.appId,
			videoId: input.videoId,
			durationSeconds: preflight.contentLength / STORED_BYTES_PER_SECOND,
			width: null,
			height: null,
			maxResolutionTier: input.maxResolutionTier ?? null,
		});
		if (!admission.allowed) {
			await releaseImportSlot(input.videoId, "insufficient_credits");
			await scheduleAutoTopUp({ appId: input.appId });
			return { status: 402, body: uploadAdmissionError(admission) };
		}
	}

	const created = await createInfraVideo({
		appId: input.appId,
		name: input.name,
		userId: input.userId,
		metadata: input.metadata,
		maxResolutionTier: input.maxResolutionTier,
		idempotencyKey: input.idempotencyKey,
		videoId: input.videoId,
	});
	if (created.status !== 200) {
		await releaseImportSlot(
			input.videoId,
			created.status === 402 ? "insufficient_credits" : "storage_failed",
		);
		return created;
	}

	try {
		await deps.startImport(input.videoId);
	} catch (error) {
		console.error("[developer-import] Failed to start the import", {
			videoId: input.videoId,
			message: error instanceof Error ? error.message : String(error),
		});
		const stop = new ImportStop(
			"storage_failed",
			"The import could not be started",
		);
		await failImportedVideo(input.appId, input.videoId, stop);
		return importErrorResponse(stop);
	}
	return { status: 202, videoId: input.videoId, replayed: false };
}

export const newImportVideoId = () => nanoId();

type PartWriter = {
	put: (partNumber: number, bytes: Uint8Array<ArrayBuffer>) => Promise<string>;
};

async function putPartOnce(
	url: string,
	bytes: Uint8Array<ArrayBuffer>,
	signal: AbortSignal,
): Promise<string> {
	const response = await fetch(url, {
		method: "PUT",
		body: bytes,
		signal: AbortSignal.any([
			signal,
			AbortSignal.timeout(IMPORT_PART_PUT_TIMEOUT_MS),
		]),
	});
	await response.body?.cancel().catch(() => {});
	const etag = response.headers.get("etag");
	if (!response.ok || !etag) {
		throw new Error(`Storage answered ${response.status} to a part upload`);
	}
	return etag.replaceAll('"', "");
}

function storagePartWriter(
	appId: string,
	videoId: string,
	uploadId: string,
	signal: AbortSignal,
): PartWriter {
	return {
		async put(partNumber, bytes) {
			const signed = await presignInfraUploadParts({
				appId,
				videoId,
				uploadId,
				partNumbers: [partNumber],
			});
			if (signed.status !== 200) {
				throw new ImportStop(
					signed.status === 404 ? "cancelled" : "storage_failed",
					signed.status === 404
						? "The video was deleted during the import"
						: "The file could not be stored",
				);
			}
			const url = signed.body.parts[0]?.presignedUrl;
			if (!url) {
				throw new ImportStop("storage_failed", "The file could not be stored");
			}
			for (let attempt = 1; ; attempt++) {
				try {
					return await putPartOnce(url, bytes, signal);
				} catch (error) {
					if (signal.aborted || attempt >= IMPORT_PART_PUT_ATTEMPTS) {
						if (signal.aborted) throw error;
						throw new ImportStop(
							"storage_failed",
							"The file could not be stored",
						);
					}
				}
			}
		},
	};
}

// Streams the source into fixed size parts. One part uploads while the next
// fills, so at most two parts are held in memory.
export async function streamSourceToParts(
	source: Pick<ImportSource, "read">,
	first: { chunks: Uint8Array[]; length: number; done: boolean },
	writer: PartWriter,
	options: { maxBytes: number; partBytes: number },
): Promise<{ parts: UploadPart[]; totalBytes: number }> {
	const parts: UploadPart[] = [];
	let pending: Promise<void> | null = null;
	let buffer = new Uint8Array(options.partBytes);
	let filled = 0;
	let totalBytes = 0;
	let partNumber = 1;

	const flush = async () => {
		if (filled === 0) return;
		const bytes = filled === buffer.length ? buffer : buffer.slice(0, filled);
		const number = partNumber++;
		const size = filled;
		if (pending) await pending;
		pending = writer.put(number, bytes).then((etag) => {
			parts.push({ partNumber: number, etag, size });
		});
		buffer = new Uint8Array(options.partBytes);
		filled = 0;
	};

	const take = async (chunk: Uint8Array) => {
		totalBytes += chunk.length;
		if (totalBytes > options.maxBytes) throw tooLarge();
		let offset = 0;
		while (offset < chunk.length) {
			const room = buffer.length - filled;
			const piece = chunk.subarray(offset, offset + room);
			buffer.set(piece, filled);
			filled += piece.length;
			offset += piece.length;
			if (filled === buffer.length) await flush();
		}
	};

	try {
		for (const chunk of first.chunks) await take(chunk);
		if (!first.done) {
			for (;;) {
				const next = await source.read();
				if (next.done) break;
				await take(next.value);
			}
		}
		await flush();
		if (pending) await pending;
	} catch (error) {
		if (pending) await (pending as Promise<void>).catch(() => {});
		throw error;
	}
	parts.sort((a, b) => a.partNumber - b.partNumber);
	return { parts, totalBytes };
}

export type ImportRunDeps = {
	guards?: DownloadGuards;
	writer?: (input: {
		appId: string;
		videoId: string;
		uploadId: string;
		signal: AbortSignal;
	}) => PartWriter;
	partBytes?: number;
	now?: () => number;
};

// The body of the download step. It never throws for anything the URL or the
// file did: every outcome is written to the import row and the video.
export async function runInfraVideoImport(
	videoId: string,
	deps: ImportRunDeps = {},
): Promise<"complete" | "failed" | "skipped"> {
	const now = deps.now ?? Date.now;
	const [job] = await db()
		.select({
			appId: developerVideoImports.appId,
			sourceUrl: developerVideoImports.sourceUrl,
			state: developerVideoImports.state,
			startedAt: developerVideoImports.startedAt,
		})
		.from(developerVideoImports)
		.where(eq(developerVideoImports.videoId, videoId))
		.limit(1);
	if (!job || job.state !== "downloading") return "skipped";
	const { appId } = job;

	// A step run again after its function was stopped must not start a second
	// full download once the first one's time is up.
	if (now() - job.startedAt.getTime() > IMPORT_TOTAL_TIMEOUT_MS + 60_000) {
		await failImportedVideo(appId, videoId, importStopFor(null, "timeout"));
		return "failed";
	}

	const [video] = await db()
		.select({
			deletedAt: developerVideos.deletedAt,
			duration: developerVideos.duration,
			status: developerVideos.status,
		})
		.from(developerVideos)
		.where(
			and(eq(developerVideos.id, videoId), eq(developerVideos.appId, appId)),
		)
		.limit(1);
	if (!video || video.deletedAt) {
		await releaseImportSlot(videoId, "cancelled");
		return "failed";
	}
	if (video.duration !== null || video.status !== "uploading") {
		await finishImport(videoId, { state: "complete", bytes: 0 });
		return "skipped";
	}

	let source: ImportSource | null = null;
	let uploadId: string | null = null;
	try {
		source = await openImportSource(job.sourceUrl, deps.guards ?? {});
		const head = await readHead(source);
		if (head.length === 0) {
			throw new ImportStop("url_unreachable", "The URL returned no content");
		}
		const sniffed = headStop(
			concat(head.chunks, head.length).subarray(0, MEDIA_CONTAINER_SNIFF_BYTES),
		);
		if (sniffed) throw sniffed;

		const initiated = await initiateInfraUpload({
			appId,
			videoId,
			contentType: uploadContentType(source.contentType),
			contentLength: source.contentLength ?? undefined,
		});
		if (initiated.status !== 200) {
			throw new ImportStop(
				initiated.status === 404 ? "cancelled" : "storage_failed",
				initiated.status === 404
					? "The video was deleted during the import"
					: "The file could not be stored",
			);
		}
		uploadId = initiated.body.uploadId;
		const writer = deps.writer
			? deps.writer({ appId, videoId, uploadId, signal: source.signal })
			: storagePartWriter(appId, videoId, uploadId, source.signal);
		const { parts, totalBytes } = await streamSourceToParts(
			source,
			head,
			writer,
			{
				maxBytes: deps.guards?.maxBytes ?? IMPORT_MAX_BYTES,
				partBytes: deps.partBytes ?? IMPORT_PART_BYTES,
			},
		);
		if (source.contentLength !== null && totalBytes < source.contentLength) {
			throw new ImportStop(
				"url_unreachable",
				"The URL closed the connection before the whole file was sent",
			);
		}
		source.close();

		const completed = await completeInfraUpload({
			appId,
			videoId,
			uploadId,
			parts,
			durationInSecs: 0,
		});
		if (completed.status === 200) {
			await finishImport(videoId, { state: "complete", bytes: totalBytes });
			return "complete";
		}
		uploadId = null;
		if (completed.status === 402) {
			await failImportedVideo(
				appId,
				videoId,
				new ImportStop(
					"insufficient_credits",
					String(completed.body.message ?? completed.body.error),
				),
			);
			return "failed";
		}
		const removed =
			completed.status === 404 || completed.body.code === "upload_removed";
		if (removed) {
			throw new ImportStop(
				"cancelled",
				"The video was deleted during the import",
			);
		}
		if (completed.body.code === "file_too_large") throw tooLarge();
		throw new ImportStop("storage_failed", "The file could not be stored");
	} catch (error) {
		const stop = importStopFor(error, source?.stopped() ?? null);
		source?.close();
		if (uploadId) {
			await abortInfraUpload({ appId, videoId, uploadId }).catch(() => {});
		}
		if (
			!(error instanceof ImportStop) &&
			!(error instanceof PublicMediaFetchError)
		) {
			console.error("[developer-import] Download failed", {
				videoId,
				code: stop.code,
				message: error instanceof Error ? error.message : String(error),
			});
		}
		await failImportedVideo(appId, videoId, stop);
		return "failed";
	}
}
