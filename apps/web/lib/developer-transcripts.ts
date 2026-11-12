import type {
	DeveloperTranscriptStatus,
	developerTranscripts,
} from "@cap/database/schema";
import { MICRO_CREDITS_PER_DOLLAR } from "@/lib/developer-pricing";

export const TRANSCRIPT_MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
export const TRANSCRIPT_MAX_URL_BYTES = 2 * 1024 * 1024 * 1024;
export const TRANSCRIPT_MAX_SPOOLED_URL_BYTES = 400 * 1024 * 1024;
export const TRANSCRIPT_MAX_DURATION_SECONDS = 4 * 60 * 60;
export const TRANSCRIPT_DURATION_SLACK_SECONDS = 1;
export const TRANSCRIPT_MIN_START_BALANCE_MICRO_CREDITS = 1_000;
export const TRANSCRIPT_UPLOAD_URL_TTL_SECONDS = 60 * 60;
export const TRANSCRIPT_URL_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
export const TRANSCRIPT_MAX_URL_LENGTH = 2_048;
export const TRANSCRIPT_MAX_METADATA_BYTES = 8_192;

export const TRANSCRIPT_STATUSES = [
	"uploading",
	"queued",
	"processing",
	"complete",
	"error",
] as const satisfies readonly DeveloperTranscriptStatus[];

export type TranscriptErrorCode =
	| "insufficient_credits"
	| "source_unreachable"
	| "source_blocked"
	| "source_too_large"
	| "source_missing"
	| "no_audio_track"
	| "unsupported_format"
	| "no_speech"
	| "duration_too_long"
	| "upload_expired"
	| "timed_out"
	| "transcription_failed";

export type TranscriptWord = {
	text: string;
	start: number;
	end: number;
};

export type TranscriptSegment = {
	text: string;
	start: number;
	end: number;
};

export type TranscriptResultObject = {
	text: string;
	language: string | null;
	durationSeconds: number;
	words: TranscriptWord[];
	segments: TranscriptSegment[];
};

type TranscriptRow = typeof developerTranscripts.$inferSelect;

export type TranscriptSummaryRow = Omit<TranscriptRow, "text"> & {
	hasText?: boolean | number | null;
};

export function isTranscriptStatus(
	value: string | undefined | null,
): value is DeveloperTranscriptStatus {
	return (TRANSCRIPT_STATUSES as readonly string[]).includes(value ?? "");
}

export const DEVELOPER_UPLOAD_PREFIX = "developer/_uploads/";
export const DEVELOPER_TRANSCRIPT_UPLOAD_MAX_AGE_MS = 8 * 60 * 60 * 1000;
export const DEVELOPER_VIDEO_UPLOAD_MAX_AGE_MS = 48 * 60 * 60 * 1000;

export function isStaleDeveloperUpload(
	key: string,
	lastModified: Date,
	now: Date,
) {
	if (!key.startsWith(DEVELOPER_UPLOAD_PREFIX)) return false;
	const name = key.split("/").pop() ?? "";
	const maxAge = name.startsWith("v-")
		? DEVELOPER_VIDEO_UPLOAD_MAX_AGE_MS
		: DEVELOPER_TRANSCRIPT_UPLOAD_MAX_AGE_MS;
	return now.getTime() - lastModified.getTime() > maxAge;
}

export function transcriptObjectKeys(appId: string, transcriptId: string) {
	const base = `developer/${appId}/transcripts/${transcriptId}`;
	return {
		source: `${DEVELOPER_UPLOAD_PREFIX}${appId}/t-${transcriptId}`,
		audio: `${base}/audio.mp3`,
		result: `${base}/result.json`,
	};
}

export function transcriptNameFromFile(fileName: string | undefined | null) {
	const base = (fileName ?? "").split(/[\\/]/).pop() ?? "";
	const trimmed = base.replace(/\.[^./]+$/, "").trim();
	return (trimmed || base.trim() || "Untitled").slice(0, 255);
}

