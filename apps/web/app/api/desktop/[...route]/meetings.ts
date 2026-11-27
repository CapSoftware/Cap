import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { serverEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";
import {
	generateText,
	streamText,
	type TextStreamPart,
	type ToolSet,
} from "ai";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { after } from "next/server";
import { isAiGenerationEnabledForUser } from "@/lib/ai-generation-entitlement";
import {
	createAssemblyAIClient,
	getAssemblyAITranscriptionOptions,
} from "@/lib/assemblyai";
import { getDesktopShareUrl } from "@/lib/desktop-share-url";
import { isNoSpokenAudioError } from "@/lib/live-transcribe-core";
import {
	gatewayAvailable,
	getMeetingsAiConfig,
	type MeetingModelSelection,
	type MeetingsAiConfig,
	meetingModelChain,
	meetingsAiConfigured,
	runMeetingChain,
} from "@/lib/meetings/ai-config";
import {
	MEETING_AUTH_FAILURE_RETRY_SECONDS,
	meetingAuthBlocked,
	meetingAuthFailureLimited,
} from "@/lib/meetings/auth-failures";
import {
	consumeMeetingAudioBudget,
	consumeMeetingBodyBudget,
	consumeMeetingRequestBudget,
	type MeetingEndpoint,
} from "@/lib/meetings/budgets";
import {
	createSseResponse,
	providerErrorSummary,
	readBodyLimited,
	SanitizedProviderError,
	type SseSend,
} from "@/lib/meetings/http";
import {
	buildAskPrompt,
	buildNotesChunkPrompt,
	buildNotesPrompt,
	chunkTranscript,
	createPromptBoundary,
	createTitleSplitter,
	deriveTitleFromNotes,
	NOTES_CHUNK_CHARS,
	type NotesSource,
	type TitleSplit,
} from "@/lib/meetings/prompts";
import {
	isJsonContentType,
	isWavContentType,
	MEETING_JSON_BODY_MAX_BYTES,
	MEETING_KEYWORDS_HEADER,
	MEETING_TRANSCRIPT_MAX_CHARS,
	type MeetingAskRequest,
	type MeetingNotesRequest,
	meetingAskRequestSchema,
	meetingNotesRequestSchema,
	meetingShareDocumentIdSchema,
	meetingShareRequestSchema,
	type ParseResult,
	parseMeetingBody,
	parseTranscribeQuery,
	type TranscribeQuery,
} from "@/lib/meetings/schemas";
import {
	deleteSharedNote,
	type ShareNoteResult,
	upsertSharedNote,
} from "@/lib/meetings/share";
import { isCapSpeechService } from "@/lib/meetings/speech";
import {
	claimTrialMeeting,
	completeTrialMeeting,
	releaseTrialMeeting,
	spendTrialAsk,
	trialRemaining,
} from "@/lib/meetings/trial";
import {
	fitTrialInput,
	trialTranscriptBudget,
} from "@/lib/meetings/trial-input";
import {
	MEETING_CLIP_MAX_BYTES,
	MEETING_CLIP_MAX_SECONDS,
	MEETING_CLIP_MIN_SAMPLES,
	parseWavClip,
} from "@/lib/meetings/wav";
import { getAuth } from "../../utils";

const rateLimited = (
	retryAfterSeconds: number,
	error: "rate_limited" | "daily_audio_limit" = "rate_limited",
) =>
	Response.json(
		{ error, retryAfterSeconds },
		{ status: 429, headers: { "Retry-After": String(retryAfterSeconds) } },
	);

// Signed-in requests are limited per user by the budgets below; only
// requests whose sign-in was not accepted are limited per address.
const withMeetingsAuth = createMiddleware<{
	Variables: {
		user: NonNullable<Awaited<ReturnType<typeof getAuth>>>["user"];
	};
}>(async (c, next) => {
	const headers = c.req.raw.headers;
	if (meetingAuthBlocked(headers))
		return rateLimited(MEETING_AUTH_FAILURE_RETRY_SECONDS);
	const auth = await getAuth(c);
	if (!auth) {
		if (await meetingAuthFailureLimited(headers))
			return rateLimited(MEETING_AUTH_FAILURE_RETRY_SECONDS);
		return c.text("User not authenticated", 401);
	}
	c.set("user", auth.user);
	await next();
});

export const app = new Hono().use(withMeetingsAuth);

const TRANSCRIBE_DEADLINE_MS = 90_000;
const TRANSCRIBE_POLL_MS = 1_000;
const NOTES_DEADLINE_MS = 270_000;
const ASK_DEADLINE_MS = 120_000;
const NOTES_CHUNK_CONCURRENCY = 4;
// The provider chain used off Vercel may have a much smaller context window
// than the gateway default, so long transcripts are condensed first there.
const FALLBACK_NOTES_SINGLE_PASS_CHARS = 60_000;
const TRIAL_BUSY_RETRY_SECONDS = 30;

type Feature = "transcription" | "notes" | "ask";

type MeetingUser = {
	id: string;
	stripeSubscriptionStatus?: string | null;
	thirdPartyStripeSubscriptionId?: string | null;
};

function isEntitled(user: MeetingUser, feature: Feature): boolean {
	if (!userIsPro(user)) return false;
	return feature === "transcription" || isAiGenerationEnabledForUser(user);
}

function isConfigured(feature: Feature, config: MeetingsAiConfig): boolean {
	if (feature === "ask")
		return config.askEnabled && meetingsAiConfigured("ask");
	if (feature === "transcription") {
		const env = serverEnv();
		return (
			config.transcriptionEnabled &&
			Boolean(env.ASSEMBLY_API_KEY) &&
			isCapSpeechService(env.ASSEMBLY_BASE_URL)
		);
	}
	return (
		config.notesEnabled &&
		meetingsAiConfigured("notes") &&
		meetingsAiConfigured("condense")
	);
}

type LogEntry = {
	outcome: string;
	status: number;
	inputBytes?: number;
	audioMs?: number;
	outputChars?: number;
	error?: string;
};

function requestLogger(userId: string, endpoint: MeetingEndpoint) {
	const startedAt = Date.now();
	return (entry: LogEntry) =>
		console.log(
			"[meetings]",
			JSON.stringify({
				userId,
				endpoint,
				...entry,
				latencyMs: Date.now() - startedAt,
			}),
		);
}

const errorResponse = (
	status: number,
	body: Record<string, unknown>,
	headers?: Record<string, string>,
) => Response.json(body, { status, headers });

const invalidRequest = (detail: string) =>
	errorResponse(400, { error: "invalid_request", detail });

function admit(
	user: MeetingUser,
	feature: Feature,
	config: MeetingsAiConfig,
): { response: Response; outcome: string } | null {
	if (!isEntitled(user, feature))
		return {
			response: errorResponse(402, { error: "upgrade_required" }),
			outcome: "upgrade_required",
		};
	if (!isConfigured(feature, config))
		return {
			response: errorResponse(503, { error: "not_configured" }),
			outcome: "not_configured",
		};
	return null;
}

app.get("/capabilities", async (c) => {
	const user = c.get("user");
	const config = await getMeetingsAiConfig();
	const notesConfigured = isConfigured("notes", config);
	const notes = isEntitled(user, "notes") && notesConfigured;
	const notesTrialRemaining =
		!notes && notesConfigured
			? await trialRemainingOrNone(user.id, config.trialMeetings)
			: undefined;
	return c.json(
		{
			transcription:
				isEntitled(user, "transcription") &&
				isConfigured("transcription", config),
			notes,
			...(notesTrialRemaining === undefined ? {} : { notesTrialRemaining }),
			limits: {
				maxClipSeconds: MEETING_CLIP_MAX_SECONDS,
				maxClipBytes: MEETING_CLIP_MAX_BYTES,
				maxTranscriptChars: MEETING_TRANSCRIPT_MAX_CHARS,
			},
		},
		200,
		{ "Cache-Control": "no-store" },
	);
});

// A failed lookup (the trial table not yet migrated, the database briefly
// down) offers no free meetings rather than failing the app's whole check.
async function trialRemainingOrNone(
	userId: string,
	limit: number,
): Promise<number | undefined> {
	try {
		return await trialRemaining(userId, limit);
	} catch (error) {
		console.error(
			"[meetings] free meeting lookup failed",
			providerErrorSummary(error),
		);
		return undefined;
	}
}

type TranscribeResult = {
	text: string;
	language: string | null;
	durationMs: number;
	words: {
		text: string;
		startMs: number;
		endMs: number;
		confidence: number;
		/** "A", "B", ... per meeting session; only when the request named one. */
		speaker?: string | null;
	}[];
};

const emptyTranscription = (durationMs: number): TranscribeResult => ({
	text: "",
	language: null,
	durationMs,
	words: [],
});

app.post("/transcribe", async (c) => {
	const user = c.get("user");
	const log = requestLogger(user.id, "transcribe");

	const denied = admit(user, "transcription", await getMeetingsAiConfig());
	if (denied) {
		log({ outcome: denied.outcome, status: denied.response.status });
		return denied.response;
	}

	const query = parseTranscribeQuery({
		language: c.req.query("language"),
		keywordsQuery: c.req.query("keywords"),
		keywordsHeader: c.req.header(MEETING_KEYWORDS_HEADER),
		session: c.req.query("session"),
		seq: c.req.query("seq"),
	});
	if (!query.ok) {
		log({ outcome: "invalid_request", status: 400 });
		return invalidRequest(query.detail);
	}
	if (!isWavContentType(c.req.header("content-type"))) {
		log({ outcome: "invalid_request", status: 400 });
		return invalidRequest("content-type: must be audio/wav");
	}

	const requestBudget = await consumeMeetingRequestBudget(
		"transcribe",
		user.id,
		c.req.raw.headers,
	);
	if (requestBudget.limited) {
		log({ outcome: "rate_limited", status: 429 });
		return rateLimited(requestBudget.retryAfterSeconds);
	}

	const body = await readBodyLimited(c.req.raw, MEETING_CLIP_MAX_BYTES);
	if (!body.ok) {
		const status = body.reason === "too_large" ? 413 : 400;
		log({ outcome: body.reason, status });
		return status === 413
			? errorResponse(413, { error: "payload_too_large" })
			: invalidRequest("body: unreadable");
	}

	const inputBytes = body.bytes.byteLength;
	const clip = parseWavClip(body.bytes);
	if (!clip.ok) {
		const status = clip.error === "too_large" ? 413 : 400;
		log({ outcome: clip.error, status, inputBytes });
		return status === 413
			? errorResponse(413, { error: "payload_too_large" })
			: invalidRequest(`audio: ${clip.error}`);
	}

	if (clip.samples < MEETING_CLIP_MIN_SAMPLES) {
		log({ outcome: "too_short", status: 200, inputBytes, audioMs: 0 });
		return c.json(emptyTranscription(clip.durationMs));
	}

	const audioBudget = await consumeMeetingAudioBudget(
		user.id,
		clip.samples,
		c.req.raw.headers,
	);
	if (audioBudget.limited) {
		log({ outcome: "audio_budget", status: 429, inputBytes });
		return rateLimited(
			audioBudget.retryAfterSeconds,
			audioBudget.daily ? "daily_audio_limit" : "rate_limited",
		);
	}

	const signal = AbortSignal.any([
		c.req.raw.signal,
		AbortSignal.timeout(TRANSCRIBE_DEADLINE_MS),
	]);
	try {
		const result = await transcribeClip(
			body.bytes,
			query.data,
			clip.durationMs,
			signal,
			user.id,
		);
		log({
			outcome: "ok",
			status: 200,
			inputBytes,
			audioMs: clip.durationMs,
			outputChars: result.text.length,
		});
		return c.json(result);
	} catch (error) {
		log({
			outcome: signal.aborted ? "aborted" : "provider_error",
			status: 502,
			inputBytes,
			audioMs: clip.durationMs,
			error: providerErrorSummary(error),
		});
		return errorResponse(502, { error: "transcription_failed" });
	}
});

async function transcribeClip(
	wav: Uint8Array,
	query: TranscribeQuery,
	durationMs: number,
	signal: AbortSignal,
	userId: string,
): Promise<TranscribeResult> {
	const client = createAssemblyAIClient();
	// Speaker labels that stay the same across a meeting's clips: the farm keeps
	// one speaker state per session, namespaced by user so sessions never mix.
	const options = {
		...getAssemblyAITranscriptionOptions(query.language),
		...(query.speakers
			? {
					speaker_labels: true,
					cap_speaker_session: `${userId}:${query.speakers.session}`,
					cap_speaker_seq: query.speakers.seq,
				}
			: {}),
	} as ReturnType<typeof getAssemblyAITranscriptionOptions>;
	const audio = await untilAborted(
		client.files.upload(
			Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength),
		),
		signal,
	);

	const submitted =
		query.keywords.length > 0
			? client.transcripts
					.submit({ audio, ...options, keyterms_prompt: query.keywords })
					.catch(() => client.transcripts.submit({ audio, ...options }))
			: client.transcripts.submit({ audio, ...options });
	// Registered before waiting, so the provider copy is deleted even when this
	// request gives up on the submission and it completes afterwards.
	after(async () => {
		const done = await Promise.race([
			submitted.catch(() => null),
			delay(TRANSCRIBE_DEADLINE_MS, null),
		]);
		if (done)
			await client.transcripts.delete(done.id).then(
				() => undefined,
				() => undefined,
			);
	});
	let transcript = await untilAborted(submitted, signal);

	const transcriptId = transcript.id;

	while (transcript.status !== "completed" && transcript.status !== "error") {
		await delay(TRANSCRIBE_POLL_MS, undefined, { signal });
		transcript = await untilAborted(
			client.transcripts.get(transcriptId),
			signal,
		);
	}

	if (transcript.status === "error") {
		if (isNoSpokenAudioError(transcript)) return emptyTranscription(durationMs);
		throw new Error("transcript_error");
	}

	return {
		text: transcript.text ?? "",
		language:
			typeof transcript.language_code === "string"
				? transcript.language_code
				: null,
		durationMs,
		words: (transcript.words ?? []).map((word) => ({
			text: word.text,
			startMs: word.start,
			endMs: word.end,
			confidence: word.confidence,
			...(query.speakers
				? {
						speaker:
							typeof word.speaker === "string" && word.speaker
								? word.speaker
								: null,
					}
				: {}),
		})),
	};
}

