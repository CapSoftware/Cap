import { videoEdits, videos } from "@cap/database/schema";
import { Database, Storage } from "@cap/web-backend";
import {
	type AiGenerationLanguage,
	HttpAuthMiddleware,
	isAiGenerationLanguage,
	Video,
} from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
} from "@effect/platform";
import { and, eq } from "drizzle-orm";
import { Effect, Layer, Option, Schema } from "effect";
import { requestEditTranscript } from "@/actions/videos/get-edit-transcript";
import {
	getEditTranscriptBackfillStatus,
	getEditTranscriptObjectKey,
	parseEditTranscript,
} from "@/lib/edit-transcript";
import { decryptEditTranscriptObject } from "@/lib/edit-transcript-storage";
import {
	generateEditorCaptionJob,
	inspectEditorCaptionJob,
} from "@/lib/editor-caption-job";
import { isEditorReplacementOutput } from "@/lib/editor-caption-sources";
import { editTranscriptToEditorCaptions } from "@/lib/editor-captions";
import {
	loadEligibleEditorVideo,
	verifyOwnedEditorSession,
} from "@/lib/editor-session";
import { queueVideoTranscription } from "@/lib/queue-video-transcription";
import { apiToHandler } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export const dynamic = "force-dynamic";
const BACKFILL_STALE_AFTER_MS = 60 * 60 * 1000;

const CaptionWord = Schema.Struct({
	text: Schema.String,
	start: Schema.Number,
	end: Schema.Number,
});
const CaptionSegment = Schema.Struct({
	id: Schema.String,
	start: Schema.Number,
	end: Schema.Number,
	text: Schema.String,
	words: Schema.Array(CaptionWord),
});
const CaptionData = Schema.Struct({
	segments: Schema.Array(CaptionSegment),
	settings: Schema.Null,
});
const CaptionSnapshot = Schema.Struct({
	status: Schema.Literal(
		"ready",
		"processing",
		"missing",
		"error",
		"no_audio",
		"disabled",
	),
	captions: Schema.NullOr(CaptionData),
	message: Schema.NullOr(Schema.String),
});
const CaptionRequest = Schema.Struct({
	videoId: Video.VideoId,
	language: Schema.optional(Schema.String),
});

function usesEditorCaptionJob(
	video: typeof videos.$inferSelect,
	language: AiGenerationLanguage,
) {
	return (
		language !== "auto" ||
		(video.metadata?.webEditorClips?.items?.length ?? 0) > 0 ||
		(video.metadata?.webEditorImports?.items?.some(
			(item) => item.kind === "cap",
		) ??
			false) ||
		isEditorReplacementOutput(video)
	);
}

class Api extends HttpApi.make("WebEditorCaptionsApi").add(
	HttpApiGroup.make("root")
		.add(
			HttpApiEndpoint.get("status", "/api/editor/sessions/:id/captions")
				.setPath(Schema.Struct({ id: Schema.String }))
				.setUrlParams(CaptionRequest)
				.addSuccess(CaptionSnapshot)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.ServiceUnavailable)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		)
		.add(
			HttpApiEndpoint.post("generate", "/api/editor/sessions/:id/captions")
				.setPath(Schema.Struct({ id: Schema.String }))
				.setPayload(CaptionRequest)
				.addSuccess(CaptionSnapshot)
				.addError(HttpApiError.BadRequest)
				.addError(HttpApiError.NotFound)
				.addError(HttpApiError.Forbidden)
				.addError(HttpApiError.ServiceUnavailable)
				.addError(HttpApiError.InternalServerError)
				.middleware(HttpAuthMiddleware),
		),
) {}

