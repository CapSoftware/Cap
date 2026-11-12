import { randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { db } from "@cap/database";
import { developerTranscripts } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { extractAudioFromUrl } from "@/lib/audio-extract";
import {
	INSUFFICIENT_CREDITS_MESSAGE,
	reserveTranscriptCredits,
	settleTranscript,
} from "@/lib/developer-transcript-billing";
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
	TRANSCRIPT_MAX_DURATION_SECONDS,
	TRANSCRIPT_MAX_SPOOLED_URL_BYTES,
	TRANSCRIPT_MAX_UPLOAD_BYTES,
	TRANSCRIPT_MAX_URL_BYTES,
	type TranscriptErrorCode,
	type TranscriptResultObject,
	transcriptObjectKeys,
} from "@/lib/developer-transcripts";
import {
	checkHasAudioTrackViaMediaServer,
	convertAudioToMp3ViaMediaServer,
	isMediaServerConfigured,
} from "@/lib/media-client";
import {
	isSelfContainedMedia,
	MEDIA_CONTAINER_SNIFF_BYTES,
} from "@/lib/media-container";
import { measureMp3DurationSeconds } from "@/lib/mp3-duration";
import {
	fetchPublicMedia,
	limitStreamBytes,
	PublicMediaFetchError,
} from "@/lib/public-media-fetch";
import { fetchStorageUrl } from "@/lib/storage-fetch";

const URL_DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;
const EXTRACTED_AUDIO_BITS_PER_SECOND = 128_000;
const DURATION_LIMIT_SLACK_SECONDS = 1;

type StepFailure = { ok: false; code: TranscriptErrorCode; message: string };

const failure = (code: TranscriptErrorCode, message: string): StepFailure => ({
	ok: false,
	code,
	message,
});

const FAILURE_MESSAGES = {
	source_missing: "The source file was not found",
	source_too_large: "The source file is larger than the 2 GB limit",
	source_unreachable: "The file at the URL could not be downloaded",
	source_blocked: "The URL does not point to a public address",
	no_audio_track: "The file has no audio track",
	unsupported_format: "The file is not a supported audio or video format",
	no_speech: "No speech was found in the audio",
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

		const source = await prepareTranscriptSource(transcriptId);
		if (!source.ok) {
			await failTranscriptStep(
				transcriptId,
				runId,
				source.code,
				source.message,
			);
			return { success: false, message: source.message };
		}

		const audio = await extractTranscriptAudio(transcriptId);
		if (!audio.ok) {
			await failTranscriptStep(transcriptId, runId, audio.code, audio.message);
			return { success: false, message: audio.message };
		}

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

async function spoolToStorage(
	key: string,
	body: ReadableStream<Uint8Array>,
	contentType: string,
) {
	const path = join(tmpdir(), `transcript-source-${randomUUID()}`);
	try {
		await pipeline(
			Readable.fromWeb(
				limitStreamBytes(
					body,
					TRANSCRIPT_MAX_SPOOLED_URL_BYTES,
				) as unknown as Parameters<typeof Readable.fromWeb>[0],
			),
			createWriteStream(path),
		);
		const { size } = await fs.stat(path);
		if (size > 0) await putDeveloperObjectFile(key, path, size, contentType);
		return size;
	} finally {
		await fs.unlink(path).catch(() => {});
	}
}

async function prepareTranscriptSource(
	transcriptId: string,
): Promise<{ ok: true } | StepFailure> {
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
		return { ok: true };
	}

	if (existingSize !== null && existingSize > 0) return { ok: true };
	if (!transcript.sourceUrl) {
		return failure("source_missing", FAILURE_MESSAGES.source_missing);
	}

	try {
		const { response, contentLength } = await fetchPublicMedia(
			transcript.sourceUrl,
			{
				maxBytes: TRANSCRIPT_MAX_URL_BYTES,
				signal: AbortSignal.timeout(URL_DOWNLOAD_TIMEOUT_MS),
			},
		);
		if (!response.body) {
			return failure("source_unreachable", FAILURE_MESSAGES.source_unreachable);
		}
		const contentType =
			response.headers.get("content-type") ?? "application/octet-stream";
		const sourceBytes =
			contentLength !== null && contentLength > 0
				? await putDeveloperObjectStream(
						keys.source,
						limitStreamBytes(response.body, contentLength),
						contentLength,
						contentType,
					).then(() => contentLength)
				: await spoolToStorage(keys.source, response.body, contentType);

		if (sourceBytes === 0) {
			return failure("source_unreachable", FAILURE_MESSAGES.source_unreachable);
		}

		await db()
			.update(developerTranscripts)
			.set({ sourceBytes })
			.where(eq(developerTranscripts.id, transcript.id));
		return { ok: true };
	} catch (error) {
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
		if (/private address/i.test(message)) {
			return failure("source_blocked", FAILURE_MESSAGES.source_blocked);
		}
		return failure("source_unreachable", FAILURE_MESSAGES.source_unreachable);
	}
}