// The speech SDK takes no abort signal, so a stalled call is abandoned at the
// deadline or when the desktop app disconnects instead of holding the request.
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

async function readJsonBody<T>(
	request: Request,
	parse: (body: unknown) => ParseResult<T>,
): Promise<
	| { ok: true; data: T; inputBytes: number }
	| { ok: false; response: Response; outcome: string }
> {
	const body = await readBodyLimited(request, MEETING_JSON_BODY_MAX_BYTES);
	if (!body.ok)
		return body.reason === "too_large"
			? {
					ok: false,
					response: errorResponse(413, { error: "payload_too_large" }),
					outcome: "too_large",
				}
			: {
					ok: false,
					response: invalidRequest("body: unreadable"),
					outcome: "unreadable",
				};

	let json: unknown;
	try {
		json = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(body.bytes),
		);
	} catch {
		return {
			ok: false,
			response: invalidRequest("body: must be valid UTF-8 JSON"),
			outcome: "invalid_json",
		};
	}

	const parsed = parse(json);
	if (!parsed.ok)
		return {
			ok: false,
			response: invalidRequest(parsed.detail),
			outcome: "invalid_request",
		};
	return { ok: true, data: parsed.data, inputBytes: body.bytes.byteLength };
}

class EmptyCompletionError extends Error {
	constructor() {
		super("empty completion");
		this.name = "EmptyCompletionError";
	}
}

