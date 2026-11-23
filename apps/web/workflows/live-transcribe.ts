import { db } from "@cap/database";
import { organizations, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import {
	type AiGenerationLanguage,
	parseAiGenerationLanguage,
	Video,
} from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Either, Option, Schema } from "effect";
import {
	ASSEMBLYAI_SUPPORTED_LANGUAGES,
	createAssemblyAIClient,
	getAssemblyAITranscriptionOptions,
} from "@/lib/assemblyai";
import {
	getLiveTranscriptObjectKey,
	isNoSpokenAudioError,
	LIVE_TRANSCRIBE,
	LIVE_TRANSCRIPT_NO_SEGMENTS,
	type LiveChunkBatchResult,
	type LiveChunkCursor,
	type LiveChunkResult,
	type LiveTranscriptState,
	parseLiveTranscript,
	planNextLiveChunk,
	runLiveChunkBatch,
} from "@/lib/live-transcribe-core";
import {
	finishLiveTranscription,
	liveContextSeconds,
	promoteLiveTranscript,
	writeLiveChunk,
	writeLiveChunkGap,
} from "@/lib/live-transcribe-runner";
import { downloadConcatenatedSegmentsToBuffer } from "@/lib/segments-audio-download";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

interface LiveTranscribeWorkflowPayload {
	videoId: string;
	userId: string;
}

type InitResult =
	| { ok: false; reason: string }
	| {
			ok: true;
			lastAudioSegmentIndex: number;
			transcribedDurationMs: number;
			languageCode: string | null;
			orgLanguage: AiGenerationLanguage;
	  };

/**
 * Live transcription for an instant-mode recording. Polls the segment
 * manifest the desktop app continuously re-uploads, transcribes new audio in
 * chunks, and maintains `transcription.live.json` for the share page.
 *
 * While recording, this never touches `videos.transcriptionStatus` or any
 * canonical artifact. At completion, IF the chunks cover the whole recording
 * gap-free, promoteLiveTranscript claims the canonical slot atomically and
 * writes the canonical transcript from the accumulated words — skipping the
 * duplicate full transcription pass. Anything less than perfect coverage
 * falls back to the normal full-pass pipeline unchanged.
 */
export async function liveTranscribeWorkflow(
	payload: LiveTranscribeWorkflowPayload,
) {
	"use workflow";

	const { videoId, userId } = payload;

	const init = await initLiveTranscription(videoId, userId);
	if (!init.ok) {
		await finishLiveTranscriptionStep(videoId, userId, "stopped");
		return {
			success: true,
			message: `Live transcription skipped: ${init.reason}`,
		};
	}

	let cursor: LiveChunkCursor = {
		lastAudioSegmentIndex: init.lastAudioSegmentIndex,
		transcribedDurationMs: init.transcribedDurationMs,
		languageCode: init.languageCode,
		chunkCount: 0,
	};
	let idleSteps = 0;
	let failuresAtIndex = 0;
	let outcome = "chunk-limit";
	let promotion: LivePromotionResult | undefined;

	try {
		while (cursor.chunkCount < LIVE_TRANSCRIBE.MAX_CHUNKS) {
			if (
				cursor.transcribedDurationMs >=
				LIVE_TRANSCRIBE.MAX_TRANSCRIBED_SECONDS * 1000
			) {
				outcome = "budget-exhausted";
				break;
			}

			const batch = await processLiveChunks({
				videoId,
				userId,
				cursor,
				orgLanguage: init.orgLanguage,
				// After repeated failures the chunk is skipped: advance past it and
				// leave a gap for the canonical transcription to fill.
				skipPastFailedChunk:
					failuresAtIndex >= LIVE_TRANSCRIBE.MAX_CHUNK_ATTEMPTS,
				// A retry drops the context in case the earlier audio is what fails.
				withContext: failuresAtIndex === 0,
			});

			if (batch.chunks > 0) {
				cursor = {
					...batch.cursor,
					languageCode: cursor.languageCode ?? batch.cursor.languageCode,
				};
				idleSteps = 0;
				failuresAtIndex = 0;
			}

			const result = batch.last;
			if (result.outcome === "progress") continue;

			if (result.outcome === "chunk-failed") {
				failuresAtIndex++;
				// Skip attempts also count here; if even recording the gap keeps
				// failing, storage is degraded — stop rather than spin.
				if (failuresAtIndex >= LIVE_TRANSCRIBE.MAX_CHUNK_ATTEMPTS * 3) {
					outcome = "chunk-abandoned";
					break;
				}
				continue;
			}

			if (result.outcome === "waiting") {
				idleSteps++;
				if (idleSteps >= LIVE_TRANSCRIBE.MAX_IDLE_STEPS) {
					outcome = "stalled";
					break;
				}
				continue;
			}

			outcome = result.outcome;
			promotion = batch.promotion;
			break;
		}
	} catch (error) {
		// A step exhausted its retries; make sure the artifact and metadata
		// never advertise a live transcription that is no longer running.
		await finishLiveTranscriptionStep(videoId, userId, "stopped");
		throw error;
	}

	if (outcome === "done") {
		// Full gap-free coverage: promote the live transcript to canonical and
		// skip the duplicate full transcription pass entirely. On any failure
		// the full-pass fallback is queued so transcription still lands fast.
		promotion ??= await promoteLiveTranscriptStep(videoId, userId);
		if (promotion.promoted) {
			return {
				success: true,
				message: "Live transcription promoted to canonical",
			};
		}
		console.warn(
			`[liveTranscribe] Promotion declined for ${videoId}: ${promotion.reason}`,
		);
	}

	await finishLiveTranscriptionStep(
		videoId,
		userId,
		outcome === "done" ? "complete" : "stopped",
	);

	return { success: true, message: `Live transcription ${outcome}` };
}

