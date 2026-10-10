import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { VideoMetadata } from "@cap/database/types";
import { applyDefaultStyle } from "@cap/editor-cap-bundle/default-style";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { HttpApiError } from "@effect/platform";
import { Effect } from "effect";
import {
	hasEditorCaptionContent,
	stripEditorCaptionContent,
} from "@/lib/editor-caption-access";
import { decodeWebEditorProject } from "@/lib/editor-project-storage";
import {
	loadEligibleEditorVideo,
	requestMediaEditor,
	verifyOwnedEditorSession,
} from "@/lib/editor-session";
import { renderFarmKeys } from "@/lib/render-farm";
import {
	attachRenderFarmJob,
	recordRenderFarmSave,
	withdrawRenderFarmSave,
} from "@/lib/render-farm-records";
import {
	canSaveEditorVideo,
	workerSaveSettings,
} from "@/lib/render-farm-start";
import { renderFarmSaveIsCurrent } from "@/lib/render-farm-status";
import { decodeStorageVideo } from "@/lib/video-storage";

type RenderFarmSave = NonNullable<VideoMetadata["renderFarmSave"]>;

/** A Save rendered on an editor worker is recorded with this job prefix. */
export const WORKER_SAVE_JOB_PREFIX = "worker:";
// Long enough for the worker to render (up to 20 minutes) and then upload.
const UPLOAD_URL_TTL_SECONDS = 3 * 60 * 60;

export function workerSaveExportId(save: Pick<RenderFarmSave, "jobId">) {
	return save.jobId.startsWith(WORKER_SAVE_JOB_PREFIX)
		? save.jobId.slice(WORKER_SAVE_JOB_PREFIX.length)
		: null;
}

export function workerSaveCallbackUrl(
	origin: string,
	bypassSecret: string | undefined,
) {
	const url = new URL("/api/editor/worker-saves/callback", origin);
	if (bypassSecret && url.hostname.endsWith(".vercel.app")) {
		url.searchParams.set("x-vercel-protection-bypass", bypassSecret);
	}
	return url.toString();
}

/** Whether a callback carries the editor workers' shared secret. */
export function validWorkerCallbackSecret(header: string | null) {
	const secret = serverEnv().MEDIA_SERVER_WEBHOOK_SECRET;
	if (!secret || !header) return false;
	const digest = (value: string) => createHash("sha256").update(value).digest();
	return timingSafeEqual(digest(header), digest(secret));
}

export type WorkerSaveState = {
	status: "rendering" | "uploading" | "published" | "error";
	progress: { rendered_count: number; total_frames: number } | null;
	size: number | null;
	mediaMetadata: {
		duration: number;
		width: number;
		height: number;
		fps: number;
	} | null;
	error: string | null;
};

export function parseWorkerSaveState(value: unknown): WorkerSaveState | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	const status = record.status;
	if (
		status !== "rendering" &&
		status !== "uploading" &&
		status !== "published" &&
		status !== "error"
	)
		return null;
	const progress = record.progress as WorkerSaveState["progress"] | undefined;
	const media = record.mediaMetadata as WorkerSaveState["mediaMetadata"];
	return {
		status,
		progress:
			progress &&
			Number.isSafeInteger(progress.rendered_count) &&
			Number.isSafeInteger(progress.total_frames)
				? progress
				: null,
		size: Number.isSafeInteger(record.size) ? (record.size as number) : null,
		mediaMetadata:
			media &&
			typeof media === "object" &&
			["duration", "width", "height", "fps"].every((key) =>
				Number.isFinite((media as Record<string, unknown>)[key]),
			)
				? media
				: null,
		error: typeof record.error === "string" ? record.error : null,
	};
}

/** The finished output a published worker Save reports, for publishing. */
export function workerSaveOutput(state: WorkerSaveState) {
	if (state.status !== "published" || !state.size || !state.mediaMetadata)
		return null;
	return {
		width: state.mediaMetadata.width,
		height: state.mediaMetadata.height,
		fps: state.mediaMetadata.fps,
		durationSeconds: state.mediaMetadata.duration,
		bytes: state.size,
	};
}

/** Share of a worker Save done: rendering, then the upload's last tenth. */
export function workerSaveProgress(state: WorkerSaveState) {
	if (state.status === "uploading") return 0.9;
	if (state.status === "published") return 1;
	const total = state.progress?.total_frames ?? 0;
	return total > 0 ? ((state.progress?.rendered_count ?? 0) / total) * 0.9 : 0;
}

/**
 * Renders a Save on the editor worker session when the render farm can't:
 * the worker renders the stored project, uploads it straight into the
 * video's storage and calls back to publish it, like a farm render. The
 * browser that started it can close meanwhile.
 */