type FullStreamReader = ReadableStreamDefaultReader<TextStreamPart<ToolSet>>;

async function readNextText(reader: FullStreamReader): Promise<string | null> {
	while (true) {
		const { done, value } = await reader.read();
		if (done) return null;
		if (value.type === "error") throw new SanitizedProviderError(value.error);
		if (value.type === "abort") throw new Error("aborted");
		if (value.type === "text-delta" && value.text) return value.text;
	}
}

// Set once a model has answered a request, even with nothing: the provider has
// charged for it by then.
type Charge = { charged: boolean };

// The first text delta is read inside the provider chain so setup failures
// fall through to the next provider before anything reaches the client.
async function openTextStream(
	chain: MeetingModelSelection[],
	request: {
		system: string;
		messages: { role: "user" | "assistant"; content: string }[];
		maxOutputTokens?: number;
	},
	signal: AbortSignal,
	charge?: Charge,
): Promise<AsyncGenerator<string>> {
	const opened = await runMeetingChain(
		chain,
		async (selection) => {
			try {
				const result = streamText({
					model: selection.model(),
					system: request.system,
					messages: request.messages,
					maxOutputTokens: selection.maxOutputTokens,
					providerOptions: selection.providerOptions,
					abortSignal: signal,
					onError: () => undefined,
				});
				const reader = result.fullStream.getReader();
				const first = await readNextText(reader);
				if (charge) charge.charged = true;
				if (first === null) throw new EmptyCompletionError();
				return { reader, first };
			} catch (error) {
				throw new SanitizedProviderError(error);
			}
		},
		{ stopOnError: () => signal.aborted },
	);

	return (async function* () {
		try {
			yield opened.first;
			while (true) {
				const text = await readNextText(opened.reader);
				if (text === null) return;
				yield text;
			}
		} finally {
			opened.reader.cancel().catch(() => undefined);
		}
	})();
}

