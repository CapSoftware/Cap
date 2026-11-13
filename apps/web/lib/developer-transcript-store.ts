import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	type DeveloperTranscriptStatus,
	developerApps,
	developerTranscripts,
	users,
} from "@cap/database/schema";
import { AI_GENERATION_LANGUAGE_CODES } from "@cap/web-domain";
import { and, count, desc, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { start } from "workflow/api";
import { developerIdFromKey } from "@/lib/developer-ids";
import { transcriptStartRefusal } from "@/lib/developer-transcript-billing";
import {
	isSpeechConfigured,
	parseTranscriptLanguage,
} from "@/lib/developer-transcript-speech";
import {
	deleteDeveloperObjects,
	developerObjectSize,
	getDeveloperObjectText,
	presignDeveloperUpload,
} from "@/lib/developer-transcript-storage";
import {
	publicTranscriptWords,
	TRANSCRIPT_MAX_METADATA_BYTES,
	TRANSCRIPT_MAX_UPLOAD_BYTES,
	TRANSCRIPT_MAX_URL_LENGTH,
	type TranscriptResultObject,
	transcriptNameFromFile,
	transcriptNameFromUrl,
	transcriptObjectKeys,
	transcriptUploadExpiry,
} from "@/lib/developer-transcripts";
import { canUseInfra } from "@/lib/infra-access";
import {
	assertPublicMediaUrl,
	PublicMediaFetchError,
} from "@/lib/public-media-fetch";
import { developerTranscribeWorkflow } from "@/workflows/developer-transcribe";

export type TranscriptFailure = {
	ok: false;
	status: 400 | 402 | 403 | 404 | 409 | 503;
	code: string;
	message: string;
	hint: string;
};

type TranscriptRow = typeof developerTranscripts.$inferSelect;

const fail = (
	status: TranscriptFailure["status"],
	code: string,
	message: string,
	hint: string,
): TranscriptFailure => ({ ok: false, status, code, message, hint });

const ADD_CREDITS_HINT =
	"Add credits to this app at https://cap.so/dashboard/infra, then retry.";

const NOT_FOUND = fail(
	404,
	"transcript_not_found",
	"Transcript not found",
	"Check the transcript ID and that it belongs to this app.",
);

const IDEMPOTENCY_CONFLICT = fail(
	409,
	"idempotency_conflict",
	"Idempotency key was already used for a different request",
	"Use a new Idempotency-Key for a new transcript.",
);

const idempotencyMismatch = (field: string) =>
	fail(
		409,
		"idempotency_conflict",
		`Idempotency key was already used with a different ${field}`,
		"Send the same request to repeat it, or use a new Idempotency-Key for a new transcript.",
	);

const canonicalJson = (value: unknown): string => {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
};

function replayedWithDifferent(
	existing: Pick<
		typeof developerTranscripts.$inferSelect,
		"name" | "requestedLanguage" | "externalUserId" | "metadata"
	>,
	request: {
		name: string;
		requestedLanguage: string | null;
		externalUserId: string | null;
		metadata: Record<string, unknown> | null;
	},
) {
	if (existing.name !== request.name) return "name";
	if ((existing.requestedLanguage ?? null) !== request.requestedLanguage) {
		return "language";
	}
	if ((existing.externalUserId ?? null) !== request.externalUserId) {
		return "userId";
	}
	if (
		canonicalJson(existing.metadata ?? null) !== canonicalJson(request.metadata)
	) {
		return "metadata";
	}
	return null;
}

const IDEMPOTENCY_KEY_RETIRED = fail(
	409,
	"idempotency_conflict",
	"Idempotency key belongs to a transcript that was deleted",
	"Use a new Idempotency-Key for a new transcript.",
);

const NOT_AVAILABLE = fail(
	403,
	"infra_not_available",
	"Cap Infra is not available for this account yet",
	"Cap Infra is in preview. Contact hello@cap.so for access.",
);

const SPEECH_UNAVAILABLE = fail(
	503,
	"speech_unavailable",
	"Transcription is not available right now",
	"Retry later. If the error persists, contact hello@cap.so.",
);

const affectedRows = (result: unknown) => {
	if (Array.isArray(result)) {
		return (
			(result[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0
		);
	}
	return (result as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
};

export function transcriptIdForIdempotencyKey(appId: string, key: string) {
	return developerIdFromKey("developer-transcript", appId, key);
}

export function isTranscriptIdempotencyKey(value: string | undefined | null) {
	return (
		typeof value === "string" &&
		value.length >= 8 &&
		value.length <= 128 &&
		/^[A-Za-z0-9._-]+$/.test(value)
	);
}

export type TranscriptOptionsInput = {
	name?: string | null;
	language?: string | null;
	userId?: string | null;
	metadata?: unknown;
};

export function validateTranscriptOptions(input: TranscriptOptionsInput):
	| {
			ok: true;
			name: string | null;
			requestedLanguage: string | null;
			externalUserId: string | null;
			metadata: Record<string, unknown> | null;
	  }
	| TranscriptFailure {
	const name = input.name?.trim() || null;
	if (name && name.length > 255) {
		return fail(
			400,
			"invalid_name",
			"Name is too long",
			"Use a name of 255 characters or fewer.",
		);
	}
	const language = parseTranscriptLanguage(input.language);
	if (language === null) {
		return fail(
			400,
			"invalid_language",
			"Language is not supported",
			`Use "auto" or one of ${AI_GENERATION_LANGUAGE_CODES.join(", ")}.`,
		);
	}
	const externalUserId = input.userId?.trim() || null;
	if (externalUserId && externalUserId.length > 255) {
		return fail(
			400,
			"invalid_user_id",
			"User ID is too long",
			"Use a user ID of 255 characters or fewer.",
		);
	}
	let metadata: Record<string, unknown> | null = null;
	if (input.metadata !== undefined && input.metadata !== null) {
		if (
			typeof input.metadata !== "object" ||
			Array.isArray(input.metadata) ||
			JSON.stringify(input.metadata).length > TRANSCRIPT_MAX_METADATA_BYTES
		) {
			return fail(
				400,
				"invalid_metadata",
				"Metadata must be an object under 8KB",
				"Send a JSON object smaller than 8KB.",
			);
		}
		metadata = input.metadata as Record<string, unknown>;
	}
	return {
		ok: true,
		name,
		requestedLanguage: language === "auto" ? null : language,
		externalUserId,
		metadata,
	};
}

async function findTranscriptAnyState(appId: string, transcriptId: string) {
	const [row] = await db()
		.select()
		.from(developerTranscripts)
		.where(
			and(
				eq(developerTranscripts.id, transcriptId),
				eq(developerTranscripts.appId, appId),
			),
		)
		.limit(1);
	return row ?? null;
}

async function findTranscript(appId: string, transcriptId: string) {
	const [row] = await db()
		.select()
		.from(developerTranscripts)
		.where(
			and(
				eq(developerTranscripts.id, transcriptId),
				eq(developerTranscripts.appId, appId),
				isNull(developerTranscripts.deletedAt),
			),
		)
		.limit(1);
	return row ?? null;
}

const DISPATCH_RETRY_AFTER_MS = 2 * 60 * 1000;

async function dispatchTranscript(
	transcriptId: string,
	from: "uploading" | "queued",
	sourceBytes?: number,
) {
	const now = new Date();
	const runId = nanoId();
	const claim = await db()
		.update(developerTranscripts)
		.set({
			status: "queued",
			runId,
			startedAt: now,
			...(sourceBytes !== undefined ? { sourceBytes } : {}),
		})
		.where(
			and(
				eq(developerTranscripts.id, transcriptId),
				eq(developerTranscripts.status, from),
				or(
					isNull(developerTranscripts.startedAt),
					lt(
						developerTranscripts.startedAt,
						new Date(now.getTime() - DISPATCH_RETRY_AFTER_MS),
					),
				),
				isNull(developerTranscripts.deletedAt),
			),
		);
	if (affectedRows(claim) === 0) return "already_dispatched" as const;

	const firstQueue = await db()
		.update(developerTranscripts)
		.set({ queuedAt: now })
		.where(
			and(
				eq(developerTranscripts.id, transcriptId),
				isNull(developerTranscripts.queuedAt),
			),
		);

	try {
		await start(developerTranscribeWorkflow, [{ transcriptId, runId }]);
		return "dispatched" as const;
	} catch (error) {
		console.error(
			`[developer-transcripts] Failed to start workflow for ${transcriptId}`,
			error,
		);
		await db()
			.update(developerTranscripts)
			.set({
				status: from,
				startedAt: null,
				...(affectedRows(firstQueue) > 0 ? { queuedAt: null } : {}),
			})
			.where(
				and(
					eq(developerTranscripts.id, transcriptId),
					eq(developerTranscripts.runId, runId),
					eq(developerTranscripts.status, "queued"),
				),
			);
		return "failed" as const;
	}
}

async function appOwnerCanUseInfra(appId: string) {
	if (canUseInfra(null)) return true;
	const [app] = await db()
		.select({ ownerId: developerApps.ownerId })
		.from(developerApps)
		.where(and(eq(developerApps.id, appId), isNull(developerApps.deletedAt)))
		.limit(1);
	if (!app) return false;
	const [owner] = await db()
		.select({ email: users.email })
		.from(users)
		.where(eq(users.id, app.ownerId))
		.limit(1);
	return canUseInfra(owner?.email);
}

async function startGate(appId: string): Promise<TranscriptFailure | null> {
	if (!(await appOwnerCanUseInfra(appId))) return NOT_AVAILABLE;
	if (!isSpeechConfigured()) return SPEECH_UNAVAILABLE;
	const refusal = await transcriptStartRefusal(appId);
	return refusal
		? fail(402, refusal.code, refusal.message, ADD_CREDITS_HINT)
		: null;
}

export async function createTranscriptFromUrl(
	appId: string,
	input: TranscriptOptionsInput & { url: string; idempotencyKey?: string },
	guards: { isBlocked?: (url: string) => Promise<boolean> } = {},
): Promise<{ ok: true; transcript: TranscriptRow } | TranscriptFailure> {
	const options = validateTranscriptOptions(input);
	if (!options.ok) return options;

	const url = typeof input.url === "string" ? input.url.trim() : "";
	if (url.length === 0 || url.length > TRANSCRIPT_MAX_URL_LENGTH) {
		return fail(
			400,
			"invalid_url",
			"The URL is not valid",
			"Send a public http or https URL of 2,048 characters or fewer.",
		);
	}

	const id = input.idempotencyKey
		? transcriptIdForIdempotencyKey(appId, input.idempotencyKey)
		: nanoId();

	const differsFromRequest = (existing: TranscriptRow) => {
		if (existing.sourceType !== "url") return IDEMPOTENCY_CONFLICT;
		if (existing.sourceUrl !== url) return idempotencyMismatch("url");
		const different = replayedWithDifferent(existing, {
			...options,
			name: options.name ?? transcriptNameFromUrl(url),
		});
		if (different) return idempotencyMismatch(different);
		return existing.deletedAt ? IDEMPOTENCY_KEY_RETIRED : null;
	};

	if (input.idempotencyKey) {
		const existing = await findTranscriptAnyState(appId, id);
		if (existing) {
			const conflict = differsFromRequest(existing);
			if (conflict) return conflict;
			if (existing.status === "queued") {
				await dispatchTranscript(id, "queued");
			}
			return {
				ok: true,
				transcript: (await findTranscript(appId, id)) ?? existing,
			};
		}
	}

	try {
		await assertPublicMediaUrl(url, guards.isBlocked);
	} catch (error) {
		if (error instanceof PublicMediaFetchError) {
			return fail(
				400,
				error.problem === "private_address" ? "url_not_public" : "invalid_url",
				error.message,
				"Send a public http or https URL on the default port, without credentials.",
			);
		}
		throw error;
	}

	const gate = await startGate(appId);
	if (gate) return gate;

	await db()
		.insert(developerTranscripts)
		.values({
			id,
			appId,
			externalUserId: options.externalUserId,
			name: options.name ?? transcriptNameFromUrl(url),
			status: "queued",
			queuedAt: new Date(),
			sourceType: "url",
			sourceUrl: url,
			s3Key: transcriptObjectKeys(appId, id).source,
			requestedLanguage: options.requestedLanguage,
			metadata: options.metadata,
		})
		.onDuplicateKeyUpdate({ set: { id } });

	const stored = await findTranscriptAnyState(appId, id);
	if (!stored) return NOT_FOUND;
	const conflict = differsFromRequest(stored);
	if (conflict) return conflict;

	const dispatched = await dispatchTranscript(id, "queued");
	if (dispatched === "failed") {
		await db()
			.delete(developerTranscripts)
			.where(
				and(
					eq(developerTranscripts.id, id),
					eq(developerTranscripts.appId, appId),
					eq(developerTranscripts.status, "queued"),
					isNull(developerTranscripts.startedAt),
				),
			);
		return SPEECH_UNAVAILABLE;
	}

	const transcript = await findTranscript(appId, id);
	if (!transcript) return NOT_FOUND;
	return { ok: true, transcript };
}

export type TranscriptUploadTarget = {
	method: "PUT";
	url: string;
	headers: Record<string, string>;
	expiresAt: string;
};

async function issueUploadTarget(
	transcriptId: string,
	key: string,
	contentLength: number,
): Promise<{ target: TranscriptUploadTarget; issuedAt: Date }> {
	const url = await presignDeveloperUpload(key, contentLength);
	const issuedAt = new Date(Math.floor(Date.now() / 1000) * 1000);
	await db()
		.update(developerTranscripts)
		.set({ updatedAt: issuedAt })
		.where(
			and(
				eq(developerTranscripts.id, transcriptId),
				eq(developerTranscripts.status, "uploading"),
			),
		);
	return {
		issuedAt,
		target: {
			method: "PUT",
			url,
			headers: { "Content-Length": String(contentLength) },
			expiresAt: transcriptUploadExpiry({ updatedAt: issuedAt }).toISOString(),
		},
	};
}

export async function createTranscriptUpload(
	appId: string,
	input: TranscriptOptionsInput & {
		fileName?: string | null;
		contentLength: number;
		idempotencyKey?: string;
	},
): Promise<
	| {
			ok: true;
			transcript: TranscriptRow;
			upload: TranscriptUploadTarget | null;
	  }
	| TranscriptFailure
> {
	const options = validateTranscriptOptions(input);
	if (!options.ok) return options;

	if (
		!Number.isSafeInteger(input.contentLength) ||
		input.contentLength < 1 ||
		input.contentLength > TRANSCRIPT_MAX_UPLOAD_BYTES
	) {
		return fail(
			400,
			"invalid_content_length",
			"contentLength must be between 1 byte and 2 GB",
			"Send the exact size of the file in bytes. Files over 2 GB are not accepted.",
		);
	}
	if (input.fileName && input.fileName.length > 255) {
		return fail(
			400,
			"invalid_file_name",
			"File name is too long",
			"Use a file name of 255 characters or fewer.",
		);
	}

	const id = input.idempotencyKey
		? transcriptIdForIdempotencyKey(appId, input.idempotencyKey)
		: nanoId();
	const keys = transcriptObjectKeys(appId, id);

	const replay = async (existing: TranscriptRow) => {
		if (existing.sourceType !== "upload") return IDEMPOTENCY_CONFLICT;
		if (existing.sourceBytes !== input.contentLength) {
			return idempotencyMismatch("contentLength");
		}
		const different = replayedWithDifferent(existing, {
			...options,
			name: options.name ?? transcriptNameFromFile(input.fileName),
		});
		if (different) return idempotencyMismatch(different);
		if (existing.deletedAt) return IDEMPOTENCY_KEY_RETIRED;
		if (existing.status !== "uploading") {
			return { ok: true as const, transcript: existing, upload: null };
		}
		const issued = await issueUploadTarget(
			existing.id,
			keys.source,
			input.contentLength,
		);
		return {
			ok: true as const,
			transcript: { ...existing, updatedAt: issued.issuedAt },
			upload: issued.target,
		};
	};

	if (input.idempotencyKey) {
		const existing = await findTranscriptAnyState(appId, id);
		if (existing) return replay(existing);
	}

	const gate = await startGate(appId);
	if (gate) return gate;

	await db()
		.insert(developerTranscripts)
		.values({
			id,
			appId,
			externalUserId: options.externalUserId,
			name: options.name ?? transcriptNameFromFile(input.fileName),
			status: "uploading",
			sourceType: "upload",
			s3Key: keys.source,
			sourceBytes: input.contentLength,
			requestedLanguage: options.requestedLanguage,
			metadata: options.metadata,
		})
		.onDuplicateKeyUpdate({ set: { id } });

	const transcript = await findTranscriptAnyState(appId, id);
	if (!transcript) return NOT_FOUND;
	return replay(transcript);
}

export async function startTranscriptUpload(
	appId: string,
	transcriptId: string,
): Promise<{ ok: true; transcript: TranscriptRow } | TranscriptFailure> {
	const transcript = await findTranscript(appId, transcriptId);
	if (!transcript) return NOT_FOUND;
	if (transcript.status === "queued") {
		await dispatchTranscript(transcript.id, "queued");
		return {
			ok: true,
			transcript: (await findTranscript(appId, transcript.id)) ?? transcript,
		};
	}
	if (transcript.status !== "uploading") return { ok: true, transcript };

	const keys = transcriptObjectKeys(appId, transcript.id);
	const size = await developerObjectSize(keys.source);
	if (size === null || size === 0) {
		return fail(
			409,
			"upload_not_found",
			"The file has not been uploaded yet",
			"PUT the file to the upload URL, then start the transcript again. If the URL has expired, repeat the create request with the same Idempotency-Key to get a new one.",
		);
	}
	if (size > TRANSCRIPT_MAX_UPLOAD_BYTES) {
		await deleteDeveloperObjects([keys.source]);
		return fail(
			400,
			"file_too_large",
			"The file is larger than 2 GB",
			"Upload a file of 2 GB or less.",
		);
	}

	const gate = await startGate(appId);
	if (gate) return gate;

	const dispatched = await dispatchTranscript(transcript.id, "uploading", size);
	if (dispatched === "failed") return SPEECH_UNAVAILABLE;

	return {
		ok: true,
		transcript: (await findTranscript(appId, transcript.id)) ?? transcript,
	};
}

export async function getTranscript(appId: string, transcriptId: string) {
	return findTranscript(appId, transcriptId);
}

export async function getTranscriptResult(
	transcript: Pick<TranscriptRow, "status" | "resultKey">,
): Promise<TranscriptResultObject | null> {
	if (transcript.status !== "complete" || !transcript.resultKey) return null;
	const stored = await getDeveloperObjectText(transcript.resultKey);
	if (stored === null) return null;
	try {
		const result = JSON.parse(stored) as TranscriptResultObject;
		return { ...result, words: publicTranscriptWords(result.words ?? []) };
	} catch {
		return null;
	}
}

const hasTextColumn = sql<number>`(${developerTranscripts.text} IS NOT NULL AND ${developerTranscripts.text} <> '')`;

const summaryColumns = {
	id: developerTranscripts.id,
	appId: developerTranscripts.appId,
	externalUserId: developerTranscripts.externalUserId,
	name: developerTranscripts.name,
	status: developerTranscripts.status,
	sourceType: developerTranscripts.sourceType,
	sourceUrl: developerTranscripts.sourceUrl,
	s3Key: developerTranscripts.s3Key,
	resultKey: developerTranscripts.resultKey,
	sourceBytes: developerTranscripts.sourceBytes,
	durationSeconds: developerTranscripts.durationSeconds,
	requestedLanguage: developerTranscripts.requestedLanguage,
	language: developerTranscripts.language,
	wordCount: developerTranscripts.wordCount,
	hasText: hasTextColumn,
	reservedMicroCredits: developerTranscripts.reservedMicroCredits,
	billedMicroCredits: developerTranscripts.billedMicroCredits,
	errorCode: developerTranscripts.errorCode,
	errorMessage: developerTranscripts.errorMessage,
	metadata: developerTranscripts.metadata,
	runId: developerTranscripts.runId,
	queuedAt: developerTranscripts.queuedAt,
	startedAt: developerTranscripts.startedAt,
	completedAt: developerTranscripts.completedAt,
	deletedAt: developerTranscripts.deletedAt,
	createdAt: developerTranscripts.createdAt,
	updatedAt: developerTranscripts.updatedAt,
};

export async function listTranscripts(
	appId: string,
	options: {
		limit: number;
		offset?: number;
		cursor?: { createdAt: Date; id: string } | null;
		userId?: string | null;
		status?: DeveloperTranscriptStatus | null;
	},
) {
	const cursor = options.cursor ?? null;
	const rows = await db()
		.select(summaryColumns)
		.from(developerTranscripts)
		.where(
			and(
				eq(developerTranscripts.appId, appId),
				isNull(developerTranscripts.deletedAt),
				options.userId === null || options.userId === undefined
					? undefined
					: and(
							eq(developerTranscripts.externalUserId, options.userId),
							sql`CAST(${developerTranscripts.externalUserId} AS BINARY) = CAST(${options.userId} AS BINARY)`,
						),
				options.status
					? eq(developerTranscripts.status, options.status)
					: undefined,
				cursor
					? or(
							lt(developerTranscripts.createdAt, cursor.createdAt),
							and(
								eq(developerTranscripts.createdAt, cursor.createdAt),
								lt(developerTranscripts.id, cursor.id),
							),
						)
					: undefined,
			),
		)
		.orderBy(
			desc(developerTranscripts.createdAt),
			desc(developerTranscripts.id),
		)
		.limit(options.limit + 1)
		.offset(options.offset ?? 0);

	return {
		transcripts: rows.slice(0, options.limit),
		hasMore: rows.length > options.limit,
	};
}

export async function listConsoleTranscripts(appId: string, limit: number) {
	const rows = await db()
		.select({
			id: developerTranscripts.id,
			name: developerTranscripts.name,
			status: developerTranscripts.status,
			durationSeconds: developerTranscripts.durationSeconds,
			billedMicroCredits: developerTranscripts.billedMicroCredits,
			wordCount: developerTranscripts.wordCount,
			hasText: hasTextColumn,
			errorMessage: developerTranscripts.errorMessage,
			createdAt: developerTranscripts.createdAt,
		})
		.from(developerTranscripts)
		.where(
			and(
				eq(developerTranscripts.appId, appId),
				isNull(developerTranscripts.deletedAt),
			),
		)
		.orderBy(
			desc(developerTranscripts.createdAt),
			desc(developerTranscripts.id),
		)
		.limit(limit + 1);

	return { transcripts: rows.slice(0, limit), hasMore: rows.length > limit };
}

export async function deleteTranscript(
	appId: string,
	transcriptId: string,
): Promise<{ ok: true } | TranscriptFailure> {
	const transcript = await findTranscript(appId, transcriptId);
	if (!transcript) return NOT_FOUND;

	await db()
		.update(developerTranscripts)
		.set({ deletedAt: new Date(), text: null })
		.where(
			and(
				eq(developerTranscripts.id, transcript.id),
				eq(developerTranscripts.appId, appId),
			),
		);

	await deleteTranscriptObjects(appId, transcript.id);
	return { ok: true };
}

export async function deleteTranscriptObjects(
	appId: string,
	transcriptId: string,
) {
	const keys = transcriptObjectKeys(appId, transcriptId);
	await deleteDeveloperObjects([keys.source, keys.audio, keys.result]);
}

export async function expireStaleTranscripts(now = new Date()) {
	const uploadCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
	const jobCutoff = new Date(now.getTime() - 6 * 60 * 60 * 1000);
	const dispatchCutoff = new Date(now.getTime() - DISPATCH_RETRY_AFTER_MS);

	const stale = await db()
		.select({
			id: developerTranscripts.id,
			appId: developerTranscripts.appId,
			status: developerTranscripts.status,
		})
		.from(developerTranscripts)
		.where(
			or(
				and(
					eq(developerTranscripts.status, "uploading"),
					lt(developerTranscripts.updatedAt, uploadCutoff),
				),
				and(
					eq(developerTranscripts.status, "queued"),
					lt(developerTranscripts.queuedAt, jobCutoff),
				),
				and(
					eq(developerTranscripts.status, "processing"),
					lt(developerTranscripts.updatedAt, jobCutoff),
				),
			),
		)
		.limit(500);

	let expired = 0;
	for (const row of stale) {
		const uploading = row.status === "uploading";
		const result = await db()
			.update(developerTranscripts)
			.set({
				status: "error",
				errorCode: uploading ? "upload_expired" : "timed_out",
				errorMessage: uploading
					? "The file was not uploaded in time"
					: "The transcript did not finish in time. Nothing was charged.",
				reservedMicroCredits: 0,
				completedAt: now,
			})
			.where(
				and(
					eq(developerTranscripts.id, row.id),
					eq(developerTranscripts.status, row.status),
					uploading
						? lt(developerTranscripts.updatedAt, uploadCutoff)
						: undefined,
				),
			);
		if (affectedRows(result) === 0) continue;
		expired++;
		const keys = transcriptObjectKeys(row.appId, row.id);
		await deleteDeveloperObjects([keys.source, keys.audio, keys.result]);
	}

	const unstarted = await db()
		.select({ id: developerTranscripts.id })
		.from(developerTranscripts)
		.where(
			and(
				eq(developerTranscripts.status, "queued"),
				or(
					lt(developerTranscripts.startedAt, dispatchCutoff),
					and(
						isNull(developerTranscripts.startedAt),
						lt(developerTranscripts.createdAt, dispatchCutoff),
					),
				),
				isNull(developerTranscripts.deletedAt),
			),
		)
		.limit(100);

	let redispatched = 0;
	for (const row of unstarted) {
		if ((await dispatchTranscript(row.id, "queued")) === "dispatched") {
			redispatched++;
		}
	}

	return { expired, redispatched };
}

export async function getTranscriptionUsageSince(appId: string, since: Date) {
	const [row] = await db()
		.select({
			transcripts: count(),
			seconds: sql<
				string | number | null
			>`COALESCE(SUM(${developerTranscripts.durationSeconds}), 0)`,
			charged: sql<
				string | number | null
			>`COALESCE(SUM(${developerTranscripts.billedMicroCredits}), 0)`,
		})
		.from(developerTranscripts)
		.where(
			and(
				eq(developerTranscripts.appId, appId),
				eq(developerTranscripts.status, "complete"),
				gte(developerTranscripts.completedAt, since),
			),
		);

	return {
		transcripts: Number(row?.transcripts ?? 0) || 0,
		audioSeconds: Number(row?.seconds ?? 0) || 0,
		chargedMicroCredits: Number(row?.charged ?? 0) || 0,
	};
}