const readSnapshot = Effect.fn("WebEditorCaptions.readSnapshot")(function* (
	videoId: Video.VideoId,
	sessionId: string,
	language: AiGenerationLanguage,
) {
	const video = yield* loadEligibleEditorVideo(videoId, false, true);
	const sessionPath = yield* verifyOwnedEditorSession(videoId, sessionId);
	if (usesEditorCaptionJob(video, language)) {
		const inspected = yield* inspectEditorCaptionJob(
			video,
			sessionPath,
			language,
		);
		return inspected.snapshot;
	}
	if (video.transcriptionStatus === "SKIPPED") {
		return {
			status: "disabled" as const,
			captions: null,
			message: "Transcription is disabled for this video",
		};
	}
	if (video.transcriptionStatus === "NO_AUDIO") {
		return {
			status: "no_audio" as const,
			captions: null,
			message: "No spoken audio was found in this video",
		};
	}
	if (video.transcriptionStatus === "ERROR") {
		return {
			status: "error" as const,
			captions: null,
			message: "Transcription failed. Try again.",
		};
	}
	if (video.transcriptionStatus === "PROCESSING") {
		return {
			status: "processing" as const,
			captions: null,
			message: null,
		};
	}
	if (video.transcriptionStatus !== "COMPLETE") {
		return { status: "missing" as const, captions: null, message: null };
	}
	const [bucket] = yield* Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(
		Effect.catchTag("StorageError", () =>
			Effect.fail(new HttpApiError.ServiceUnavailable()),
		),
	);
	const object = yield* bucket
		.getObject(getEditTranscriptObjectKey(video.ownerId, video.id))
		.pipe(
			Effect.catchTag("StorageError", () =>
				Effect.fail(new HttpApiError.ServiceUnavailable()),
			),
		);
	if (Option.isSome(object)) {
		const decrypted = decryptEditTranscriptObject(
			object.value,
			video.ownerId,
			video.id,
		);
		const transcript = decrypted ? parseEditTranscript(decrypted) : null;
		if (transcript) {
			const database = yield* Database;
			const [edit] = yield* database
				.use((client) =>
					client
						.select({ editSpec: videoEdits.editSpec })
						.from(videoEdits)
						.where(eq(videoEdits.videoId, video.id)),
				)
				.pipe(
					Effect.catchTag("DatabaseError", () =>
						Effect.fail(new HttpApiError.InternalServerError()),
					),
				);
			const sourceDuration = edit?.editSpec?.sourceDuration ?? video.duration;
			if (
				sourceDuration &&
				Math.abs(transcript.durationMs - sourceDuration * 1000) <= 250
			) {
				if (transcript.words.length === 0) {
					return {
						status: "no_audio" as const,
						captions: null,
						message: "No spoken audio was found in this video",
					};
				}
				return {
					status: "ready" as const,
					captions: editTranscriptToEditorCaptions(transcript),
					message: null,
				};
			}
		}
	}
	const backfill = getEditTranscriptBackfillStatus(video.metadata);
	if (backfill?.status === "processing") {
		const requestedAt = Date.parse(backfill.requestedAt);
		if (
			!Number.isFinite(requestedAt) ||
			Date.now() - requestedAt >= BACKFILL_STALE_AFTER_MS
		) {
			return {
				status: "missing" as const,
				captions: null,
				message: "Caption transcript preparation stalled. Try again.",
			};
		}
		return {
			status: "processing" as const,
			captions: null,
			message: null,
		};
	}
	return {
		status: "missing" as const,
		captions: null,
		message:
			backfill?.status === "error"
				? "Caption transcript preparation failed. Try again."
				: null,
	};
});

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			handlers
				.handle("status", ({ path, urlParams }) =>
					Effect.gen(function* () {
						const language = urlParams.language ?? "auto";
						if (!isAiGenerationLanguage(language))
							return yield* new HttpApiError.BadRequest();
						return yield* readSnapshot(urlParams.videoId, path.id, language);
					}),
				)
				.handle("generate", ({ path, payload }) =>
					Effect.gen(function* () {
						const language = payload.language ?? "auto";
						if (!isAiGenerationLanguage(language))
							return yield* new HttpApiError.BadRequest();
						const current = yield* readSnapshot(
							payload.videoId,
							path.id,
							language,
						);
						if (
							current.status === "ready" ||
							current.status === "processing" ||
							current.status === "no_audio" ||
							current.status === "disabled"
						) {
							return current;
						}
						const video = yield* loadEligibleEditorVideo(
							payload.videoId,
							false,
							true,
						);
						if (usesEditorCaptionJob(video, language)) {
							const sessionPath = yield* verifyOwnedEditorSession(
								payload.videoId,
								path.id,
							);
							return yield* generateEditorCaptionJob(
								video,
								sessionPath,
								language,
							);
						}
						if (video.transcriptionStatus === "COMPLETE") {
							const backfill = yield* Effect.tryPromise({
								try: () => requestEditTranscript(payload.videoId),
								catch: () => new HttpApiError.ServiceUnavailable(),
							});
							return backfill.status === "error"
								? {
										status: "error" as const,
										captions: null,
										message: backfill.message,
									}
								: {
										status: "processing" as const,
										captions: null,
										message: null,
									};
						}
						if (video.transcriptionStatus === "ERROR") {
							const database = yield* Database;
							yield* database
								.use((client) =>
									client
										.update(videos)
										.set({ transcriptionStatus: null })
										.where(
											and(
												eq(videos.id, video.id),
												eq(videos.ownerId, video.ownerId),
												eq(videos.transcriptionStatus, "ERROR"),
											),
										),
								)
								.pipe(
									Effect.catchTag("DatabaseError", () =>
										Effect.fail(new HttpApiError.InternalServerError()),
									),
								);
						}
						const result = yield* Effect.tryPromise({
							try: () => queueVideoTranscription(payload.videoId),
							catch: () => new HttpApiError.ServiceUnavailable(),
						});
						return result.success
							? {
									status: "processing" as const,
									captions: null,
									message: null,
								}
							: {
									status: "error" as const,
									captions: null,
									message: result.message,
								};
					}),
				),
		),
	),
);

const handler = apiToHandler(ApiLive);

export const GET = handler;
export const POST = handler;
