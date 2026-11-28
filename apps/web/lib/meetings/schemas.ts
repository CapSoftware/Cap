import {
	AI_GENERATION_LANGUAGE_AUTO,
	AI_GENERATION_LANGUAGE_CODES,
	type AiGenerationLanguage,
} from "@cap/web-domain";
import { z } from "zod";
import { ASSEMBLYAI_SUPPORTED_LANGUAGES } from "@/lib/assemblyai";

export const MEETING_TRANSCRIPT_MAX_CHARS = 400_000;
// About 12 hours of dense speech. Longer meetings send their start and end.
export const MEETING_NOTES_TRANSCRIPT_MAX_CHARS = 1_000_000;
export const MEETING_JSON_BODY_MAX_BYTES = 4_000_000;
export const MEETING_KEYWORDS_MAX = 100;
export const MEETING_KEYWORD_MAX_CHARS = 50;
export const MEETING_KEYWORDS_HEADER = "x-cap-keywords";
export const MEETING_KEYWORDS_HEADER_MAX_CHARS = 8_000;

// The desktop clips these fields by Unicode characters, so the limits count
// characters too: `z.string().max` counts UTF-16 units, two per emoji.
function withinCharacters(value: string, max: number) {
	if (value.length <= max) return true;
	let count = 0;
	for (const _ of value) {
		count += 1;
		if (count > max) return false;
	}
	return true;
}

const text = (max: number) =>
	z
		.string()
		.refine(
			(value) => withinCharacters(value, max),
			`must be at most ${max} characters`,
		);

const isTimeZone = (value: string) => {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: value });
		return true;
	} catch {
		return false;
	}
};

const summaryLanguage = z.enum([
	AI_GENERATION_LANGUAGE_AUTO,
	...AI_GENERATION_LANGUAGE_CODES,
]);

export const meetingNotesRequestSchema = z
	.object({
		meetingId: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z0-9_-]+$/)
			.optional(),
		title: text(300).default(""),
		startedAt: z.iso.datetime({ offset: true }).optional(),
		timezone: z
			.string()
			.max(64)
			// Linux reports the /etc/localtime link target, which can sit in
			// zoneinfo/posix or zoneinfo/right; both hold the same zones.
			.transform((zone) => zone.replace(/^(?:posix|right)\//, ""))
			.refine(isTimeZone, "must be an IANA time zone")
			.optional(),
		participants: z
			.array(
				z.object({
					name: text(200).optional(),
					email: text(320).optional(),
					isSelf: z.boolean().optional(),
				}),
			)
			.max(100)
			.default([]),
		rawNotesMarkdown: text(50_000).default(""),
		transcript: text(MEETING_NOTES_TRANSCRIPT_MAX_CHARS).default(""),
		transcriptTruncated: z.boolean().default(false),
		template: z
			.object({
				name: text(100),
				description: text(500).default(""),
				sections: z
					.array(
						z.object({
							heading: z
								.string()
								.trim()
								.min(1)
								.refine(
									(value) => withinCharacters(value, 120),
									"must be at most 120 characters",
								),
							instruction: text(500).default(""),
						}),
					)
					.min(1)
					.max(12),
			})
			.optional(),
		vocabulary: z.array(text(100)).max(200).default([]),
		summaryLanguage: summaryLanguage.default(AI_GENERATION_LANGUAGE_AUTO),
		previous: z
			.object({
				markdown: text(100_000),
				instruction: text(2_000),
			})
			.optional(),
		headingCount: z.number().int().min(3).max(10).optional(),
	})
	.refine(
		(value) =>
			value.transcript.trim().length > 0 ||
			value.rawNotesMarkdown.trim().length > 0,
		{ message: "transcript or rawNotesMarkdown is required" },
	);

export type MeetingNotesRequest = z.infer<typeof meetingNotesRequestSchema>;

export const meetingAskRequestSchema = z
	.object({
		meetingId: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z0-9_-]+$/)
			.optional(),
		question: text(4_000).refine(
			(value) => value.trim().length > 0,
			"must not be empty",
		),
		transcript: text(MEETING_TRANSCRIPT_MAX_CHARS).default(""),
		notesMarkdown: text(100_000).default(""),
		title: text(300).optional(),
		// The transcript's label for the person asking, when they have a name.
		// Without it their lines are labelled "You".
		selfName: text(200).optional(),
		vocabulary: z.array(text(100)).max(200).default([]),
		history: z
			.array(
				z.object({
					role: z.enum(["user", "assistant"]),
					content: text(8_000),
				}),
			)
			.max(20)
			.default([]),
	})
	.refine(
		(value) =>
			value.transcript.trim().length > 0 ||
			value.notesMarkdown.trim().length > 0,
		{ message: "transcript or notesMarkdown is required" },
	);