export const startWorkerSave = Effect.fn("startWorkerSave")(function* (
	videoId: Video.VideoId,
	sessionId: string,
	origin: string,
) {
	const video = yield* loadEligibleEditorVideo(videoId);
	if (!canSaveEditorVideo(video)) return yield* new HttpApiError.Forbidden();
	if (renderFarmSaveIsCurrent(video.metadata)) {
		return yield* new HttpApiError.Conflict();
	}
	const sessionPath = yield* verifyOwnedEditorSession(video.id, sessionId);
	const [storage] = yield* Storage.getAccessForVideo(
		decodeStorageVideo(video),
		{ resolvePublishedOutput: false },
	).pipe(
		Effect.catchTag("StorageError", () =>
			Effect.fail(new HttpApiError.ServiceUnavailable()),
		),
	);
	if (storage.provider !== "s3") {
		return yield* new HttpApiError.ServiceUnavailable();
	}

	// The worker may have been prepared before the latest edits, so it gets
	// the stored project, styled as the share page shows it.
	const savedProject = video.metadata?.webEditorProject
		? decodeWebEditorProject(video.metadata.webEditorProject)
		: null;
	const putConfig = (config: unknown) =>
		requestMediaEditor(`${sessionPath}/config`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(
				video.captionsEnabled
					? config
					: stripEditorCaptionContent(config as Record<string, unknown>),
			),
		}).pipe(
			Effect.flatMap((response) =>
				response.status === 204
					? Effect.void
					: Effect.fail(new HttpApiError.ServiceUnavailable()),
			),
		);
	if (savedProject) yield* putConfig(savedProject);
	const current = yield* requestMediaEditor(`${sessionPath}/config`);
	if (!current.ok) return yield* new HttpApiError.ServiceUnavailable();
	const sessionConfig: unknown = yield* Effect.tryPromise({
		try: () => current.json(),
		catch: () => new HttpApiError.ServiceUnavailable(),
	});
	if (typeof sessionConfig !== "object" || sessionConfig === null) {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	const projectConfig =
		!savedProject && video.defaultStyle
			? applyDefaultStyle(
					sessionConfig as Record<string, unknown>,
					video.defaultStyle,
				)
			: sessionConfig;
	if (!video.captionsEnabled && hasEditorCaptionContent(projectConfig)) {
		return yield* new HttpApiError.Forbidden();
	}
	if (projectConfig !== sessionConfig) yield* putConfig(projectConfig);

	const exportId = randomUUID();
	const target = renderFarmKeys(video.ownerId, video.id, exportId);
	const uploadUrl = yield* storage
		.getInternalPresignedPutUrl(
			target.outputKey,
			{ ContentType: "video/mp4" },
			{ expiresIn: UPLOAD_URL_TTL_SECONDS },
		)
		.pipe(
			Effect.catchTag("StorageError", () =>
				Effect.fail(new HttpApiError.ServiceUnavailable()),
			),
		);
	// Recorded before the worker starts, so a callback can't beat the record.
	yield* Effect.tryPromise({
		try: () =>
			recordRenderFarmSave(video.id, {
				version: 1,
				exportId,
				jobId: "",
				status: "rendering",
				projectSavedAt: video.metadata?.webEditorProject?.savedAt ?? null,
				startedAt: new Date().toISOString(),
				outputKey: target.outputKey,
				hlsPrefix: target.hlsPrefix,
				worker: { sessionPath },
			}),
		catch: () => new HttpApiError.InternalServerError(),
	});
	const withdraw = Effect.promise(() =>
		withdrawRenderFarmSave(video.id, exportId).catch(() => undefined),
	);
	const started = yield* requestMediaEditor(`${sessionPath}/saves`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			settings: workerSaveSettings(video.fps),
			uploadUrl,
			callbackUrl: workerSaveCallbackUrl(
				origin,
				process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
			),
			videoId: video.id,
			saveId: exportId,
		}),
	}).pipe(Effect.tapError(() => withdraw));
	const body: unknown = started.ok
		? yield* Effect.tryPromise({
				try: () => started.json(),
				catch: () => new HttpApiError.ServiceUnavailable(),
			}).pipe(Effect.tapError(() => withdraw))
		: null;
	const workerExportId =
		typeof body === "object" &&
		body !== null &&
		"id" in body &&
		typeof body.id === "string"
			? body.id
			: null;
	if (!workerExportId) {
		yield* withdraw;
		return yield* new HttpApiError.ServiceUnavailable();
	}
	yield* Effect.promise(() =>
		attachRenderFarmJob(
			video.id,
			exportId,
			`${WORKER_SAVE_JOB_PREFIX}${workerExportId}`,
		),
	);
	console.info(`[workerSave] ${video.id} rendering on ${sessionPath}`);
	return { exportId, shareUrl: `${origin}/s/${video.id}` };
});

/** A worker Save's state, from the worker that renders it. */
export const fetchWorkerSave = Effect.fn("fetchWorkerSave")(function* (
	save: RenderFarmSave,
) {
	const exportId = workerSaveExportId(save);
	if (!exportId || !save.worker) return null;
	const response = yield* requestMediaEditor(
		`${save.worker.sessionPath}/saves/${encodeURIComponent(exportId)}`,
	).pipe(Effect.catchAll(() => Effect.succeed(null)));
	if (!response) return null;
	if (response.status === 404) return "gone" as const;
	if (!response.ok) return null;
	const body: unknown = yield* Effect.tryPromise(() => response.json()).pipe(
		Effect.catchAll(() => Effect.succeed(null)),
	);
	return parseWorkerSaveState(body);
});