function decodePathSegment(segment: string) {
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

export function transcriptNameFromUrl(url: string) {
	try {
		const { pathname, hostname } = new URL(url);
		const last = pathname.split("/").filter(Boolean).pop();
		if (last) return transcriptNameFromFile(decodePathSegment(last));
		return hostname.slice(0, 255) || "Untitled";
	} catch {
		return "Untitled";
	}
}

export function microCreditsToDollars(microCredits: number) {
	return (Number(microCredits) || 0) / MICRO_CREDITS_PER_DOLLAR;
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);

export function publicSourceUrl(url: string | null) {
	if (!url) return null;
	const end = url.search(/[?#]/);
	return end === -1 ? url : url.slice(0, end);
}

const lastUpdate = (row: { updatedAt: Date; completedAt: Date | null }) =>
	row.completedAt && row.completedAt.getTime() > row.updatedAt.getTime()
		? row.completedAt
		: row.updatedAt;

export function transcriptUploadExpiry(row: { updatedAt: Date }) {
	return new Date(
		row.updatedAt.getTime() + TRANSCRIPT_UPLOAD_URL_TTL_SECONDS * 1000,
	);
}

export function publicTranscriptWords(
	words: readonly TranscriptWord[],
): TranscriptWord[] {
	return words.map((word) => ({
		text: word.text,
		start: word.start,
		end: word.end,
	}));
}

export function serializeTranscript(
	row: TranscriptSummaryRow & { text?: string | null },
	options: { includeText?: boolean } = {},
) {
	const complete = row.status === "complete";
	return {
		id: row.id,
		status: row.status,
		name: row.name,
		source:
			row.sourceType === "url"
				? { type: "url" as const, url: publicSourceUrl(row.sourceUrl) }
				: { type: "upload" as const, url: null },
		durationSeconds: row.durationSeconds,
		language: row.language,
		wordCount: row.wordCount,
		...(options.includeText
			? { text: complete ? (row.text ?? "") : null }
			: {}),
		costMicroCredits: row.billedMicroCredits,
		costDollars: microCreditsToDollars(row.billedMicroCredits),
		error:
			row.status === "error"
				? {
						code: row.errorCode ?? "transcription_failed",
						message: row.errorMessage ?? "The transcript could not be created",
					}
				: null,
		userId: row.externalUserId,
		metadata: row.metadata ?? null,
		createdAt: row.createdAt.toISOString(),
		updatedAt: lastUpdate(row).toISOString(),
		completedAt: iso(row.completedAt),
	};
}

export type SerializedTranscript = ReturnType<typeof serializeTranscript>;

export function toAgentDeveloperTranscript(row: TranscriptSummaryRow) {
	return {
		id: row.id,
		appId: row.appId,
		status: row.status,
		name: row.name,
		sourceType: row.sourceType,
		sourceUrl: publicSourceUrl(row.sourceUrl),
		durationSeconds: row.durationSeconds,
		language: row.language,
		wordCount: row.wordCount,
		costMicroCredits: row.billedMicroCredits,
		errorCode: row.status === "error" ? row.errorCode : null,
		errorMessage: row.status === "error" ? row.errorMessage : null,
		externalUserId: row.externalUserId,
		createdAt: row.createdAt.toISOString(),
		updatedAt: lastUpdate(row).toISOString(),
		completedAt: row.completedAt?.toISOString() ?? null,
	};
}

type SpeechWord = {
	text: string;
	start: number;
	end: number;
	confidence?: number | null;
};

const SEGMENT_MAX_WORDS = 40;
const SEGMENT_GAP_MS = 1_200;

const seconds = (milliseconds: number) =>
	Math.max(0, Math.round(milliseconds)) / 1000;

export function buildTranscriptResult(input: {
	text: string | null | undefined;
	words: readonly SpeechWord[] | null | undefined;
	language: string | null | undefined;
	durationSeconds: number;
}): TranscriptResultObject {
	const sourceWords = (input.words ?? []).filter(
		(word) => typeof word?.text === "string" && word.text.length > 0,
	);
	const words: TranscriptWord[] = sourceWords.map((word) => ({
		text: word.text,
		start: seconds(word.start),
		end: seconds(word.end),
	}));

	const segments: TranscriptSegment[] = [];
	let current: SpeechWord[] = [];
	const flush = () => {
		const first = current[0];
		const last = current[current.length - 1];
		if (!first || !last) return;
		segments.push({
			text: current.map((word) => word.text).join(" "),
			start: seconds(first.start),
			end: seconds(last.end),
		});
		current = [];
	};
	sourceWords.forEach((word, index) => {
		current.push(word);
		const next = sourceWords[index + 1];
		if (
			!next ||
			/[.!?。！？]["')\]]?$/.test(word.text) ||
			next.start - word.end > SEGMENT_GAP_MS ||
			current.length >= SEGMENT_MAX_WORDS
		) {
			flush();
		}
	});

	const text =
		typeof input.text === "string" && input.text.trim().length > 0
			? input.text.trim()
			: sourceWords.map((word) => word.text).join(" ");

	return {
		text,
		language: input.language ?? null,
		durationSeconds: input.durationSeconds,
		words,
		segments,
	};
}

export function transcriptWordCount(
	result: Pick<TranscriptResultObject, "text" | "words">,
) {
	return result.words.length || result.text.split(/\s+/).filter(Boolean).length;
}

export function transcriptHasNoSpeech(row: {
	status: string;
	wordCount: number | null;
	hasText?: boolean | number | null;
}) {
	return row.status === "complete" && row.wordCount === 0 && !row.hasText;
}

export function measuredTranscriptDuration(input: {
	extractedAudioSeconds: number | null | undefined;
	serviceDurationSeconds: number | null | undefined;
	lastWordEndMs: number | null | undefined;
}) {
	const candidates = [
		input.extractedAudioSeconds,
		input.serviceDurationSeconds,
		typeof input.lastWordEndMs === "number" ? input.lastWordEndMs / 1000 : null,
	];
	for (const candidate of candidates) {
		if (
			typeof candidate === "number" &&
			Number.isFinite(candidate) &&
			candidate > 0
		) {
			return candidate;
		}
	}
	return 0;
}