const SNIFF_TIMEOUT_MS = 30_000;

async function sourceIsSelfContainedMedia(sourceUrl: string) {
	const response = await fetch(sourceUrl, {
		headers: { Range: `bytes=0-${MEDIA_CONTAINER_SNIFF_BYTES - 1}` },
		signal: AbortSignal.timeout(SNIFF_TIMEOUT_MS),
	});
	if (!response.ok || !response.body) {
		throw new Error(`Could not read the stored source (${response.status})`);
	}
	const reader = response.body.getReader();
	const head = new Uint8Array(MEDIA_CONTAINER_SNIFF_BYTES);
	let filled = 0;
	try {
		while (filled < head.length) {
			const { done, value } = await reader.read();
			if (done) break;
			const take = Math.min(value.length, head.length - filled);
			head.set(value.subarray(0, take), filled);
			filled += take;
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return isSelfContainedMedia(head.subarray(0, filled));
}

const LOCAL_NO_AUDIO_PATTERN =
	/does not contain any stream|matches no streams/i;

async function extractAudioBytes(sourceUrl: string): Promise<Buffer | null> {
	if (isMediaServerConfigured()) {
		try {
			return await convertAudioToMp3ViaMediaServer(sourceUrl);
		} catch (error) {
			const hasAudio = await checkHasAudioTrackViaMediaServer(sourceUrl).catch(
				() => null,
			);
			if (hasAudio === false) return null;
			throw error;
		}
	}

	try {
		const extracted = await extractAudioFromUrl(sourceUrl);
		try {
			return await fs.readFile(extracted.filePath);
		} finally {
			await extracted.cleanup();
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (LOCAL_NO_AUDIO_PATTERN.test(message)) return null;
		throw error;
	}
}

async function extractTranscriptAudio(
	transcriptId: string,
): Promise<{ ok: true } | StepFailure> {
	"use step";

	const transcript = await loadTranscript(transcriptId);
	if (!transcript) {
		return failure("source_missing", FAILURE_MESSAGES.source_missing);
	}
	const keys = transcriptObjectKeys(transcript.appId, transcript.id);
	const sourceUrl = await developerObjectUrl(keys.source);
	if (!(await sourceIsSelfContainedMedia(sourceUrl))) {
		return failure("unsupported_format", FAILURE_MESSAGES.unsupported_format);
	}
	const audio = await extractAudioBytes(sourceUrl);

	if (audio === null || audio.length === 0) {
		return failure("no_audio_track", FAILURE_MESSAGES.no_audio_track);
	}

	const durationSeconds =
		measureMp3DurationSeconds(audio) ??
		(audio.length * 8) / EXTRACTED_AUDIO_BITS_PER_SECOND;

	if (
		durationSeconds >
		TRANSCRIPT_MAX_DURATION_SECONDS + DURATION_LIMIT_SLACK_SECONDS
	) {
		return failure("duration_too_long", FAILURE_MESSAGES.duration_too_long);
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
			wordCount: stored.words.length,
		};
	}

	const audioResponse = await fetchStorageUrl(
		await developerObjectUrl(keys.audio),
	);
	if (!audioResponse.ok) {
		throw new Error(`Extracted audio is not readable: ${audioResponse.status}`);
	}
	const audio = Buffer.from(await audioResponse.arrayBuffer());

	const speech = await transcribeSpeech(
		audio,
		parseTranscriptLanguage(transcript.requestedLanguage) ?? "auto",
	);
	if (speech.state === "no_speech") {
		return failure("no_speech", FAILURE_MESSAGES.no_speech);
	}

	const durationSeconds = measuredTranscriptDuration({
		extractedAudioSeconds: transcript.durationSeconds,
		serviceDurationSeconds: speech.durationSeconds,
		lastWordEndMs: speech.words.at(-1)?.end,
	});
	const result = buildTranscriptResult({
		text: speech.text,
		words: speech.words,
		language: speech.language,
		durationSeconds,
	});
	if (result.text.length === 0) {
		return failure("no_speech", FAILURE_MESSAGES.no_speech);
	}

	await putDeveloperObject(
		keys.result,
		JSON.stringify(result),
		"application/json",
	);

	return {
		ok: true,
		durationSeconds,
		language: result.language,
		wordCount: result.words.length,
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