async function condenseTranscript(
	input: MeetingNotesRequest,
	config: MeetingsAiConfig,
	boundary: string,
	signal: AbortSignal,
	charge?: Charge,
): Promise<string[]> {
	const chain = meetingModelChain(config, "condense");
	const parts = chunkTranscript(input.transcript, NOTES_CHUNK_CHARS);
	const failed = new AbortController();
	const chunkSignal = AbortSignal.any([signal, failed.signal]);
	const results = new Array<string>(parts.length);
	let next = 0;

	const worker = async () => {
		while (next < parts.length) {
			const index = next++;
			const prompt = buildNotesChunkPrompt({
				boundary,
				part: parts[index] ?? "",
				index,
				total: parts.length,
				participants: input.participants,
				vocabulary: input.vocabulary,
				summaryLanguage: input.summaryLanguage,
			});
			results[index] = await runMeetingChain(
				chain,
				async (selection) => {
					try {
						const result = await generateText({
							model: selection.model(),
							system: prompt.system,
							prompt: prompt.user,
							maxOutputTokens: selection.maxOutputTokens,
							providerOptions: selection.providerOptions,
							abortSignal: chunkSignal,
						});
						if (charge) charge.charged = true;
						const text = result.text.trim();
						if (!text) throw new EmptyCompletionError();
						return text;
					} catch (error) {
						throw new SanitizedProviderError(error);
					}
				},
				{ stopOnError: () => chunkSignal.aborted },
			);
		}
	};

	try {
		await Promise.all(
			Array.from(
				{ length: Math.min(NOTES_CHUNK_CONCURRENCY, parts.length) },
				worker,
			),
		);
	} catch (error) {
		failed.abort();
		throw error;
	}
	return results;
}