async function initLiveTranscription(
	videoId: string,
	userId: string,
): Promise<InitResult> {
	"use step";

	if (!serverEnv().ASSEMBLY_API_KEY) {
		return { ok: false, reason: "missing ASSEMBLY_API_KEY" };
	}

	const [row] = await db()
		.select({ video: videos, orgSettings: organizations.settings })
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, videoId as Video.VideoId));

	if (!row?.video || row.video.ownerId !== userId) {
		return { ok: false, reason: "video not found" };
	}
	if (row.video.source.type !== "desktopSegments") {
		return { ok: false, reason: "not a segmented recording" };
	}
	if (
		row.video.settings?.disableTranscript ??
		row.orgSettings?.disableTranscript
	) {
		return { ok: false, reason: "transcription disabled" };
	}
	if (row.video.transcriptionStatus === "COMPLETE") {
		return { ok: false, reason: "canonical transcript already exists" };
	}

	// Resume from a previous run's artifact after a crash/redeploy so already
	// paid-for chunks are never re-transcribed.
	let lastAudioSegmentIndex = LIVE_TRANSCRIPT_NO_SEGMENTS;
	let transcribedDurationMs = 0;
	let languageCode: string | null = null;
	try {
		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(row.video),
		).pipe(runWorkflowPromise);
		const existing = await bucket
			.getObject(getLiveTranscriptObjectKey(row.video.ownerId, videoId))
			.pipe(runWorkflowPromise);
		const artifact = Option.isSome(existing)
			? parseLiveTranscript(existing.value)
			: null;
		if (artifact) {
			lastAudioSegmentIndex = artifact.lastAudioSegmentIndex;
			transcribedDurationMs = artifact.transcribedDurationMs;
			languageCode = artifact.languageCode;
		}
	} catch (error) {
		console.warn(
			`[liveTranscribe] Failed to read existing artifact for ${videoId}`,
			error,
		);
	}

	return {
		ok: true,
		lastAudioSegmentIndex,
		transcribedDurationMs,
		languageCode,
		orgLanguage: parseAiGenerationLanguage(
			row.orgSettings?.aiGenerationLanguage,
		),
	};
}

type LivePromotionResult = Awaited<ReturnType<typeof promoteLiveTranscript>>;

async function processLiveChunks(options: {
	videoId: string;
	userId: string;
	cursor: LiveChunkCursor;
	orgLanguage: AiGenerationLanguage;
	skipPastFailedChunk: boolean;
	withContext: boolean;
}): Promise<LiveChunkBatchResult & { promotion?: LivePromotionResult }> {
	"use step";

	const { videoId, userId, orgLanguage } = options;
	const batch = await runLiveChunkBatch({
		cursor: options.cursor,
		skipPastFailedChunk: options.skipPastFailedChunk,
		withContext: options.withContext,
		now: Date.now,
		processChunk: (chunk) =>
			transcribeNextLiveChunk({
				videoId,
				lastProcessedIndex: chunk.lastProcessedIndex,
				targetSeconds: chunk.targetSeconds,
				language: chunk.languageCode ?? orgLanguage,
				skipPastFailedChunk: chunk.skipPastFailedChunk,
				withContext: chunk.withContext,
				pollUntil: chunk.pollUntil,
				resumeFromArtifact:
					chunk.lastProcessedIndex === options.cursor.lastAudioSegmentIndex,
			}),
		onError: (error) =>
			console.warn(
				`[liveTranscribe] Chunk batch for ${videoId} ended early`,
				error,
			),
	});
	if (batch.last.outcome !== "done") return batch;
	// Promote in the same invocation: a separate step would add a workflow
	// round trip between the last words landing and the final transcript.
	// promoteLiveTranscript never throws and claims the canonical slot
	// atomically, so a retried step only sees it declined.
	return { ...batch, promotion: await promoteLiveTranscript(videoId, userId) };
}

