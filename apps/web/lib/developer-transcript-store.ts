import { createHash } from "node:crypto";
import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import {
	type DeveloperTranscriptStatus,
	developerApps,
	developerTranscripts,
	users,
} from "@cap/database/schema";
import {
	and,
	count,
	desc,
	eq,
	gte,
	inArray,
	isNull,
	lt,
	or,
	sql,
} from "drizzle-orm";
import { start } from "workflow/api";
import { hasMinimumTranscriptBalance } from "@/lib/developer-transcript-billing";
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
	TRANSCRIPT_MAX_METADATA_BYTES,
	TRANSCRIPT_MAX_UPLOAD_BYTES,
	TRANSCRIPT_MAX_URL_LENGTH,
	TRANSCRIPT_UPLOAD_URL_TTL_SECONDS,
	type TranscriptResultObject,
	transcriptNameFromFile,
	transcriptNameFromUrl,
	transcriptObjectKeys,
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

const INSUFFICIENT_CREDITS = fail(
	402,
	"insufficient_credits",
	"Insufficient credits",
	"Add credits to this app at https://cap.so/dashboard/infra, then retry.",
);

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
	return createHash("sha256")
		.update(["developer-transcript", appId, key].join("\0"), "utf8")
		.digest("base64url")
		.slice(0, 15);
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
			'Use "auto" or a supported two-letter language code such as "en".',
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

async function dispatchTranscript(
	transcriptId: string,
	from: "uploading" | "queued",
	sourceBytes?: number,
) {
	const claim = await db()
		.update(developerTranscripts)
		.set({
			status: "queued",
			startedAt: new Date(),
			...(sourceBytes !== undefined ? { sourceBytes } : {}),
		})
		.where(
			and(
				eq(developerTranscripts.id, transcriptId),
				eq(developerTranscripts.status, from),
				isNull(developerTranscripts.startedAt),
				isNull(developerTranscripts.deletedAt),
			),
		);
	if (affectedRows(claim) === 0) return "already_dispatched" as const;

	try {
		await start(developerTranscribeWorkflow, [{ transcriptId }]);
		return "dispatched" as const;
	} catch (error) {
		console.error(
			`[developer-transcripts] Failed to start workflow for ${transcriptId}`,
			error,
		);
		await db()
			.update(developerTranscripts)
			.set({ status: from, startedAt: null })
			.where(
				and(
					eq(developerTranscripts.id, transcriptId),
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
	if (!(await hasMinimumTranscriptBalance(appId))) return INSUFFICIENT_CREDITS;
	return null;
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

	if (input.idempotencyKey) {
		const existing = await findTranscriptAnyState(appId, id);
		if (existing) {
			if (existing.sourceType !== "url" || existing.sourceUrl !== url) {
				return IDEMPOTENCY_CONFLICT;
			}
			if (existing.deletedAt) return IDEMPOTENCY_KEY_RETIRED;
			return { ok: true, transcript: existing };
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
			sourceType: "url",
			sourceUrl: url,
			s3Key: transcriptObjectKeys(appId, id).source,
			requestedLanguage: options.requestedLanguage,
			metadata: options.metadata,
		})
		.onDuplicateKeyUpdate({ set: { id } });

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
	if (transcript.sourceType !== "url" || transcript.sourceUrl !== url) {
		return IDEMPOTENCY_CONFLICT;
	}
	return { ok: true, transcript };
}

export type TranscriptUploadTarget = {
	method: "PUT";
	url: string;
	headers: Record<string, string>;
	expiresAt: string;
};

async function uploadTargetFor(
	key: string,
	contentLength: number,
): Promise<TranscriptUploadTarget> {
	return {
		method: "PUT",
		url: await presignDeveloperUpload(key, contentLength),
		headers: { "Content-Length": String(contentLength) },
		expiresAt: new Date(
			Date.now() + TRANSCRIPT_UPLOAD_URL_TTL_SECONDS * 1000,
		).toISOString(),
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
		if (
			existing.sourceType !== "upload" ||
			existing.sourceBytes !== input.contentLength
		) {
			return IDEMPOTENCY_CONFLICT;
		}
		if (existing.deletedAt) return IDEMPOTENCY_KEY_RETIRED;
		return {
			ok: true as const,
			transcript: existing,
			upload:
				existing.status === "uploading"
					? await uploadTargetFor(keys.source, input.contentLength)
					: null,
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
	if (transcript.status !== "uploading") return { ok: true, transcript };

	const keys = transcriptObjectKeys(appId, transcript.id);
	const size = await developerObjectSize(keys.source);
	if (size === null || size === 0) {
		return fail(
			409,
			"upload_not_found",
			"The file has not been uploaded yet",
			"PUT the file to the upload URL, then start the transcript again.",
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
		return JSON.parse(stored) as TranscriptResultObject;
	} catch {
		return null;
	}
}

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
	reservedMicroCredits: developerTranscripts.reservedMicroCredits,
	billedMicroCredits: developerTranscripts.billedMicroCredits,
	errorCode: developerTranscripts.errorCode,
	errorMessage: developerTranscripts.errorMessage,
	metadata: developerTranscripts.metadata,
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
				options.userId
					? eq(developerTranscripts.externalUserId, options.userId)
					: undefined,
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
					inArray(developerTranscripts.status, ["queued", "processing"]),
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
				completedAt: now,
			})
			.where(
				and(
					eq(developerTranscripts.id, row.id),
					eq(developerTranscripts.status, row.status),
				),
			);
		if (affectedRows(result) === 0) continue;
		expired++;
		const keys = transcriptObjectKeys(row.appId, row.id);
		await deleteDeveloperObjects([keys.source, keys.audio, keys.result]);
	}
	return { expired };
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
