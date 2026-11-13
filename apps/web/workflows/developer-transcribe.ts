import { randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { db } from "@cap/database";
import { developerTranscripts } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { sleep } from "workflow";
import {
	extractTranscriptAudioBytes,
	TRANSCRIPT_AUDIO_BITS_PER_SECOND,
	TRANSCRIPT_AUDIO_MAX_BYTES,
	TRANSCRIPT_AUDIO_MAX_SECONDS,
} from "@/lib/developer-transcript-audio";
import {
	holdTranscriptCredits,
	INSUFFICIENT_CREDITS_MESSAGE,
	reserveTranscriptCredits,
	settleTranscript,
	type TranscriptHold,
} from "@/lib/developer-transcript-billing";
import {
	insufficientHoldMessage,
	transcriptHoldCoversSeconds,
	transcriptHoldForAudioSeconds,
	transcriptHoldForSourceBytes,
} from "@/lib/developer-transcript-hold";
import {
	claimTranscriptRun,
	failTranscriptRun,
	transcriptAwaitsSpeech,
} from "@/lib/developer-transcript-run";
import {
	parseTranscriptLanguage,
	transcribeSpeech,
} from "@/lib/developer-transcript-speech";
import {
	deleteDeveloperObjects,
	developerObjectSize,
	developerObjectUrl,
	getDeveloperObjectText,
	putDeveloperObject,
	putDeveloperObjectFile,
	putDeveloperObjectStream,
} from "@/lib/developer-transcript-storage";
import {
	buildTranscriptResult,
	measuredTranscriptDuration,
	TRANSCRIPT_MAX_SPOOLED_URL_BYTES,
	TRANSCRIPT_MAX_UPLOAD_BYTES,
	TRANSCRIPT_MAX_URL_BYTES,
	TRANSCRIPT_URL_DOWNLOAD_TIMEOUT_MS,
	type TranscriptErrorCode,
	type TranscriptResultObject,
	transcriptObjectKeys,
	transcriptWordCount,
} from "@/lib/developer-transcripts";
import {
	findVideoForTranscript,
	syncVideoCaptions,
} from "@/lib/developer-video-captions";
import { urlIsSelfContainedMedia } from "@/lib/media-container";
import { measureMp3DurationSeconds } from "@/lib/mp3-duration";
import {
	fetchPublicMedia,
	limitStreamBytes,
	PublicMediaFetchError,
	readStreamBounded,
	StreamTooLargeError,
} from "@/lib/public-media-fetch";
import { fetchStorageUrl } from "@/lib/storage-fetch";

const downloadLimit = () =>
	TRANSCRIPT_URL_DOWNLOAD_TIMEOUT_MS >= 60_000
		? `${Math.round(TRANSCRIPT_URL_DOWNLOAD_TIMEOUT_MS / 60_000)} minutes`
		: `${Math.round(TRANSCRIPT_URL_DOWNLOAD_TIMEOUT_MS / 1000)} seconds`;

const HOLD_WAIT_LIMIT_SECONDS = 15 * 60;
const HOLD_RETRY_MAX_SECONDS = 10;
const HOLD_RAISE_LIMIT = 2;

type StepFailure = { ok: false; code: TranscriptErrorCode; message: string };

type KnownSource = { bytes: number | null };

type HoldWait = {
	ok: false;
	wait: true;
	neededMicroCredits: number;
	availableMicroCredits: number;
	known: KnownSource | null;
};

type HoldRaise = { ok: false; raise: true; reportedSeconds: number | null };

type HoldGate = { waitedSeconds: number; tries: number };

const failure = (code: TranscriptErrorCode, message: string): StepFailure => ({
	ok: false,
	code,
	message,
});

const notHeld = (
	hold: Exclude<TranscriptHold, { state: "held" }>,
	known: KnownSource | null,
): StepFailure | HoldWait => {
	if (hold.state === "skipped") {
		return failure("source_missing", FAILURE_MESSAGES.source_missing);
	}
	if (hold.state === "insufficient") {
		return failure(
			"insufficient_credits",
			insufficientHoldMessage(
				hold.neededMicroCredits,
				hold.availableMicroCredits,
			),
		);
	}
	return {
		ok: false,
		wait: true,
		neededMicroCredits: hold.neededMicroCredits,
		availableMicroCredits: hold.availableMicroCredits,
		known,
	};
};

const nextHoldWait = (
	gate: HoldGate,
	wait: HoldWait,
): StepFailure | { seconds: number } => {
	if (gate.waitedSeconds >= HOLD_WAIT_LIMIT_SECONDS) {
		return failure(
			"insufficient_credits",
			insufficientHoldMessage(
				wait.neededMicroCredits,
				wait.availableMicroCredits,
			),
		);
	}
	const seconds = Math.min(HOLD_RETRY_MAX_SECONDS, 2 + gate.tries);
	gate.tries += 1;
	gate.waitedSeconds += seconds;
	return { seconds };
};

const asFailure = (result: StepFailure | HoldWait | HoldRaise): StepFailure => {
	if ("wait" in result) {
		return failure(
			"insufficient_credits",
			insufficientHoldMessage(
				result.neededMicroCredits,
				result.availableMicroCredits,
			),
		);
	}
	if ("raise" in result) {
		return failure(
			"transcription_failed",
			FAILURE_MESSAGES.transcription_failed,
		);
	}
	return result;
};

const FAILURE_MESSAGES = {
	source_missing: "The source file was not found",
	video_missing: "The video was deleted before it could be transcribed",
	deleted: "The transcript was deleted before its audio was transcribed",
	source_too_large: "The source file is larger than the 2 GB limit",
	source_unreachable: "The file at the URL could not be downloaded",
	source_incomplete: "The file at the URL ended before its declared length",
	source_blocked: "The URL does not point to a public address",
	no_audio_track: "The file has no audio track",
	unsupported_format: "The file is not a supported audio or video format",
	duration_too_long: "The audio is longer than the 4 hour limit",
	transcription_failed: "The transcript could not be created",
} as const;

interface DeveloperTranscribePayload {
	transcriptId: string;
	runId: string;
}

export async function developerTranscribeWorkflow(
	payload: DeveloperTranscribePayload,
) {
	"use workflow";

	const { transcriptId, runId } = payload;

	try {
		const fast = await runTranscriptFastPath(transcriptId, runId);
		if (fast.resume === "unclaimed") {
			return { success: true, message: "Transcript is not waiting to run" };
		}
		if (
			fast.resume === "claim" &&
			!(await claimTranscript(transcriptId, runId))
		) {
			return { success: true, message: "Transcript is not waiting to run" };
		}

		const gate: HoldGate = { waitedSeconds: 0, tries: 0 };
		const stop = async (result: StepFailure | HoldWait | HoldRaise) => {
			const failed = asFailure(result);
			await failTranscriptStep(
				transcriptId,
				runId,
				failed.code,
				failed.message,
			);
			return { success: false, message: failed.message };
		};

		if (fast.resume === "claim" || fast.resume === "prepare") {
			let source =
				fast.resume === "prepare" && fast.source
					? fast.source
					: await prepareTranscriptSource(transcriptId, null);
			while (!source.ok && "wait" in source) {
				const next = nextHoldWait(gate, source);
				if ("code" in next) return stop(next);
				await sleep(`${next.seconds}s`);
				source = await prepareTranscriptSource(
					transcriptId,
					source.known ?? { bytes: null },
				);
			}
			if (!source.ok) return stop(source);
		}

		if (
			fast.resume === "claim" ||
			fast.resume === "prepare" ||
			fast.resume === "extract"
		) {
			let audio =
				fast.resume === "extract" && fast.audio
					? fast.audio
					: await extractTranscriptAudio(transcriptId);
			for (
				let raises = 0;
				!audio.ok && "raise" in audio && raises < HOLD_RAISE_LIMIT;
				raises++
			) {
				const { reportedSeconds } = audio;
				let raised = await raiseTranscriptHold(transcriptId, reportedSeconds);
				while (!raised.ok && "wait" in raised) {
					const next = nextHoldWait(gate, raised);
					if ("code" in next) return stop(next);
					await sleep(`${next.seconds}s`);
					raised = await raiseTranscriptHold(transcriptId, reportedSeconds);
				}
				if (!raised.ok) return stop(raised);
				audio = await extractTranscriptAudio(transcriptId);
			}
			if (!audio.ok) return stop(audio);
		}

		const transcription =
			fast.resume === "settle" || fast.resume === "done"
				? fast.transcription
				: await transcribeTranscriptAudio(transcriptId);
		if (!transcription.ok) {
			await failTranscriptStep(
				transcriptId,
				runId,
				transcription.code,
				transcription.message,
			);
			return { success: false, message: transcription.message };
		}

		const settlement =
			fast.resume === "done"
				? fast.settlement
				: await settleTranscriptStep(transcriptId, transcription);
		await cleanupTranscriptObjects(transcriptId, settlement !== "complete");
		if (settlement === "complete") await writeVideoCaptions(transcriptId);
		return {
			success: settlement === "complete",
			message:
				settlement === "complete"
					? "Transcript completed"
					: `Transcript was not completed: ${settlement}`,
		};
	} catch (error) {
		await failTranscriptStep(
			transcriptId,
			runId,
			"transcription_failed",
			FAILURE_MESSAGES.transcription_failed,
		);
		throw error;
	}
}

async function loadTranscript(transcriptId: string) {
	const row = await loadTranscriptRow(transcriptId);
	return row && !row.deletedAt ? row : null;
}

async function loadTranscriptRow(transcriptId: string) {
	const [row] = await db()
		.select({
			id: developerTranscripts.id,
			appId: developerTranscripts.appId,
			status: developerTranscripts.status,
			sourceType: developerTranscripts.sourceType,
			sourceUrl: developerTranscripts.sourceUrl,
			videoId: developerTranscripts.videoId,
			s3Key: developerTranscripts.s3Key,
			requestedLanguage: developerTranscripts.requestedLanguage,
			durationSeconds: developerTranscripts.durationSeconds,
			reservedMicroCredits: developerTranscripts.reservedMicroCredits,
			deletedAt: developerTranscripts.deletedAt,
		})
		.from(developerTranscripts)
		.where(eq(developerTranscripts.id, transcriptId))
		.limit(1);
	return row ?? null;
}

export const FAST_PATH_MAX_AUDIO_SECONDS = 30 * 60;
export const FAST_PATH_TRANSCRIBE_BEFORE_MS = 2 * 60 * 1000;

type FastPath =
	| { resume: "unclaimed" }
	| { resume: "claim" }
	| { resume: "prepare"; source: StepFailure | HoldWait | null }
	| { resume: "extract"; audio: StepFailure | HoldRaise | null }
	| { resume: "transcribe" }
	| { resume: "settle"; transcription: TranscriptionSummary | StepFailure }
	| {
			resume: "done";
			transcription: TranscriptionSummary;
			settlement: Settlement;
	  };

const handOff = (transcriptId: string, stage: string, error: unknown) => {
	console.error(
		`[developer-transcribe] ${stage} failed in the fast path for ${transcriptId}, continuing step by step`,
		error,
	);
};

async function runTranscriptFastPath(
	transcriptId: string,
	runId: string,
): Promise<FastPath> {
	"use step";

	const startedAt = Date.now();
	try {
		if (!(await claimTranscriptRun(transcriptId, runId))) {
			return { resume: "unclaimed" };
		}
	} catch (error) {
		handOff(transcriptId, "claim", error);
		return { resume: "claim" };
	}

	try {
		const source = await prepareSource(transcriptId, null);
		if (!source.ok) return { resume: "prepare", source };
	} catch (error) {
		handOff(transcriptId, "prepare", error);
		return { resume: "prepare", source: null };
	}

	let extracted: ExtractedAudio;
	try {
		const audio = await extractAudio(transcriptId);
		if (!audio.ok) return { resume: "extract", audio };
		extracted = audio;
	} catch (error) {
		handOff(transcriptId, "extract", error);
		return { resume: "extract", audio: null };
	}

	if (
		extracted.durationSeconds > FAST_PATH_MAX_AUDIO_SECONDS ||
		Date.now() - startedAt > FAST_PATH_TRANSCRIBE_BEFORE_MS
	) {
		return { resume: "transcribe" };
	}

	let transcription: TranscriptionSummary | StepFailure;
	try {
		transcription = await transcribeAudio(transcriptId, extracted.audio);
	} catch (error) {
		handOff(transcriptId, "transcribe", error);
		return { resume: "transcribe" };
	}
	if (!transcription.ok) return { resume: "settle", transcription };

	try {
		return {
			resume: "done",
			transcription,
			settlement: await settleSummary(transcriptId, transcription),
		};
	} catch (error) {
		handOff(transcriptId, "settle", error);
		return { resume: "settle", transcription };
	}
}

async function claimTranscript(
	transcriptId: string,
	runId: string,
): Promise<boolean> {
	"use step";

	return claimTranscriptRun(transcriptId, runId);
}

async function spoolToFile(
	path: string,
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
) {
	await pipeline(
		Readable.fromWeb(
			limitStreamBytes(body, maxBytes) as unknown as Parameters<
				typeof Readable.fromWeb
			>[0],
		),
		createWriteStream(path),
	);
	const { size } = await fs.stat(path);
	return size;
}

async function holdForSource(
	transcriptId: string,
	known: KnownSource,
): Promise<StepFailure | HoldWait | null> {
	const hold = await holdTranscriptCredits({
		transcriptId,
		microCredits: transcriptHoldForSourceBytes(known.bytes),
	});
	return hold.state === "held" ? null : notHeld(hold, known);
}

async function prepareVideoSource(transcript: {
	id: string;
	appId: string;
	videoId: string | null;
}): Promise<{ ok: true } | StepFailure | HoldWait> {
	const video = transcript.videoId
		? await findVideoForTranscript(transcript.appId, transcript.videoId)
		: null;
	if (video?.state !== "ok") {
		return failure("source_missing", FAILURE_MESSAGES.video_missing);
	}
	const bytes = await developerObjectSize(video.sourceKey);
	if (bytes === null || bytes === 0) {
		return failure("source_missing", FAILURE_MESSAGES.video_missing);
	}
	const hold = await holdTranscriptCredits({
		transcriptId: transcript.id,
		microCredits:
			video.durationSeconds === null
				? transcriptHoldForSourceBytes(bytes)
				: transcriptHoldForAudioSeconds(video.durationSeconds),
	});
	if (hold.state !== "held") return notHeld(hold, null);
	await db()
		.update(developerTranscripts)
		.set({ sourceBytes: bytes, s3Key: video.sourceKey })
		.where(eq(developerTranscripts.id, transcript.id));
	return { ok: true };
}

async function prepareTranscriptSource(
	transcriptId: string,
	known: KnownSource | null,
): Promise<{ ok: true } | StepFailure | HoldWait> {
	"use step";

	return prepareSource(transcriptId, known);
}

async function prepareSource(
	transcriptId: string,
	known: KnownSource | null,
): Promise<{ ok: true } | StepFailure | HoldWait> {
	const transcript = await loadTranscript(transcriptId);
	if (!transcript) {
		return failure("source_missing", FAILURE_MESSAGES.source_missing);
	}
	if (transcript.sourceType === "video") return prepareVideoSource(transcript);
	const keys = transcriptObjectKeys(transcript.appId, transcript.id);
	const existingSize = await developerObjectSize(keys.source);

	if (transcript.sourceType === "upload") {
		if (existingSize === null || existingSize === 0) {
			return failure("source_missing", FAILURE_MESSAGES.source_missing);
		}
		if (existingSize > TRANSCRIPT_MAX_UPLOAD_BYTES) {
			return failure("source_too_large", FAILURE_MESSAGES.source_too_large);
		}
		return (
			(await holdForSource(transcript.id, { bytes: existingSize })) ?? {
				ok: true,
			}
		);
	}

	if (existingSize !== null && existingSize > 0) {
		return (
			(await holdForSource(transcript.id, { bytes: existingSize })) ?? {
				ok: true,
			}
		);
	}
	if (!transcript.sourceUrl) {
		return failure("source_missing", FAILURE_MESSAGES.source_missing);
	}
	if (known) {
		const refused = await holdForSource(transcript.id, known);
		if (refused) return refused;
	}

	const download = new AbortController();
	const timer = setTimeout(
		() => download.abort(),
		TRANSCRIPT_URL_DOWNLOAD_TIMEOUT_MS,
	);
	const spoolPath = join(tmpdir(), `transcript-source-${randomUUID()}`);
	const stop = (result: StepFailure | HoldWait) => {
		download.abort();
		return result;
	};
	try {
		let spooled: { bytes: number; contentType: string } | null = null;
		let sourceBytes = 0;
		try {
			const { response, contentLength } = await fetchPublicMedia(
				transcript.sourceUrl,
				{ maxBytes: TRANSCRIPT_MAX_URL_BYTES, signal: download.signal },
			);
			if (!response.body) {
				return stop(
					failure("source_unreachable", FAILURE_MESSAGES.source_unreachable),
				);
			}
			const declared =
				contentLength !== null && contentLength > 0 ? contentLength : null;
			const refused = await holdForSource(transcript.id, { bytes: declared });
			if (refused) {
				await response.body.cancel().catch(() => {});
				return stop(refused);
			}
			const contentType =
				response.headers.get("content-type") ?? "application/octet-stream";
			if (declared !== null && declared > TRANSCRIPT_MAX_SPOOLED_URL_BYTES) {
				await putDeveloperObjectStream(
					keys.source,
					limitStreamBytes(response.body, declared),
					declared,
					contentType,
				);
				sourceBytes = declared;
			} else {
				const bytes = await spoolToFile(
					spoolPath,
					response.body,
					declared ?? TRANSCRIPT_MAX_SPOOLED_URL_BYTES,
				);
				if (bytes === 0 || (declared !== null && bytes < declared)) {
					return stop(
						failure(
							"source_unreachable",
							bytes === 0
								? FAILURE_MESSAGES.source_unreachable
								: FAILURE_MESSAGES.source_incomplete,
						),
					);
				}
				spooled = { bytes, contentType };
				sourceBytes = bytes;
			}
		} catch (error) {
			const timedOut = download.signal.aborted;
			download.abort();
			await deleteDeveloperObjects([keys.source]);
			if (error instanceof PublicMediaFetchError) {
				if (error.problem === "too_large") {
					return failure("source_too_large", FAILURE_MESSAGES.source_too_large);
				}
				if (
					error.problem === "bad_status" ||
					error.problem === "too_many_redirects"
				) {
					return failure("source_unreachable", error.message);
				}
				return failure("source_blocked", FAILURE_MESSAGES.source_blocked);
			}
			const message = error instanceof Error ? error.message : String(error);
			console.error(
				`[developer-transcribe] Source download failed for ${transcript.id}: ${message}`,
			);
			if (timedOut) {
				return failure(
					"source_unreachable",
					`The file at the URL did not finish downloading within ${downloadLimit()}`,
				);
			}
			if (/private address/i.test(message)) {
				return failure("source_blocked", FAILURE_MESSAGES.source_blocked);
			}
			return failure("source_unreachable", FAILURE_MESSAGES.source_unreachable);
		}

		if (spooled) {
			await putDeveloperObjectFile(
				keys.source,
				spoolPath,
				spooled.bytes,
				spooled.contentType,
			);
		}
		await db()
			.update(developerTranscripts)
			.set({ sourceBytes })
			.where(eq(developerTranscripts.id, transcript.id));
		return { ok: true };
	} finally {
		clearTimeout(timer);
		await fs.unlink(spoolPath).catch(() => {});
	}
}

async function raiseTranscriptHold(
	transcriptId: string,
	reportedSeconds: number | null,
): Promise<{ ok: true } | StepFailure | HoldWait> {
	"use step";

	const hold = await holdTranscriptCredits({
		transcriptId,
		microCredits: transcriptHoldForAudioSeconds(reportedSeconds),
		releaseWhileWaiting: true,
	});
	return hold.state === "held" ? { ok: true } : notHeld(hold, null);
}

async function extractTranscriptAudio(
	transcriptId: string,
): Promise<{ ok: true } | StepFailure | HoldRaise> {
	"use step";

	const extracted = await extractAudio(transcriptId);
	return extracted.ok ? { ok: true } : extracted;
}

type ExtractedAudio = {
	ok: true;
	audio: Buffer | null;
	durationSeconds: number;
};

async function extractAudio(
	transcriptId: string,
): Promise<ExtractedAudio | StepFailure | HoldRaise> {
	const transcript = await loadTranscript(transcriptId);
	if (!transcript) {
		return failure("source_missing", FAILURE_MESSAGES.source_missing);
	}
	const heldSeconds = transcriptHoldCoversSeconds(
		Number(transcript.reservedMicroCredits) || 0,
	);
	if (heldSeconds <= 0) {
		return failure("insufficient_credits", INSUFFICIENT_CREDITS_MESSAGE);
	}
	const keys = transcriptObjectKeys(transcript.appId, transcript.id);
	if (
		transcript.durationSeconds !== null &&
		((await developerObjectSize(keys.audio)) ?? 0) > 0
	) {
		return {
			ok: true,
			audio: null,
			durationSeconds: transcript.durationSeconds,
		};
	}
	if (transcript.sourceType === "video" && !transcript.s3Key) {
		return failure("source_missing", FAILURE_MESSAGES.video_missing);
	}
	const sourceUrl = await developerObjectUrl(
		transcript.sourceType === "video" && transcript.s3Key
			? transcript.s3Key
			: keys.source,
	);
	if (!(await urlIsSelfContainedMedia(sourceUrl))) {
		return failure("unsupported_format", FAILURE_MESSAGES.unsupported_format);
	}
	const extracted = await extractTranscriptAudioBytes(sourceUrl, heldSeconds);
	if (extracted.state === "too_long") {
		return failure("duration_too_long", FAILURE_MESSAGES.duration_too_long);
	}
	if (extracted.state === "over_limit") {
		return {
			ok: false,
			raise: true,
			reportedSeconds: extracted.reportedSeconds,
		};
	}
	if (extracted.state === "no_audio" || extracted.audio.length === 0) {
		return failure("no_audio_track", FAILURE_MESSAGES.no_audio_track);
	}
	const { audio } = extracted;

	const durationSeconds =
		measureMp3DurationSeconds(audio) ??
		(audio.length * 8) / TRANSCRIPT_AUDIO_BITS_PER_SECOND;

	if (durationSeconds > TRANSCRIPT_AUDIO_MAX_SECONDS) {
		return failure("duration_too_long", FAILURE_MESSAGES.duration_too_long);
	}
	if (durationSeconds > heldSeconds) {
		return { ok: false, raise: true, reportedSeconds: null };
	}

	await putDeveloperObject(keys.audio, audio, "audio/mpeg");

	const reservation = await reserveTranscriptCredits({
		transcriptId: transcript.id,
		durationSeconds,
	});
	if (reservation.state === "insufficient_credits") {
		return failure("insufficient_credits", INSUFFICIENT_CREDITS_MESSAGE);
	}
	if (reservation.state === "skipped") {
		return failure("source_missing", FAILURE_MESSAGES.source_missing);
	}
	return { ok: true, audio, durationSeconds };
}

type TranscriptionSummary = {
	ok: true;
	durationSeconds: number;
	language: string | null;
	wordCount: number;
};

async function transcribeTranscriptAudio(
	transcriptId: string,
): Promise<TranscriptionSummary | StepFailure> {
	"use step";

	return transcribeAudio(transcriptId, null);
}

async function readExtractedAudio(key: string) {
	const audioResponse = await fetchStorageUrl(await developerObjectUrl(key));
	if (!audioResponse.ok || !audioResponse.body) {
		throw new Error(`Extracted audio is not readable: ${audioResponse.status}`);
	}
	return readStreamBounded(audioResponse.body, TRANSCRIPT_AUDIO_MAX_BYTES);
}

async function transcribeAudio(
	transcriptId: string,
	extracted: Buffer | null,
): Promise<TranscriptionSummary | StepFailure> {
	const transcript = await loadTranscriptRow(transcriptId);
	if (!transcript) {
		return failure("source_missing", FAILURE_MESSAGES.source_missing);
	}
	const keys = transcriptObjectKeys(transcript.appId, transcript.id);

	const existing = await getDeveloperObjectText(keys.result);
	if (existing !== null) {
		const stored = JSON.parse(existing) as TranscriptResultObject;
		return {
			ok: true,
			durationSeconds: stored.durationSeconds,
			language: stored.language,
			wordCount: transcriptWordCount(stored),
		};
	}
	if (transcript.deletedAt) {
		return failure("source_missing", FAILURE_MESSAGES.deleted);
	}

	let audio: Buffer;
	try {
		audio = extracted ?? (await readExtractedAudio(keys.audio));
	} catch (error) {
		if (error instanceof StreamTooLargeError) {
			return failure("duration_too_long", FAILURE_MESSAGES.duration_too_long);
		}
		throw error;
	}

	if (!(await transcriptAwaitsSpeech(transcript.id))) {
		return failure("source_missing", FAILURE_MESSAGES.deleted);
	}
	const speech = await transcribeSpeech(
		audio,
		parseTranscriptLanguage(transcript.requestedLanguage) ?? "auto",
	);
	const spoken = speech.state === "ok" ? speech : null;

	const durationSeconds = measuredTranscriptDuration({
		extractedAudioSeconds: transcript.durationSeconds,
		serviceDurationSeconds: spoken?.durationSeconds,
		lastWordEndMs: spoken?.words.at(-1)?.end,
	});
	const result = buildTranscriptResult({
		text: spoken?.text,
		words: spoken?.words,
		language: spoken?.language,
		durationSeconds,
	});

	await putDeveloperObject(
		keys.result,
		JSON.stringify(result),
		"application/json",
	);

	return {
		ok: true,
		durationSeconds,
		language: result.language,
		wordCount: transcriptWordCount(result),
	};
}

async function settleTranscriptStep(
	transcriptId: string,
	summary: TranscriptionSummary,
): Promise<Settlement> {
	"use step";

	return settleSummary(transcriptId, summary);
}

type Settlement = "complete" | "insufficient_credits" | "skipped";

async function settleSummary(
	transcriptId: string,
	summary: TranscriptionSummary,
): Promise<Settlement> {
	const transcript = await loadTranscriptRow(transcriptId);
	if (!transcript) return "skipped";
	const keys = transcriptObjectKeys(transcript.appId, transcript.id);
	const stored = await getDeveloperObjectText(keys.result);
	if (stored === null && !transcript.deletedAt) {
		const latest = await loadTranscriptRow(transcriptId);
		if (!latest?.deletedAt) {
			throw new Error(`Transcript result is missing for ${transcript.id}`);
		}
	}
	const result =
		stored === null ? null : (JSON.parse(stored) as TranscriptResultObject);

	const settlement = await settleTranscript({
		transcriptId: transcript.id,
		durationSeconds: summary.durationSeconds,
		language: summary.language,
		text: result?.text ?? "",
		wordCount: summary.wordCount,
		resultKey: keys.result,
	});
	return settlement.state;
}

async function writeVideoCaptions(transcriptId: string): Promise<void> {
	"use step";

	const [row] = await db()
		.select({
			appId: developerTranscripts.appId,
			videoId: developerTranscripts.videoId,
			status: developerTranscripts.status,
			language: developerTranscripts.language,
			wordCount: developerTranscripts.wordCount,
		})
		.from(developerTranscripts)
		.where(eq(developerTranscripts.id, transcriptId))
		.limit(1);
	if (
		!row?.videoId ||
		row.status !== "complete" ||
		(row.wordCount ?? 0) === 0
	) {
		return;
	}
	await syncVideoCaptions({
		appId: row.appId,
		videoId: row.videoId,
		language: row.language,
	});
}

async function transcriptStorage(transcriptId: string) {
	const [row] = await db()
		.select({
			appId: developerTranscripts.appId,
			status: developerTranscripts.status,
			deletedAt: developerTranscripts.deletedAt,
		})
		.from(developerTranscripts)
		.where(eq(developerTranscripts.id, transcriptId))
		.limit(1);
	if (!row) return null;
	return {
		status: row.deletedAt ? "deleted" : row.status,
		keys: transcriptObjectKeys(row.appId, transcriptId),
	};
}

async function failTranscriptStep(
	transcriptId: string,
	runId: string,
	code: TranscriptErrorCode,
	message: string,
): Promise<void> {
	"use step";

	const { failed, appId } = await failTranscriptRun(
		transcriptId,
		runId,
		code,
		message,
	);
	if (!failed || !appId) return;
	const keys = transcriptObjectKeys(appId, transcriptId);
	await deleteDeveloperObjects([keys.source, keys.audio, keys.result]);
}

async function cleanupTranscriptObjects(
	transcriptId: string,
	includeResult: boolean,
): Promise<void> {
	"use step";

	const storage = await transcriptStorage(transcriptId);
	if (!storage) return;
	await deleteDeveloperObjects(
		includeResult || storage.status !== "complete"
			? [storage.keys.source, storage.keys.audio, storage.keys.result]
			: [storage.keys.source, storage.keys.audio],
	);
}
