import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@cap/database";
import { organizations, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import {
	type AiGenerationLanguage,
	parseAiGenerationLanguage,
	Video,
} from "@cap/web-domain";
import { AssemblyAI } from "assemblyai";
import { eq, sql } from "drizzle-orm";
import { Either, Option, Schema } from "effect";
import {
	ASSEMBLYAI_SUPPORTED_LANGUAGES,
	getAssemblyAITranscriptionOptions,
} from "@/lib/assemblyai";
import { extractAudioFromUrl } from "@/lib/audio-extract";
import {
	applyChunkToLiveTranscript,
	createEmptyLiveTranscript,
	getLiveTranscriptObjectKey,
	isNoSpokenAudioError,
	LIVE_TRANSCRIBE,
	LIVE_TRANSCRIPT_NO_SEGMENTS,
	type LiveTranscriptState,
	offsetChunkWords,
	parseLiveTranscript,
	planNextLiveChunk,
} from "@/lib/live-transcribe-core";
import { downloadConcatenatedSegments } from "@/lib/segments-audio-download";
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

type ChunkStepResult =
	| {
			outcome: "chunk";
			lastAudioSegmentIndex: number;
			transcribedDurationMs: number;
			languageCode: string | null;
	  }
	| { outcome: "chunk-failed"; failedAtIndex: number; reason: string }
	| { outcome: "waiting" }
	| { outcome: "done" }
	| { outcome: "no-audio" }
	| { outcome: "canonical-done" }
	| { outcome: "gone" };

/**
 * Provisional live transcription for an instant-mode recording. Polls the
 * segment manifest the desktop app continuously re-uploads, transcribes new
 * audio in chunks, and maintains `transcription.live.json` for the share
 * page. Never touches `videos.transcriptionStatus` or any canonical
 * transcription artifact: the post-stop pipeline stays the single source of
 * truth and replaces this artifact entirely.
 */
export async function liveTranscribeWorkflow(
	payload: LiveTranscribeWorkflowPayload,
) {
	"use workflow";

	const { videoId, userId } = payload;

	const init = await initLiveTranscription(videoId, userId);
	if (!init.ok) {
		await finishLiveTranscription(videoId, userId, "stopped");
		return {
			success: true,
			message: `Live transcription skipped: ${init.reason}`,
		};
	}

	let lastIndex = init.lastAudioSegmentIndex;
	let transcribedMs = init.transcribedDurationMs;
	let languageCode = init.languageCode;
	let chunkCount = 0;
	let idleSteps = 0;
	let failuresAtIndex = 0;
	let outcome = "chunk-limit";

	try {
		while (chunkCount < LIVE_TRANSCRIBE.MAX_CHUNKS) {
			if (transcribedMs >= LIVE_TRANSCRIBE.MAX_TRANSCRIBED_SECONDS * 1000) {
				outcome = "budget-exhausted";
				break;
			}

			const targetSeconds =
				chunkCount < LIVE_TRANSCRIBE.GROW_AFTER_CHUNKS
					? LIVE_TRANSCRIBE.INITIAL_CHUNK_SECONDS
					: LIVE_TRANSCRIBE.MAX_CHUNK_SECONDS;

			const result = await processNextLiveChunk({
				videoId,
				userId,
				lastProcessedIndex: lastIndex,
				targetSeconds,
				language: languageCode ?? init.orgLanguage,
				// After repeated failures the chunk is skipped: advance past it and
				// leave a gap for the canonical transcription to fill.
				skipPastFailedChunk:
					failuresAtIndex >= LIVE_TRANSCRIBE.MAX_CHUNK_ATTEMPTS,
			});

			if (result.outcome === "chunk") {
				lastIndex = result.lastAudioSegmentIndex;
				transcribedMs = result.transcribedDurationMs;
				languageCode = languageCode ?? result.languageCode;
				chunkCount++;
				idleSteps = 0;
				failuresAtIndex = 0;
				continue;
			}

			if (result.outcome === "chunk-failed") {
				failuresAtIndex++;
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
			break;
		}
	} catch (error) {
		// A step exhausted its retries; make sure the artifact and metadata
		// never advertise a live transcription that is no longer running.
		await finishLiveTranscription(videoId, userId, "stopped");
		throw error;
	}

	await finishLiveTranscription(
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

async function processNextLiveChunk(options: {
	videoId: string;
	userId: string;
	lastProcessedIndex: number;
	targetSeconds: number;
	language: string;
	skipPastFailedChunk: boolean;
}): Promise<ChunkStepResult> {
	"use step";

	const { videoId, userId, lastProcessedIndex, targetSeconds } = options;

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

	// Poll inside the step (same pattern as the mux-completion wait) so idle
	// time costs one held invocation, not hundreds of queued step dispatches.
	const pollDeadline = Date.now() + LIVE_TRANSCRIBE.MAX_POLL_MS_PER_STEP;
	let decision: ReturnType<typeof planNextLiveChunk> | null = null;

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
				});
				if (next.action !== "wait") {
					decision = next;
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
			...decision.entries.map((entry) =>
				bucket
					.getInternalSignedObjectUrl(segSource.getAudioSegmentKey(entry.index))
					.pipe(runWorkflowPromise),
			),
		]);

		const concatPath = join(tmpdir(), `live-chunk-${randomUUID()}.mp4`);
		let audioBuffer: Buffer;
		try {
			await downloadConcatenatedSegments(segmentUrls, concatPath);
			const extracted = await extractAudioFromUrl(concatPath);
			try {
				audioBuffer = await fs.readFile(extracted.filePath);
			} finally {
				await extracted.cleanup();
			}
		} finally {
			await fs.unlink(concatPath).catch(() => {});
		}

		const client = new AssemblyAI({
			apiKey: serverEnv().ASSEMBLY_API_KEY as string,
		});
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

		const words = noSpokenAudio
			? []
			: offsetChunkWords(
					transcript.words,
					decision.startMs,
					decision.durationMs,
				);

		const artifactKey = getLiveTranscriptObjectKey(video.ownerId, videoId);
		const existing = await bucket
			.getObject(artifactKey)
			.pipe(runWorkflowPromise)
			.catch(() => Option.none<string>());
		const artifact =
			(Option.isSome(existing) ? parseLiveTranscript(existing.value) : null) ??
			createEmptyLiveTranscript(new Date().toISOString());

		const updated = applyChunkToLiveTranscript(artifact, {
			startMs: decision.startMs,
			durationMs: decision.durationMs,
			lastAudioSegmentIndex: chunkEndIndex,
			words,
			languageCode:
				typeof transcript.language_code === "string"
					? transcript.language_code
					: null,
			nowIso: new Date().toISOString(),
		});

		// Polling + the AssemblyAI round trip can take minutes; re-check that the
		// canonical pipeline didn't complete meanwhile, or this write would
		// re-create the artifact it just deleted (an orphan billed forever).
		const [current] = await db()
			.select({ transcriptionStatus: videos.transcriptionStatus })
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId));
		if (
			current?.transcriptionStatus === "COMPLETE" ||
			current?.transcriptionStatus === "SKIPPED" ||
			current?.transcriptionStatus === "NO_AUDIO"
		) {
			return { outcome: "canonical-done" };
		}

		const body = JSON.stringify(updated);
		await bucket
			.putObject(artifactKey, body, { contentType: "application/json" })
			.pipe(runWorkflowPromise);

		console.log(
			`[liveTranscribe] ${videoId} chunk ${lastProcessedIndex + 1}..${chunkEndIndex} (${decision.durationMs}ms, ${words.length} words)`,
		);

		return {
			outcome: "chunk",
			lastAudioSegmentIndex: chunkEndIndex,
			transcribedDurationMs: updated.transcribedDurationMs,
			languageCode: updated.languageCode,
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

async function finishLiveTranscription(
	videoId: string,
	userId: string,
	state: LiveTranscriptState,
): Promise<void> {
	"use step";

	try {
		await db()
			.update(videos)
			.set({
				metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.liveTranscript.status', ${state}, '$.liveTranscript.updatedAt', ${new Date().toISOString()})`,
				updatedAt: sql`${videos.updatedAt}`,
			})
			.where(eq(videos.id, videoId as Video.VideoId));
	} catch (error) {
		console.warn(
			`[liveTranscribe] Failed to update metadata for ${videoId}`,
			error,
		);
	}

	try {
		const [video] = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId));
		if (!video || video.ownerId !== userId) return;

		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(video),
		).pipe(runWorkflowPromise);
		const artifactKey = getLiveTranscriptObjectKey(video.ownerId, videoId);
		const existing = await bucket
			.getObject(artifactKey)
			.pipe(runWorkflowPromise)
			.catch(() => Option.none<string>());
		if (Option.isNone(existing)) return;

		const artifact = parseLiveTranscript(existing.value);
		if (!artifact || artifact.state === state) return;

		await bucket
			.putObject(
				artifactKey,
				JSON.stringify({
					...artifact,
					state,
					updatedAt: new Date().toISOString(),
				}),
				{ contentType: "application/json" },
			)
			.pipe(runWorkflowPromise);
	} catch (error) {
		console.warn(
			`[liveTranscribe] Failed to finalize artifact for ${videoId}`,
			error,
		);
	}
}