async function transcribeNextLiveChunk(options: {
	videoId: string;
	lastProcessedIndex: number;
	targetSeconds: number;
	language: string;
	skipPastFailedChunk: boolean;
	withContext: boolean;
	pollUntil: number;
	resumeFromArtifact: boolean;
}): Promise<LiveChunkResult> {
	const { videoId, lastProcessedIndex, targetSeconds } = options;
	const contextSeconds = options.withContext ? liveContextSeconds() : 0;

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	if (!video) return { outcome: "gone" };
	if (
		video.transcriptionStatus === "COMPLETE" ||
		video.transcriptionStatus === "SKIPPED" ||
		video.transcriptionStatus === "NO_AUDIO"
	) {
		// The canonical pipeline finished (or decided) while we were running;
		// everything from here on would be wasted spend.
		return { outcome: "canonical-done" };
	}
	if (video.settings?.disableTranscript) {
		return { outcome: "canonical-done" };
	}

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runWorkflowPromise);
	const segSource = new Video.SegmentsSource({
		videoId,
		ownerId: video.ownerId,
	});

	if (options.resumeFromArtifact) {
		// A retried step re-sends the cursor it started from, but the attempt
		// that failed may already have written later chunks. Re-applying an
		// older chunk drops the words after it while the stored cursor stays
		// ahead, so a storage error here must fail the step instead of reading
		// as "no transcript yet" and replaying.
		const existing = await bucket
			.getObject(getLiveTranscriptObjectKey(video.ownerId, videoId))
			.pipe(runWorkflowPromise);
		const artifact = Option.isSome(existing)
			? parseLiveTranscript(existing.value)
			: null;
		if (artifact && artifact.lastAudioSegmentIndex > lastProcessedIndex) {
			return {
				outcome: "chunk",
				lastAudioSegmentIndex: artifact.lastAudioSegmentIndex,
				transcribedDurationMs: artifact.transcribedDurationMs,
				languageCode: artifact.languageCode,
			};
		}
	}

	// Poll inside the step (same pattern as the mux-completion wait) so idle
	// time costs one held invocation, not hundreds of queued step dispatches.
	const pollDeadline = options.pollUntil;
	let decision: ReturnType<typeof planNextLiveChunk> | null = null;
	let decodedManifest: Video.SegmentManifestType | null = null;

	while (Date.now() < pollDeadline) {
		const manifestContent = await bucket
			.getObject(segSource.getManifestKey())
			.pipe(runWorkflowPromise)
			.catch(() => Option.none<string>());
		const manifestJson = Option.getOrNull(manifestContent);

		if (manifestJson) {
			let parsed: unknown = null;
			try {
				parsed = JSON.parse(manifestJson);
			} catch {}
			const decoded = parsed
				? Schema.decodeUnknownEither(Video.SegmentManifest)(parsed)
				: null;

			if (decoded && Either.isRight(decoded)) {
				const next = planNextLiveChunk({
					manifest: decoded.right,
					lastProcessedIndex,
					targetSeconds,
					contextSeconds,
					minSentSeconds: LIVE_TRANSCRIBE.MIN_SENT_SECONDS,
				});
				if (next.action !== "wait") {
					decision = next;
					decodedManifest = decoded.right;
					break;
				}
			}
		}

		await new Promise((resolve) =>
			setTimeout(resolve, LIVE_TRANSCRIBE.POLL_INTERVAL_MS),
		);
	}

	if (!decision) return { outcome: "waiting" };
	if (decision.action === "done") return { outcome: "done" };
	if (decision.action === "no-audio") return { outcome: "no-audio" };
	if (decision.action !== "chunk") return { outcome: "waiting" };

	const chunkEndIndex =
		decision.entries[decision.entries.length - 1]?.index ?? lastProcessedIndex;

	if (options.skipPastFailedChunk) {
		console.warn(
			`[liveTranscribe] Skipping poison chunk ${lastProcessedIndex + 1}..${chunkEndIndex} for ${videoId}`,
		);
		// The gap MUST be durably recorded before the cursor advances, or a
		// later promotion could ship a transcript that silently misses speech.
		try {
			const gap = await writeLiveChunkGap({
				bucket,
				ownerId: video.ownerId,
				videoId,
				lastAudioSegmentIndex: chunkEndIndex,
				endMs: decision.startMs + decision.durationMs,
			});
			if (gap.status !== "written") return { outcome: "canonical-done" };
		} catch (error) {
			return {
				outcome: "chunk-failed",
				failedAtIndex: lastProcessedIndex,
				reason: `failed to record chunk gap: ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
		return {
			outcome: "chunk",
			lastAudioSegmentIndex: chunkEndIndex,
			transcribedDurationMs: decision.startMs + decision.durationMs,
			languageCode: null,
		};
	}

	try {
		const segmentUrls = await Promise.all([
			bucket
				.getInternalSignedObjectUrl(segSource.getAudioInitKey())
				.pipe(runWorkflowPromise),
			...[...decision.context, ...decision.entries].map((entry) =>
				bucket
					.getInternalSignedObjectUrl(segSource.getAudioSegmentKey(entry.index))
					.pipe(runWorkflowPromise),
			),
		]);

		// init + fragments concatenate into a valid fragmented MP4 that
		// AssemblyAI ingests directly (verified: full files, mid-stream chunks
		// with chunk-relative timestamps, and real desktop uploads). No local
		// ffmpeg — the binary doesn't exist in the serverless runtime.
		const audioBuffer = await downloadConcatenatedSegmentsToBuffer(segmentUrls);

		const client = createAssemblyAIClient();
		const language = (
			ASSEMBLYAI_SUPPORTED_LANGUAGES as readonly string[]
		).includes(options.language)
			? (options.language as AiGenerationLanguage)
			: ("auto" as AiGenerationLanguage);
		const transcript = await client.transcripts.transcribe({
			audio: audioBuffer,
			...getAssemblyAITranscriptionOptions(language),
			disfluencies: true,
		});

		const noSpokenAudio = isNoSpokenAudioError(transcript);
		if (transcript.status === "error" && !noSpokenAudio) {
			throw new Error(transcript.error ?? "AssemblyAI chunk failed");
		}

		// Polling + the AssemblyAI round trip can take minutes, so the write
		// re-checks that the canonical pipeline didn't complete meanwhile.
		const write = await writeLiveChunk({
			bucket,
			ownerId: video.ownerId,
			videoId,
			chunk: {
				startMs: decision.startMs,
				durationMs: decision.durationMs,
				contextMs: decision.contextMs,
				lastAudioSegmentIndex: chunkEndIndex,
			},
			words: noSpokenAudio ? [] : transcript.words,
			languageCode:
				typeof transcript.language_code === "string"
					? transcript.language_code
					: null,
		});
		if (write.status !== "written") return { outcome: "canonical-done" };
		const updated = write.artifact;

		// If this chunk completed full coverage of a finished recording, tell
		// the workflow to promote right away instead of paying another poll
		// round-trip - this latency is the stop-to-final-transcript feel.
		const next = decodedManifest
			? planNextLiveChunk({
					manifest: decodedManifest,
					lastProcessedIndex: chunkEndIndex,
					targetSeconds,
				})
			: ({ action: "wait" } as const);

		console.log(
			`[liveTranscribe] ${videoId} chunk ${lastProcessedIndex + 1}..${chunkEndIndex} (${decision.durationMs}ms + ${decision.contextMs}ms context, ${updated.words.length} words total)`,
		);

		return {
			outcome: "chunk",
			lastAudioSegmentIndex: chunkEndIndex,
			transcribedDurationMs: updated.transcribedDurationMs,
			languageCode: updated.languageCode,
			recordingComplete: next.action === "done",
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.warn(
			`[liveTranscribe] Chunk ${lastProcessedIndex + 1}..${chunkEndIndex} failed for ${videoId}: ${reason}`,
		);
		return {
			outcome: "chunk-failed",
			failedAtIndex: lastProcessedIndex,
			reason,
		};
	}
}

async function promoteLiveTranscriptStep(videoId: string, userId: string) {
	"use step";
	return promoteLiveTranscript(videoId, userId);
}

async function finishLiveTranscriptionStep(
	videoId: string,
	userId: string,
	state: LiveTranscriptState,
) {
	"use step";
	await finishLiveTranscription(videoId, userId, state);
}