async function generateNotes(
	input: MeetingNotesRequest,
	config: MeetingsAiConfig,
	send: SseSend,
	signal: AbortSignal,
	beforeDone: () => Promise<void> = async () => undefined,
	charge?: Charge,
): Promise<number> {
	const boundary = createPromptBoundary();
	const titleRequested = input.title.trim() === "";
	const singlePassChars = gatewayAvailable()
		? config.notesSinglePassChars
		: Math.min(config.notesSinglePassChars, FALLBACK_NOTES_SINGLE_PASS_CHARS);
	const source: NotesSource =
		input.transcript.length > singlePassChars
			? {
					kind: "sections",
					sections: await condenseTranscript(
						input,
						config,
						boundary,
						signal,
						charge,
					),
				}
			: { kind: "transcript", text: input.transcript };

	const prompt = buildNotesPrompt({
		...input,
		boundary,
		source,
		titleRequested,
	});
	const stream = await openTextStream(
		meetingModelChain(config, "notes"),
		{
			system: prompt.system,
			messages: [{ role: "user", content: prompt.user }],
		},
		signal,
		charge,
	);

	const splitter = titleRequested ? createTitleSplitter() : null;
	let notes = "";
	let titleSent = false;
	const emit = (split: TitleSplit) => {
		if (split.title && !titleSent) {
			titleSent = true;
			send("title", { title: split.title });
		}
		if (split.text) {
			notes += split.text;
			send("delta", { text: split.text });
		}
	};

	for await (const text of stream)
		emit(splitter ? splitter.push(text) : { text });
	if (splitter) emit(splitter.finish());
	if (titleRequested && !titleSent) {
		const title = deriveTitleFromNotes(notes);
		if (title) send("title", { title });
	}
	await beforeDone();
	send("done", { chars: notes.length });
	return notes.length;
}

