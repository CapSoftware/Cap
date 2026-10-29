import { db } from "@cap/database";
import { users, videoEdits, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { type User, Video } from "@cap/web-domain";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";
import { type Effect, Either, Option, Schema } from "effect";
import { isAiGenerationEnabledForUser } from "@/lib/ai-generation-entitlement";
import { ASSEMBLYAI_SPEECH_MODELS } from "@/lib/assemblyai";
import {
	getEditTranscriptObjectKey,
	parseEditTranscript,
	serializeEditTranscript,
} from "@/lib/edit-transcript";
import { encryptEditTranscriptObject } from "@/lib/edit-transcript-storage";
import { startAiGeneration } from "@/lib/generate-ai";
import {
	applyChunkToLiveTranscript,
	canPromoteLiveTranscript,
	createEmptyLiveTranscript,
	getLiveTranscriptObjectKey,
	type LiveChunkWordInput,
	type LiveTranscriptArtifact,
	type LiveTranscriptState,
	liveTranscriptToEditTranscript,
	offsetChunkWords,
	parseLiveTranscript,
} from "@/lib/live-transcribe-core";
import { transcribeVideo } from "@/lib/transcribe";
import { decodeStorageVideo } from "@/lib/video-storage";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

/**
 * Storage and claim operations shared by the two live transcription runners:
 * the liveTranscribe workflow and the media server session that reports
 * through /api/webhooks/media-server/live-transcribe.
 */

export type LiveBucket = Effect.Effect.Success<
	ReturnType<typeof Storage.getAccessForVideo>
>[0];

const CANONICAL_DONE_STATUSES = new Set(["COMPLETE", "SKIPPED", "NO_AUDIO"]);

export function isCanonicalTranscriptDone(status: string | null | undefined) {
	return status !== null && status !== undefined
		? CANONICAL_DONE_STATUSES.has(status)
		: false;
}

/** Only the session named in the claim may write; a replaced runner's late
 * reports must not touch the artifact. */
export function liveSessionMatches(session: string): SQL {
	return sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.liveTranscript.session')) = ${session}`;
}

export async function readLiveTranscript(
	bucket: LiveBucket,
	ownerId: string,
	videoId: string,
): Promise<LiveTranscriptArtifact | null> {
	const existing = await bucket
		.getObject(getLiveTranscriptObjectKey(ownerId, videoId))
		.pipe(runWorkflowPromise)
		.catch(() => Option.none<string>());
	return Option.isSome(existing) ? parseLiveTranscript(existing.value) : null;
}

/**
 * Record that the audio up to `lastAudioSegmentIndex` was skipped. Must land
 * before the cursor moves past it, or a later promotion could ship a
 * transcript that silently misses speech. Throws when it can't be recorded.
 */
export async function writeLiveChunkGap(options: {
	bucket: LiveBucket;
	ownerId: string;
	videoId: string;
	lastAudioSegmentIndex: number;
	endMs: number;
	session?: string;
}): Promise<LiveTranscriptArtifact> {
	const { bucket, ownerId, videoId } = options;
	const artifact =
		(await readLiveTranscript(bucket, ownerId, videoId)) ??
		createEmptyLiveTranscript(new Date().toISOString());
	const updated: LiveTranscriptArtifact = {
		...artifact,
		hasGaps: true,
		lastAudioSegmentIndex: Math.max(
			artifact.lastAudioSegmentIndex,
			options.lastAudioSegmentIndex,
		),
		transcribedDurationMs: Math.max(
			artifact.transcribedDurationMs,
			options.endMs,
		),
		updatedAt: new Date().toISOString(),
	};
	await bucket
		.putObject(
			getLiveTranscriptObjectKey(ownerId, videoId),
			JSON.stringify(updated),
			{ contentType: "application/json" },
		)
		.pipe(runWorkflowPromise);
	await touchLiveClaim(videoId, options.session);
	return updated;
}

/**
 * Merge one transcribed chunk into `transcription.live.json`. Returns null
 * without writing when the canonical transcript finished meanwhile (the write
 * would re-create the artifact it just deleted, an orphan billed forever) or,
 * for a session runner, when the claim moved to another session.
 */
export async function writeLiveChunk(options: {
	bucket: LiveBucket;
	ownerId: string;
	videoId: string;
	chunk: {
		startMs: number;
		durationMs: number;
		contextMs: number;
		lastAudioSegmentIndex: number;
	};
	words: readonly LiveChunkWordInput[] | null | undefined;
	languageCode: string | null;
	session?: string;
}): Promise<LiveTranscriptArtifact | null> {
	const { bucket, ownerId, videoId, chunk, session } = options;
	const words = offsetChunkWords(
		options.words,
		chunk.startMs,
		chunk.durationMs,
		chunk.contextMs,
	);
	const artifact =
		(await readLiveTranscript(bucket, ownerId, videoId)) ??
		createEmptyLiveTranscript(new Date().toISOString());
	const updated = applyChunkToLiveTranscript(artifact, {
		...chunk,
		words,
		languageCode: options.languageCode,
		nowIso: new Date().toISOString(),
	});

	const [current] = await db()
		.select({
			transcriptionStatus: videos.transcriptionStatus,
			session: sql<
				string | null
			>`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.liveTranscript.session'))`,
		})
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));
	if (
		isCanonicalTranscriptDone(current?.transcriptionStatus) ||
		(session !== undefined && current?.session !== session)
	) {
		return null;
	}

	await bucket
		.putObject(
			getLiveTranscriptObjectKey(ownerId, videoId),
			JSON.stringify(updated),
			{ contentType: "application/json" },
		)
		.pipe(runWorkflowPromise);

	await touchLiveClaim(videoId, session);
	return updated;
}

