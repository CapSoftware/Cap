import { videoEdits, videos } from "@cap/database/schema";
import { Database, Storage } from "@cap/web-backend";
import type { AiGenerationLanguage } from "@cap/web-domain";
import { HttpApiError } from "@effect/platform";
import { and, eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { requestEditTranscript } from "@/actions/videos/get-edit-transcript";
import {
	getEditTranscriptBackfillStatus,
	getEditTranscriptObjectKey,
	parseEditTranscript,
} from "./edit-transcript";
import { decryptEditTranscriptObject } from "./edit-transcript-storage";
import { isEditorReplacementOutput } from "./editor-caption-transcripts";
import { editTranscriptToEditorCaptions } from "./editor-captions";
import { queueVideoTranscription } from "./queue-video-transcription";
import { decodeStorageVideo } from "./video-storage";

const BACKFILL_STALE_AFTER_MS = 60 * 60 * 1000;

type EditorVideo = typeof videos.$inferSelect;

export type EditorCaptionSnapshot = {
	status:
		| "ready"
		| "processing"
		| "missing"
		| "error"
		| "no_audio"
		| "disabled";
	captions: ReturnType<typeof editTranscriptToEditorCaptions> | null;
	message: string | null;
};

/// Recordings whose editor timeline no longer matches the share video, or a
/// language other than the share transcript's, are transcribed from the
/// editor's own sources by a caption job that needs a worker session.
export function usesEditorCaptionJob(
	video: EditorVideo,
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

export const readShareTranscriptCaptions = Effect.fn(
	"WebEditorCaptions.readShareTranscript",
)(function* (video: EditorVideo) {
	if (video.transcriptionStatus === "SKIPPED") {
		return {
			status: "disabled",
			captions: null,
			message: "Transcription is disabled for this video",
		} satisfies EditorCaptionSnapshot;
	}
	if (video.transcriptionStatus === "NO_AUDIO") {
		return {
			status: "no_audio",
			captions: null,
			message: "No spoken audio was found in this video",
		} satisfies EditorCaptionSnapshot;
	}
	if (video.transcriptionStatus === "ERROR") {
		return {
			status: "error",
			captions: null,
			message: "Transcription failed. Try again.",
		} satisfies EditorCaptionSnapshot;
	}
	if (video.transcriptionStatus === "PROCESSING") {
		return {
			status: "processing",
			captions: null,
			message: null,
		} satisfies EditorCaptionSnapshot;
	}
	if (video.transcriptionStatus !== "COMPLETE") {
		return {
			status: "missing",
			captions: null,
			message: null,
		} satisfies EditorCaptionSnapshot;
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
						status: "no_audio",
						captions: null,
						message: "No spoken audio was found in this video",
					} satisfies EditorCaptionSnapshot;
				}
				return {
					status: "ready",
					captions: editTranscriptToEditorCaptions(transcript),
					message: null,
				} satisfies EditorCaptionSnapshot;
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
				status: "missing",
				captions: null,
				message: "Caption transcript preparation stalled. Try again.",
			} satisfies EditorCaptionSnapshot;
		}
		return {
			status: "processing",
			captions: null,
			message: null,
		} satisfies EditorCaptionSnapshot;
	}
	return {
		status: "missing",
		captions: null,
		message:
			backfill?.status === "error"
				? "Caption transcript preparation failed. Try again."
				: null,
	} satisfies EditorCaptionSnapshot;
});

export const requestShareTranscriptCaptions = Effect.fn(
	"WebEditorCaptions.requestShareTranscript",
)(function* (video: EditorVideo) {
	if (video.transcriptionStatus === "COMPLETE") {
		const backfill = yield* Effect.tryPromise({
			try: () => requestEditTranscript(video.id),
			catch: () => new HttpApiError.ServiceUnavailable(),
		});
		return (
			backfill.status === "error"
				? { status: "error", captions: null, message: backfill.message }
				: { status: "processing", captions: null, message: null }
		) satisfies EditorCaptionSnapshot;
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
		try: () => queueVideoTranscription(video.id),
		catch: () => new HttpApiError.ServiceUnavailable(),
	});
	return (
		result.success
			? { status: "processing", captions: null, message: null }
			: { status: "error", captions: null, message: result.message }
	) satisfies EditorCaptionSnapshot;
});
