import { createHash, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@cap/env";
import { Video } from "@cap/web-domain";
import { Either, Option, Schema } from "effect";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { dispatchLiveTranscription } from "@/lib/live-transcribe";
import {
	describeLiveChunk,
	type LiveTranscriptArtifact,
} from "@/lib/live-transcribe-core";
import {
	buildLiveSessionState,
	getFarmLiveBucket,
	getLiveSession,
	liveTranscriptionEnded,
	loadLiveVideo,
} from "@/lib/live-transcribe-farm";
import {
	finishLiveTranscription,
	type LiveBucket,
	type LiveTranscriptUpdate,
	promoteLiveTranscript,
	readLiveTranscript,
	touchLiveClaim,
	writeLiveChunk,
	writeLiveChunkGap,
} from "@/lib/live-transcribe-runner";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

export const maxDuration = 120;

const MAX_CHUNK_WORDS = 20_000;

const wordSchema = z.object({
	text: z.string().max(200),
	start: z.number(),
	end: z.number(),
	confidence: z.number().nullish(),
	speaker: z.string().max(40).nullish(),
});

const reportSchema = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("chunk"),
		videoId: z.string(),
		session: z.string(),
		lastProcessedIndex: z.number().int(),
		lastIndex: z.number().int(),
		contextFromIndex: z.number().int().nullable(),
		words: z.array(wordSchema).max(MAX_CHUNK_WORDS),
		languageCode: z.string().max(16).nullable(),
	}),
	z.object({
		action: z.literal("gap"),
		videoId: z.string(),
		session: z.string(),
		lastProcessedIndex: z.number().int(),
		lastIndex: z.number().int(),
	}),
	z.object({
		action: z.literal("sync"),
		videoId: z.string(),
		session: z.string(),
	}),
	z.object({
		action: z.literal("finish"),
		videoId: z.string(),
		session: z.string(),
		outcome: z.string().max(40),
	}),
	z.object({
		action: z.literal("release"),
		videoId: z.string(),
		session: z.string(),
	}),
]);

const stop = () => NextResponse.json({ continue: false });

function authorized(request: NextRequest) {
	const secret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;
	const header = request.headers.get("x-media-server-secret");
	const digest = (value: string) =>
		createHash("sha256").update(value, "utf8").digest();
	return (
		Boolean(secret) &&
		Boolean(header) &&
		timingSafeEqual(digest(header ?? ""), digest(secret ?? ""))
	);
}

async function readManifest(
	bucket: LiveBucket,
	ownerId: string,
	videoId: string,
) {
	const source = new Video.SegmentsSource({ videoId, ownerId });
	const content = await bucket
		.getObject(source.getManifestKey())
		.pipe(runWorkflowPromise)
		.catch(() => Option.none<string>());
	if (Option.isNone(content)) return null;
	try {
		const decoded = Schema.decodeUnknownEither(Video.SegmentManifest)(
			JSON.parse(content.value),
		);
		return Either.isRight(decoded) ? decoded.right : null;
	} catch {
		return null;
	}
}

/**
 * Reports from a media server live transcription session (see
 * lib/live-transcribe-farm.ts). Only the session named in the claim is
 * heard. Every answer carries the authoritative cursor and fresh signed URLs,
 * or `continue: false` when the session should end.
 */
export async function POST(request: NextRequest) {
	if (!authorized(request)) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const parsed = reportSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid report" }, { status: 400 });
	}
	const report = parsed.data;
	const { videoId, session } = report;

	const row = await loadLiveVideo(videoId);
	if (!row || getLiveSession(row.video) !== session) return stop();
	const { video } = row;

	if (report.action === "release") {
		await dispatchLiveTranscription(video.id, video.ownerId, session);
		return stop();
	}

	if (report.action === "finish") {
		if (report.outcome === "done") {
			const promotion = await promoteLiveTranscript(videoId, video.ownerId);
			if (promotion.promoted) return stop();
			console.warn(
				`[liveTranscribe] Promotion declined for ${videoId}: ${promotion.reason}`,
			);
		}
		await finishLiveTranscription(
			videoId,
			video.ownerId,
			report.outcome === "done" ? "complete" : "stopped",
		);
		console.log(`[liveTranscribe] ${videoId} media server ${report.outcome}`);
		return stop();
	}

	if (liveTranscriptionEnded(row)) {
		await finishLiveTranscription(videoId, video.ownerId, "stopped");
		return stop();
	}

	const bucket = await getFarmLiveBucket(video);
	if (!bucket) {
		await finishLiveTranscription(videoId, video.ownerId, "stopped");
		return stop();
	}
	let artifact: LiveTranscriptArtifact | null | undefined;
	if (report.action === "sync") {
		await touchLiveClaim(videoId, session);
	} else {
		const manifest = await readManifest(bucket, video.ownerId, videoId);
		const chunk = manifest
			? describeLiveChunk({
					manifest,
					lastProcessedIndex: report.lastProcessedIndex,
					lastIndex: report.lastIndex,
					contextFromIndex:
						report.action === "chunk" ? report.contextFromIndex : null,
				})
			: null;
		const range = `${report.lastProcessedIndex + 1}..${report.lastIndex}`;
		const target = {
			bucket,
			ownerId: video.ownerId,
			videoId,
			session,
			expectedCursor: report.lastProcessedIndex,
		};

		let write: LiveTranscriptUpdate | null = null;
		if (chunk && report.action === "gap") {
			console.warn(
				`[liveTranscribe] Skipping poison chunk ${range} for ${videoId}`,
			);
			write = await writeLiveChunkGap({
				...target,
				lastAudioSegmentIndex: report.lastIndex,
				endMs: chunk.startMs + chunk.durationMs,
			});
		} else if (chunk && report.action === "chunk") {
			write = await writeLiveChunk({
				...target,
				chunk: {
					startMs: chunk.startMs,
					durationMs: chunk.durationMs,
					contextMs: chunk.contextMs,
					lastAudioSegmentIndex: report.lastIndex,
				},
				words: report.words,
				languageCode: report.languageCode,
			});
			if (write.status === "written") {
				console.log(
					`[liveTranscribe] ${videoId} chunk ${range} (${chunk.durationMs}ms + ${chunk.contextMs}ms context, ${report.words.length} words) via media server`,
				);
			}
		} else {
			console.warn(
				`[liveTranscribe] ${videoId} report for ${range} does not match the manifest`,
			);
		}
		if (write?.status === "stopped") return stop();
		if (write?.status === "written") artifact = write.artifact;
	}

	artifact ??= await readLiveTranscript(bucket, video.ownerId, videoId);
	return NextResponse.json({
		continue: true,
		state: await buildLiveSessionState({
			bucket,
			video,
			orgSettings: row.orgSettings,
			artifact,
		}),
	});
}