// Stable for one meeting's material, so follow-up questions reuse the cached
// prompt prefix, and keyed by a server secret so nothing said in the meeting
// can predict the delimiter.
function askBoundary(input: MeetingAskRequest): string {
	return createHmac("sha256", serverEnv().NEXTAUTH_SECRET)
		.update(input.title ?? "")
		.update("\u0000")
		.update(input.notesMarkdown)
		.update("\u0000")
		.update(input.transcript)
		.digest("hex")
		.slice(0, 16);
}

async function answerQuestion(
	input: MeetingAskRequest,
	config: MeetingsAiConfig,
	send: SseSend,
	signal: AbortSignal,
	transcriptBytes?: number,
): Promise<number> {
	const prompt = buildAskPrompt({
		...input,
		boundary: askBoundary(input),
		transcriptBytes,
	});
	const stream = await openTextStream(
		meetingModelChain(config, "ask"),
		prompt,
		signal,
	);
	let chars = 0;
	for await (const text of stream) {
		chars += text.length;
		send("delta", { text });
	}
	send("done", { chars });
	return chars;
}

function streamGeneration(
	request: Request,
	log: (entry: LogEntry) => void,
	inputBytes: number,
	deadlineMs: number,
	generate: (send: SseSend, signal: AbortSignal) => Promise<number>,
): Response {
	return createSseResponse(
		async (send, signal) => {
			try {
				const outputChars = await generate(send, signal);
				log({ outcome: "ok", status: 200, inputBytes, outputChars });
			} catch (error) {
				send("error", { error: "generation_failed" });
				log({
					outcome: signal.aborted ? "aborted" : "generation_failed",
					status: 200,
					inputBytes,
					error: providerErrorSummary(error),
				});
			}
		},
		{ requestSignal: request.signal, deadlineMs },
	);
}

const upgradeRequired = () => errorResponse(402, { error: "upgrade_required" });

async function admitGeneration(
	user: MeetingUser,
	config: MeetingsAiConfig,
	feature: "notes" | "ask",
): Promise<{ response: Response; outcome: string } | "pro" | "trial"> {
	const denied = admit(user, feature, config);
	if (!denied) return "pro";
	if (denied.outcome !== "upgrade_required") return denied;
	if (!isConfigured(feature, config))
		return {
			response: errorResponse(503, { error: "not_configured" }),
			outcome: "not_configured",
		};
	return "trial";
}

