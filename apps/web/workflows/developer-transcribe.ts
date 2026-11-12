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
		const claimed = await claimTranscript(transcriptId, runId);
		if (!claimed) {
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

		let source = await prepareTranscriptSource(transcriptId, null);
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

		let audio = await extractTranscriptAudio(transcriptId);
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

		const transcription = await transcribeTranscriptAudio(transcriptId);
		if (!transcription.ok) {
			await failTranscriptStep(
				transcriptId,
				runId,
				transcription.code,
				transcription.message,
			);
			return { success: false, message: transcription.message };
		}

		const settlement = await settleTranscriptStep(transcriptId, transcription);
		await cleanupTranscriptObjects(transcriptId, settlement !== "complete");
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
	const [row] = await db()
		.select({
			id: developerTranscripts.id,
			appId: developerTranscripts.appId,
			status: developerTranscripts.status,
			sourceType: developerTranscripts.sourceType,
			sourceUrl: developerTranscripts.sourceUrl,
			requestedLanguage: developerTranscripts.requestedLanguage,
			durationSeconds: developerTranscripts.durationSeconds,
			reservedMicroCredits: developerTranscripts.reservedMicroCredits,
			deletedAt: developerTranscripts.deletedAt,
		})
		.from(developerTranscripts)
		.where(eq(developerTranscripts.id, transcriptId))
		.limit(1);
	return row && !row.deletedAt ? row : null;
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

async function prepareTranscriptSource(
	transcriptId: string,
	known: KnownSource | null,
): Promise<{ ok: true } | StepFailure | HoldWait> {
	"use step";

	const transcript = await loadTranscript(transcriptId);
	if (!transcript) {
		return failure("source_missing", FAILURE_MESSAGES.source_missing);
	}
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
		return { ok: true };
	}
	const sourceUrl = await developerObjectUrl(keys.source);
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
	return { ok: true };
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

	const transcript = await loadTranscript(transcriptId);
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

	const audioResponse = await fetchStorageUrl(
		await developerObjectUrl(keys.audio),
	);
	if (!audioResponse.ok || !audioResponse.body) {
		throw new Error(`Extracted audio is not readable: ${audioResponse.status}`);
	}
	let audio: Buffer;
	try {
		audio = await readStreamBounded(
			audioResponse.body,
			TRANSCRIPT_AUDIO_MAX_BYTES,
		);
	} catch (error) {
		if (error instanceof StreamTooLargeError) {
			return failure("duration_too_long", FAILURE_MESSAGES.duration_too_long);
		}
		throw error;
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
): Promise<"complete" | "insufficient_credits" | "skipped"> {
	"use step";

	const transcript = await loadTranscript(transcriptId);
	if (!transcript) return "skipped";
	const keys = transcriptObjectKeys(transcript.appId, transcript.id);
	const stored = await getDeveloperObjectText(keys.result);
	if (stored === null) {
		throw new Error(`Transcript result is missing for ${transcript.id}`);
	}
	const result = JSON.parse(stored) as TranscriptResultObject;

	const settlement = await settleTranscript({
		transcriptId: transcript.id,
		durationSeconds: summary.durationSeconds,
		language: summary.language,
		text: result.text,
		wordCount: summary.wordCount,
		resultKey: keys.result,
	});
	return settlement.state;
}

async function transcriptStorage(transcriptId: string) {
	const [row] = await db()
		.select({
			appId: developerTranscripts.appId,
			status: developerTranscripts.status,
		})
		.from(developerTranscripts)
		.where(eq(developerTranscripts.id, transcriptId))
		.limit(1);
	if (!row) return null;
	return {
		status: row.status,
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