export function liveContextSeconds() {
	const value = Number(serverEnv().LIVE_TRANSCRIBE_CONTEXT_SECONDS ?? 0);
	return Number.isFinite(value) ? Math.min(Math.max(value, 0), 60) : 0;
}

/**
 * Re-stamp the live claim's freshness so other transcription triggers keep
 * deferring to the running live transcription (lib/transcribe.ts checks the
 * stamp age). A no-op once the claim was cleared, finished, or handed to
 * another session.
 */
export async function touchLiveClaim(
	videoId: string,
	session?: string,
): Promise<void> {
	try {
		await db()
			.update(videos)
			.set({
				metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.liveTranscript.updatedAt', ${new Date().toISOString()})`,
				updatedAt: sql`${videos.updatedAt}`,
			})
			.where(
				and(
					eq(videos.id, videoId as Video.VideoId),
					sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.liveTranscript.status')) = 'active'`,
					session === undefined ? undefined : liveSessionMatches(session),
				),
			);
	} catch (error) {
		console.warn(
			`[liveTranscribe] Failed to stamp live claim for ${videoId}`,
			error,
		);
	}
}

type PromotionResult = { promoted: boolean; reason?: string };

/**
 * Promote the completed live transcript to the canonical transcript: write
 * transcription.vtt + the encrypted edit transcript from the accumulated
 * words, claim transcriptionStatus, queue AI generation, and clean up the
 * provisional artifact. Never throws. Any failure releases the claim (if
 * held) and queues the normal full-pass so the video still transcribes.
 */