app.post("/notes", async (c) => {
	const user = c.get("user");
	const log = requestLogger(user.id, "notes");

	const config = await getMeetingsAiConfig();
	const access = await admitGeneration(user, config, "notes");
	if (typeof access === "object") {
		log({ outcome: access.outcome, status: access.response.status });
		return access.response;
	}

	if (!isJsonContentType(c.req.header("content-type"))) {
		log({ outcome: "invalid_request", status: 400 });
		return invalidRequest("content-type: must be application/json");
	}

	const budget = await consumeMeetingRequestBudget(
		"notes",
		user.id,
		c.req.raw.headers,
	);
	if (budget.limited) {
		log({ outcome: "rate_limited", status: 429 });
		return rateLimited(budget.retryAfterSeconds);
	}

	const body = await readJsonBody(c.req.raw, (json) =>
		parseMeetingBody(meetingNotesRequestSchema, json),
	);
	if (!body.ok) {
		log({ outcome: body.outcome, status: body.response.status });
		return body.response;
	}

	const bodyBudget = await consumeMeetingBodyBudget(
		"notes",
		user.id,
		body.inputBytes,
		c.req.raw.headers,
	);
	if (bodyBudget.limited) {
		log({ outcome: "rate_limited", status: 429, inputBytes: body.inputBytes });
		return rateLimited(bodyBudget.retryAfterSeconds);
	}

	let input = body.data;
	const trialMeeting = access === "trial" ? input.meetingId : undefined;
	if (access === "trial") {
		const fit = fitTrialInput(input, body.inputBytes);
		if (!trialMeeting || !fit) {
			log({ outcome: "upgrade_required", status: 402 });
			return upgradeRequired();
		}
		if (fit.truncated) input = { ...fit.input, transcriptTruncated: true };
		const claim = await claimTrialMeeting(
			user.id,
			trialMeeting,
			config.trialMeetings,
		);
		if (claim === "busy") {
			log({ outcome: "trial_busy", status: 429 });
			return rateLimited(TRIAL_BUSY_RETRY_SECONDS);
		}
		if (claim === "exhausted" || claim === "runs_exhausted") {
			log({ outcome: "upgrade_required", status: 402 });
			return upgradeRequired();
		}
	}
	return streamGeneration(
		c.req.raw,
		log,
		body.inputBytes,
		NOTES_DEADLINE_MS,
		async (send, signal) => {
			let delivered = false;
			const charge: Charge = { charged: false };
			const tracked: SseSend = (event, data) => {
				if (event === "title" || event === "delta") delivered = true;
				send(event, data);
			};
			const markWritten = async () => {
				if (trialMeeting) await completeTrialMeeting(user.id, trialMeeting);
			};
			try {
				return await generateNotes(
					input,
					config,
					tracked,
					signal,
					markWritten,
					charge,
				);
			} catch (error) {
				// Notes that reached the app count as the free meeting, even if the
				// stream then failed or was dropped, and so does a run a model
				// answered with nothing. Only a run that failed before any model
				// answered gives it back: an app that hangs up keeps the meeting
				// claimed, so cancelling early can't buy unlimited free runs. The
				// same meeting can still be written later.
				if (trialMeeting) {
					const settle =
						delivered || charge.charged
							? markWritten()
							: c.req.raw.signal.aborted
								? Promise.resolve()
								: releaseTrialMeeting(user.id, trialMeeting);
					await settle.catch(() => undefined);
				}
				throw error;
			}
		},
	);
});

app.post("/ask", async (c) => {
	const user = c.get("user");
	const log = requestLogger(user.id, "ask");

	const config = await getMeetingsAiConfig();
	const access = await admitGeneration(user, config, "ask");
	if (typeof access === "object") {
		log({ outcome: access.outcome, status: access.response.status });
		return access.response;
	}

	if (!isJsonContentType(c.req.header("content-type"))) {
		log({ outcome: "invalid_request", status: 400 });
		return invalidRequest("content-type: must be application/json");
	}

	const budget = await consumeMeetingRequestBudget(
		"ask",
		user.id,
		c.req.raw.headers,
	);
	if (budget.limited) {
		log({ outcome: "rate_limited", status: 429 });
		return rateLimited(budget.retryAfterSeconds);
	}

	const body = await readJsonBody(c.req.raw, (json) =>
		parseMeetingBody(meetingAskRequestSchema, json),
	);
	if (!body.ok) {
		log({ outcome: body.outcome, status: body.response.status });
		return body.response;
	}

	const bodyBudget = await consumeMeetingBodyBudget(
		"ask",
		user.id,
		body.inputBytes,
		c.req.raw.headers,
	);
	if (bodyBudget.limited) {
		log({ outcome: "rate_limited", status: 429, inputBytes: body.inputBytes });
		return rateLimited(bodyBudget.retryAfterSeconds);
	}

	const input = body.data;
	let transcriptBytes: number | undefined;
	if (access === "trial") {
		const budget = trialTranscriptBudget(input, body.inputBytes);
		if (
			budget === null ||
			!(input.meetingId && (await spendTrialAsk(user.id, input.meetingId)))
		) {
			log({ outcome: "upgrade_required", status: 402 });
			return upgradeRequired();
		}
		transcriptBytes = budget;
	}
	return streamGeneration(
		c.req.raw,
		log,
		body.inputBytes,
		ASK_DEADLINE_MS,
		(send, signal) =>
			answerQuestion(input, config, send, signal, transcriptBytes),
	);
});