export type MeetingAskRequest = z.infer<typeof meetingAskRequestSchema>;

export type ParseResult<T> =
	| { ok: true; data: T }
	| { ok: false; detail: string };

// Only the field path and zod's own message reach the client: neither
// includes submitted values, so error bodies never echo meeting content.
export function describeIssues(error: z.ZodError): string {
	const issue = error.issues[0];
	if (!issue) return "invalid body";
	const path = issue.path.map(String).join(".");
	return path ? `${path}: ${issue.message}` : issue.message;
}

export function parseMeetingBody<T>(
	schema: z.ZodType<T>,
	body: unknown,
): ParseResult<T> {
	const result = schema.safeParse(body);
	return result.success
		? { ok: true, data: result.data }
		: { ok: false, detail: describeIssues(result.error) };
}

export type TranscribeQuery = {
	language: AiGenerationLanguage;
	keywords: string[];
	/** Speaker labels for a meeting sent as clips: one session per meeting and
	 * track (opaque to the server) and the clip's number in it. */
	speakers?: { session: string; seq: number };
};

const SPEAKER_SESSION = /^[A-Za-z0-9_.:-]{1,100}$/;
const SPEAKER_SEQ_MAX = 10_000_000;

function decodeKeywordsHeader(value: string | undefined): string[] {
	if (!value || value.length > MEETING_KEYWORDS_HEADER_MAX_CHARS) return [];
	const terms = new Set<string>();
	for (const encoded of value.split(",")) {
		let term: string;
		try {
			term = decodeURIComponent(encoded);
		} catch {
			continue;
		}
		const normalized = term.replace(/\s+/g, " ").trim();
		if (normalized) terms.add(normalized);
	}
	return Array.from(terms);
}

export function parseTranscribeQuery(input: {
	language?: string;
	keywordsQuery?: string;
	keywordsHeader?: string;
	session?: string;
	seq?: string;
}): ParseResult<TranscribeQuery> {
	const language = input.language ?? AI_GENERATION_LANGUAGE_AUTO;
	if (
		language !== AI_GENERATION_LANGUAGE_AUTO &&
		!(ASSEMBLYAI_SUPPORTED_LANGUAGES as readonly string[]).includes(language)
	)
		return { ok: false, detail: "language: unsupported language" };

	if (input.keywordsQuery !== undefined)
		return {
			ok: false,
			detail: `keywords: send them in the ${MEETING_KEYWORDS_HEADER} header`,
		};

	const keywords = decodeKeywordsHeader(input.keywordsHeader);
	if (keywords.length > MEETING_KEYWORDS_MAX)
		return {
			ok: false,
			detail: `keywords: at most ${MEETING_KEYWORDS_MAX} terms`,
		};
	if (
		keywords.some((term) => !withinCharacters(term, MEETING_KEYWORD_MAX_CHARS))
	)
		return {
			ok: false,
			detail: `keywords: each term must be at most ${MEETING_KEYWORD_MAX_CHARS} characters`,
		};

	if (input.session === undefined && input.seq !== undefined)
		return { ok: false, detail: "seq: needs a session" };
	if (input.session === undefined)
		return {
			ok: true,
			data: { language: language as AiGenerationLanguage, keywords },
		};
	if (!SPEAKER_SESSION.test(input.session))
		return {
			ok: false,
			detail: "session: 1 to 100 letters, digits, '.', '_', ':' or '-'",
		};
	const seq = input.seq === undefined ? 0 : Number(input.seq);
	if (!Number.isInteger(seq) || seq < 0 || seq > SPEAKER_SEQ_MAX)
		return { ok: false, detail: "seq: a whole number from 0" };

	return {
		ok: true,
		data: {
			language: language as AiGenerationLanguage,
			keywords,
			speakers: { session: input.session, seq },
		},
	};
}

export function isJsonContentType(value: string | undefined): boolean {
	return value?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

export function isWavContentType(value: string | undefined): boolean {
	const mediaType = value?.split(";")[0]?.trim().toLowerCase();
	return mediaType === "audio/wav" || mediaType === "audio/x-wav";
}