export async function promoteLiveTranscript(
	videoId: string,
	userId: string,
): Promise<PromotionResult> {
	try {
		const [video] = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId));

		if (!video || video.ownerId !== userId) {
			return { promoted: false, reason: "video not found" };
		}
		if (video.transcriptionStatus !== null) {
			return {
				promoted: false,
				reason: `canonical status is ${video.transcriptionStatus}`,
			};
		}

		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(video),
		).pipe(runWorkflowPromise);
		const segSource = new Video.SegmentsSource({
			videoId,
			ownerId: video.ownerId,
		});

		const manifestContent = await bucket
			.getObject(segSource.getManifestKey())
			.pipe(runWorkflowPromise);
		const manifestJson = Option.getOrNull(manifestContent);
		if (!manifestJson) {
			return { promoted: false, reason: "manifest missing" };
		}
		const decoded = Schema.decodeUnknownEither(Video.SegmentManifest)(
			JSON.parse(manifestJson),
		);
		if (Either.isLeft(decoded)) {
			return { promoted: false, reason: "manifest invalid" };
		}

		const artifactKey = getLiveTranscriptObjectKey(video.ownerId, videoId);
		const existing = await bucket
			.getObject(artifactKey)
			.pipe(runWorkflowPromise);
		const artifact = Option.isSome(existing)
			? parseLiveTranscript(existing.value)
			: null;
		if (!artifact) {
			return { promoted: false, reason: "live artifact missing" };
		}

		const eligible = canPromoteLiveTranscript(artifact, decoded.right);
		if (!eligible.ok) {
			await queueFullPassFallback(videoId, userId);
			return { promoted: false, reason: eligible.reason };
		}

		const editTranscript = serializeEditTranscript(
			liveTranscriptToEditTranscript(artifact, ASSEMBLYAI_SPEECH_MODELS[0]),
		);
		if (!parseEditTranscript(editTranscript)) {
			await queueFullPassFallback(videoId, userId);
			return {
				promoted: false,
				reason: "live words are not a valid transcript",
			};
		}

		const claim = await db()
			.update(videos)
			.set({ transcriptionStatus: "PROCESSING" })
			.where(
				and(
					eq(videos.id, videoId as Video.VideoId),
					isNull(videos.transcriptionStatus),
				),
			);
		const affectedRows = Array.isArray(claim)
			? ((claim[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0)
			: ((claim as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
		if (affectedRows === 0) {
			return { promoted: false, reason: "canonical claim held elsewhere" };
		}

		try {
			await bucket
				.putObject(
					`${video.ownerId}/${videoId}/transcription.vtt`,
					artifact.vtt,
					{ contentType: "text/vtt" },
				)
				.pipe(runWorkflowPromise);

			// Same rule as the full-pass save: the word transcript must describe
			// the original media, so edited videos keep their own.
			const [edit] = await db()
				.select({ videoId: videoEdits.videoId })
				.from(videoEdits)
				.where(eq(videoEdits.videoId, videoId as Video.VideoId));
			if (!edit) {
				await bucket
					.putObject(
						getEditTranscriptObjectKey(video.ownerId, videoId),
						encryptEditTranscriptObject(editTranscript, video.ownerId, videoId),
						{ contentType: "application/octet-stream" },
					)
					.pipe(runWorkflowPromise);
			}

			await db()
				.update(videos)
				.set({ transcriptionStatus: "COMPLETE" })
				.where(
					and(
						eq(videos.id, videoId as Video.VideoId),
						eq(videos.transcriptionStatus, "PROCESSING"),
					),
				);
		} catch (error) {
			// Release the claim so the fallback can transcribe from scratch.
			await db()
				.update(videos)
				.set({ transcriptionStatus: null })
				.where(
					and(
						eq(videos.id, videoId as Video.VideoId),
						eq(videos.transcriptionStatus, "PROCESSING"),
					),
				);
			await queueFullPassFallback(videoId, userId);
			return {
				promoted: false,
				reason: error instanceof Error ? error.message : String(error),
			};
		}

		// Post-COMPLETE housekeeping: never fatal, never releases the claim.
		try {
			await bucket.deleteObject(artifactKey).pipe(runWorkflowPromise);
		} catch (error) {
			console.warn(
				`[liveTranscribe] Failed to delete promoted artifact for ${videoId}`,
				error,
			);
		}
		try {
			await db()
				.update(videos)
				.set({
					metadata: sql`JSON_REMOVE(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.liveTranscript')`,
					updatedAt: sql`${videos.updatedAt}`,
				})
				.where(eq(videos.id, videoId as Video.VideoId));
		} catch (error) {
			console.warn(
				`[liveTranscribe] Failed to clear live flag for ${videoId}`,
				error,
			);
		}
		try {
			const [owner] = await db()
				.select({
					email: users.email,
					stripeSubscriptionStatus: users.stripeSubscriptionStatus,
					thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
				})
				.from(users)
				.where(eq(users.id, userId as User.UserId));
			if (isAiGenerationEnabledForUser(owner)) {
				await startAiGeneration(videoId as Video.VideoId, userId);
			}
		} catch (error) {
			console.warn(
				`[liveTranscribe] Failed to queue AI generation for ${videoId}`,
				error,
			);
		}

		return { promoted: true };
	} catch (error) {
		return {
			promoted: false,
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * When promotion can't happen, immediately queue the normal full
 * transcription (early-from-segments) instead of waiting for the post-mux
 * queue, so a declined promotion costs seconds, not a minute.
 */
async function queueFullPassFallback(
	videoId: string,
	userId: string,
): Promise<void> {
	try {
		const [owner] = await db()
			.select({
				email: users.email,
				stripeSubscriptionStatus: users.stripeSubscriptionStatus,
				thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
			})
			.from(users)
			.where(eq(users.id, userId as User.UserId));

		await transcribeVideo(
			videoId as Video.VideoId,
			userId,
			isAiGenerationEnabledForUser(owner),
			{ earlyFromSegments: true },
		);
	} catch (error) {
		console.warn(
			`[liveTranscribe] Full-pass fallback queue failed for ${videoId}`,
			error,
		);
	}
}

export async function finishLiveTranscription(
	videoId: string,
	userId: string,
	state: LiveTranscriptState,
): Promise<void> {
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
