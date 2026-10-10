import { randomUUID } from "node:crypto";
import { videoEdits, videos } from "@cap/database/schema";
import { Database, Storage } from "@cap/web-backend";
import { getRecordingObjectIdentity } from "@cap/web-backend/src/Storage/recording-object-identity";
import type { AiGenerationLanguage } from "@cap/web-domain";
import { HttpApiError } from "@effect/platform";
import { and, eq, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { start } from "workflow/api";
import { parseEditTranscript } from "./edit-transcript";
import { decryptEditTranscriptObject } from "./edit-transcript-storage";
import {
	buildEditorCaptionSourcePlan,
	type EditorCaptionSourcePlan,
} from "./editor-caption-sources";
import { transcribeWebEditorCaptionsWorkflow } from "./editor-caption-workflow";
import { editTranscriptToEditorCaptions } from "./editor-captions";
import { requestMediaEditor } from "./editor-session";
import { editorWorkerIdFromSessionId } from "./editor-worker-routing";
import { getEditSourceKey } from "./video-edit-processing";
import { decodeStorageVideo } from "./video-storage";

const JOB_STALE_AFTER_MS = 4 * 60 * 60 * 1000;
type EditorVideo = typeof videos.$inferSelect;

function currentJob(
	job: { sourceHash: string; requestedAt: string; status: string } | undefined,
	plan: EditorCaptionSourcePlan,
) {
	const requestedAt = job ? Date.parse(job.requestedAt) : Number.NaN;
	return (
		job?.sourceHash === plan.hash &&
		Number.isFinite(requestedAt) &&
		Date.now() - requestedAt < JOB_STALE_AFTER_MS
	);
}

export const inspectEditorCaptionJob = Effect.fn(
	"WebEditorCaptions.inspectJob",
)(function* (
	video: EditorVideo,
	sessionPath: string,
	language: AiGenerationLanguage = "auto",
) {
	const response = yield* requestMediaEditor(`${sessionPath}/instance`);
	if (!response.ok) return yield* new HttpApiError.ServiceUnavailable();
	const instance: unknown = yield* Effect.tryPromise({
		try: () => response.json(),
		catch: () => new HttpApiError.ServiceUnavailable(),
	});
	const workerId =
		editorWorkerIdFromSessionId(
			decodeURIComponent(sessionPath.slice("/editor/sessions/".length)),
		) ?? "";
	const database = yield* Database;
	const [legacyEdit] = yield* database
		.use((client) =>
			client
				.select({ sourceKey: videoEdits.sourceKey })
				.from(videoEdits)
				.where(eq(videoEdits.videoId, video.id)),
		)
		.pipe(
			Effect.catchTag("DatabaseError", () =>
				Effect.fail(new HttpApiError.InternalServerError()),
			),
		);
	let baseOverride:
		| { key: string; size: number; objectIdentity: string }
		| undefined;
	if (legacyEdit) {
		if (legacyEdit.sourceKey !== getEditSourceKey(video.ownerId, video.id)) {
			return yield* new HttpApiError.ServiceUnavailable();
		}
		const [sourceStorage] = yield* Storage.getAccessForVideo(
			decodeStorageVideo(video),
			{ resolvePublishedOutput: false },
		).pipe(
			Effect.catchTag("StorageError", () =>
				Effect.fail(new HttpApiError.ServiceUnavailable()),
			),
		);
		const head = yield* sourceStorage
			.headObject(legacyEdit.sourceKey)
			.pipe(
				Effect.catchTag("StorageError", () =>
					Effect.fail(new HttpApiError.ServiceUnavailable()),
				),
			);
		const identity = getRecordingObjectIdentity(head);
		if (
			!Number.isSafeInteger(head.ContentLength) ||
			!head.ContentLength ||
			!identity
		) {
			return yield* new HttpApiError.ServiceUnavailable();
		}
		baseOverride = {
			key: legacyEdit.sourceKey,
			size: head.ContentLength,
			objectIdentity: identity,
		};
	}
	const plan = buildEditorCaptionSourcePlan(
		video.ownerId,
		video.id,
		video.metadata,
		instance,
		workerId,
		language,
		baseOverride,
	);
	if (!plan) {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	const [bucket] = yield* Storage.getAccessForVideo(decodeStorageVideo(video), {
		resolvePublishedOutput: false,
	}).pipe(
		Effect.catchTag("StorageError", () =>
			Effect.fail(new HttpApiError.ServiceUnavailable()),
		),
	);
	const content = yield* bucket
		.getObject(plan.combinedKey)
		.pipe(
			Effect.catchTag("StorageError", () =>
				Effect.fail(new HttpApiError.ServiceUnavailable()),
			),
		);
	const decrypted = Option.isSome(content)
		? decryptEditTranscriptObject(content.value, video.ownerId, video.id)
		: null;
	const transcript = decrypted ? parseEditTranscript(decrypted) : null;
	const durationMs = plan.sources.reduce(
		(total, source) => total + source.segmentDurationMs,
		0,
	);
	if (transcript && Math.abs(transcript.durationMs - durationMs) <= 250) {
		return {
			plan,
			snapshot: transcript.words.length
				? {
						status: "ready" as const,
						captions: editTranscriptToEditorCaptions(transcript),
						message: null,
					}
				: {
						status: "no_audio" as const,
						captions: null,
						message: "No spoken audio was found in this recording",
					},
		};
	}
	const job = video.metadata?.webEditorCaptionJob;
	if (job?.status === "processing" && currentJob(job, plan)) {
		return {
			plan,
			snapshot: {
				status: "processing" as const,
				captions: null,
				message: null,
			},
		};
	}
	return {
		plan,
		snapshot: {
			status: "missing" as const,
			captions: null,
			message:
				job?.sourceHash === plan.hash && job.status === "error"
					? "Caption transcription failed. Try again."
					: job?.sourceHash === plan.hash && job.status === "processing"
						? "Caption transcription stalled. Try again."
						: null,
		},
	};
});

const claimEditorCaptionJob = Effect.fn("WebEditorCaptions.claimJob")(
	function* (video: EditorVideo, plan: EditorCaptionSourcePlan) {
		const database = yield* Database;
		return yield* database
			.use((client) =>
				client.transaction(async (tx) => {
					const [record] = await tx
						.select({ metadata: videos.metadata })
						.from(videos)
						.where(
							and(eq(videos.id, video.id), eq(videos.ownerId, video.ownerId)),
						)
						.for("update");
					if (!record) return { claimed: false as const };
					if (
						record.metadata?.webEditorCaptionJob?.status === "processing" &&
						currentJob(record.metadata.webEditorCaptionJob, plan)
					) {
						return { claimed: false as const };
					}
					const requestId = randomUUID();
					const job = {
						status: "processing",
						requestId,
						sourceHash: plan.hash,
						requestedAt: new Date().toISOString(),
					};
					await tx
						.update(videos)
						.set({
							metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.webEditorCaptionJob', CAST(${JSON.stringify(job)} AS JSON))`,
							updatedAt: sql`${videos.updatedAt}`,
						})
						.where(eq(videos.id, video.id));
					return { claimed: true as const, requestId };
				}),
			)
			.pipe(
				Effect.catchTag("DatabaseError", () =>
					Effect.fail(new HttpApiError.InternalServerError()),
				),
			);
	},
);

export const generateEditorCaptionJob = Effect.fn(
	"WebEditorCaptions.generateJob",
)(function* (
	video: EditorVideo,
	sessionPath: string,
	language: AiGenerationLanguage = "auto",
) {
	const inspected = yield* inspectEditorCaptionJob(
		video,
		sessionPath,
		language,
	);
	if (
		inspected.snapshot.status === "ready" ||
		inspected.snapshot.status === "processing" ||
		inspected.snapshot.status === "no_audio"
	) {
		return inspected.snapshot;
	}
	const claim = yield* claimEditorCaptionJob(video, inspected.plan);
	if (!claim.claimed) {
		return {
			status: "processing" as const,
			captions: null,
			message: null,
		};
	}
	const started = yield* Effect.tryPromise({
		try: () =>
			start(transcribeWebEditorCaptionsWorkflow, [
				{ plan: inspected.plan, requestId: claim.requestId },
			]),
		catch: () => new HttpApiError.ServiceUnavailable(),
	}).pipe(Effect.either);
	if (started._tag === "Left") {
		const database = yield* Database;
		yield* database
			.use((client) =>
				client
					.update(videos)
					.set({
						metadata: sql`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.webEditorCaptionJob.status', 'error')`,
						updatedAt: sql`${videos.updatedAt}`,
					})
					.where(
						and(
							eq(videos.id, video.id),
							sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.webEditorCaptionJob.requestId')) = ${claim.requestId}`,
						),
					),
			)
			.pipe(
				Effect.catchTag("DatabaseError", () =>
					Effect.fail(new HttpApiError.InternalServerError()),
				),
			);
		return {
			status: "error" as const,
			captions: null,
			message: "Caption transcription could not start. Try again.",
		};
	}
	return {
		status: "processing" as const,
		captions: null,
		message: null,
	};
});