app.post("/share", async (c) => {
	const user = c.get("user");
	const log = requestLogger(user.id, "share");

	if (!isJsonContentType(c.req.header("content-type"))) {
		log({ outcome: "invalid_request", status: 400 });
		return invalidRequest("content-type: must be application/json");
	}

	const budget = await consumeMeetingRequestBudget(
		"share",
		user.id,
		c.req.raw.headers,
	);
	if (budget.limited) {
		log({ outcome: "rate_limited", status: 429 });
		return rateLimited(budget.retryAfterSeconds);
	}

	const body = await readJsonBody(c.req.raw, (json) =>
		parseMeetingBody(meetingShareRequestSchema, json),
	);
	if (!body.ok) {
		log({ outcome: body.outcome, status: body.response.status });
		return body.response;
	}

	const bodyBudget = await consumeMeetingBodyBudget(
		"share",
		user.id,
		body.inputBytes,
		c.req.raw.headers,
	);
	if (bodyBudget.limited) {
		log({ outcome: "rate_limited", status: 429, inputBytes: body.inputBytes });
		return rateLimited(bodyBudget.retryAfterSeconds);
	}

	let note: ShareNoteResult;
	try {
		note = await upsertSharedNote(user, body.data);
	} catch (error) {
		log({
			outcome: "failed",
			status: 500,
			inputBytes: body.inputBytes,
			error: providerErrorSummary(error),
		});
		return errorResponse(500, { error: "share_failed" });
	}
	if (note === "no_organization") {
		log({ outcome: "no_valid_org", status: 403 });
		return errorResponse(403, { error: "no_valid_org" });
	}
	if (note === "conflict") {
		log({ outcome: "conflict", status: 409 });
		return errorResponse(409, { error: "conflict" });
	}

	const shareUrl =
		(await getDesktopShareUrl(note.orgId, note.id)) ??
		`${serverEnv().WEB_URL}/s/${note.id}`;
	log({
		outcome: note.created ? "created" : "updated",
		status: 200,
		inputBytes: body.inputBytes,
	});
	return c.json({ id: note.id, shareUrl, created: note.created }, 200, {
		"Cache-Control": "no-store",
	});
});

app.delete("/share/:documentId", async (c) => {
	const user = c.get("user");
	const log = requestLogger(user.id, "share");

	const documentId = meetingShareDocumentIdSchema.safeParse(
		c.req.param("documentId"),
	);
	if (!documentId.success) {
		log({ outcome: "invalid_request", status: 400 });
		return invalidRequest("documentId: invalid");
	}

	const budget = await consumeMeetingRequestBudget(
		"share",
		user.id,
		c.req.raw.headers,
	);
	if (budget.limited) {
		log({ outcome: "rate_limited", status: 429 });
		return rateLimited(budget.retryAfterSeconds);
	}

	let deleted: boolean;
	try {
		deleted = await deleteSharedNote(user, documentId.data);
	} catch (error) {
		log({
			outcome: "failed",
			status: 500,
			error: providerErrorSummary(error),
		});
		return errorResponse(500, { error: "share_failed" });
	}

	log({ outcome: deleted ? "deleted" : "not_shared", status: 200 });
	return c.json({ deleted }, 200, { "Cache-Control": "no-store" });
});
