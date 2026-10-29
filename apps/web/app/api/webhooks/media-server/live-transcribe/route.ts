import { createHash, timingSafeEqual } from "node:crypto";
import { serverEnv } from "@cap/env";
import { Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpServerRequest,
} from "@effect/platform";
import { Effect, Either, Layer, Option, Schema } from "effect";
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
import { apiToHandler } from "@/lib/server";
import { runWorkflowPromise } from "@/lib/workflow-runtime";

const MAX_CHUNK_WORDS = 20_000;

const Session = {
	videoId: Schema.String.pipe(Schema.maxLength(64)),
	session: Schema.String.pipe(Schema.maxLength(64)),
};
const SegmentIndex = Schema.Number.pipe(Schema.int());

const Report = Schema.Union(
	Schema.Struct({
		action: Schema.Literal("chunk"),
		...Session,
		lastProcessedIndex: SegmentIndex,
		lastIndex: SegmentIndex,
		contextFromIndex: Schema.NullOr(SegmentIndex),
		words: Schema.Array(
			Schema.Struct({
				text: Schema.String.pipe(Schema.maxLength(200)),
				start: Schema.Number,
				end: Schema.Number,
				confidence: Schema.optional(Schema.NullOr(Schema.Number)),
				speaker: Schema.optional(
					Schema.NullOr(Schema.String.pipe(Schema.maxLength(40))),
				),
			}),
		).pipe(Schema.maxItems(MAX_CHUNK_WORDS)),
		languageCode: Schema.NullOr(Schema.String.pipe(Schema.maxLength(16))),
	}),
	Schema.Struct({
		action: Schema.Literal("gap"),
		...Session,
		lastProcessedIndex: SegmentIndex,
		lastIndex: SegmentIndex,
	}),
	Schema.Struct({ action: Schema.Literal("sync"), ...Session }),
	Schema.Struct({
		action: Schema.Literal("finish"),
		...Session,
		outcome: Schema.String.pipe(Schema.maxLength(40)),
	}),
	Schema.Struct({ action: Schema.Literal("release"), ...Session }),
);

const Answer = Schema.Union(
	Schema.Struct({ continue: Schema.Literal(false) }),
	Schema.Struct({
		continue: Schema.Literal(true),
		state: Schema.Struct({
			lastAudioSegmentIndex: Schema.Number,
			transcribedDurationMs: Schema.Number,
			transcriptionOptions: Schema.Record({
				key: Schema.String,
				value: Schema.Unknown,
			}),
			urls: Schema.Struct({
				manifest: Schema.String,
				audioInit: Schema.String,
				segments: Schema.Record({ key: Schema.String, value: Schema.String }),
			}),
		}),
	}),
);

class Api extends HttpApi.make("LiveTranscribeReportApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.post("report")`/api/webhooks/media-server/live-transcribe`
			.setPayload(Report)
			.addSuccess(Answer)
			.addError(HttpApiError.Unauthorized),
	),
) {}

const stop = { continue: false } as const;

function digest(value: string) {
	return createHash("sha256").update(value, "utf8").digest();
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
async function handleReport(
	report: typeof Report.Type,
): Promise<typeof Answer.Type> {
	const { videoId, session } = report;

	const row = await loadLiveVideo(videoId);
	if (!row || getLiveSession(row.video) !== session) return stop;
	const { video } = row;

	if (report.action === "release") {
		await dispatchLiveTranscription(video.id, video.ownerId, session);
		return stop;
	}

	if (report.action === "finish") {
		if (report.outcome === "done") {
			const promotion = await promoteLiveTranscript(videoId, video.ownerId);
			if (promotion.promoted) return stop;
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
		return stop;
	}

	if (liveTranscriptionEnded(row)) {
		await finishLiveTranscription(videoId, video.ownerId, "stopped");
		return stop;
	}

	const bucket = await getFarmLiveBucket(video);
	if (!bucket) {
		await finishLiveTranscription(videoId, video.ownerId, "stopped");
		return stop;
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
		if (write?.status === "stopped") return stop;
		if (write?.status === "written") artifact = write.artifact;
	}

	artifact ??= await readLiveTranscript(bucket, video.ownerId, videoId);
	return {
		continue: true,
		state: await buildLiveSessionState({
			bucket,
			video,
			orgSettings: row.orgSettings,
			artifact,
		}),
	};
}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers.handle("report", ({ payload }) =>
				Effect.gen(function* () {
					const request = yield* HttpServerRequest.HttpServerRequest;
					const secret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;
					const header = request.headers["x-media-server-secret"];
					if (
						!secret ||
						!header ||
						!timingSafeEqual(digest(header), digest(secret))
					)
						return yield* new HttpApiError.Unauthorized();
					return yield* Effect.promise(() => handleReport(payload));
				}),
			),
		),
	),
);

export const POST = apiToHandler(ApiLive);
export const maxDuration = 120;
export const dynamic = "force-dynamic";
