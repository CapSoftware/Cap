import { randomUUID } from "node:crypto";
import { videoEdits, type videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Database, Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { HttpApiError } from "@effect/platform";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import type { EditorDefaultStyle } from "@/lib/editor-default-style";
import { loadEligibleEditorVideo } from "@/lib/editor-session";
import {
	type RenderFarmJobKind,
	renderFarmCallbackUrl,
	renderFarmConfig,
	renderFarmFetch,
	renderFarmKeys,
	renderFarmReference,
	renderFarmTranscodeKey,
} from "@/lib/render-farm";
import { planDirectRender } from "@/lib/render-farm-direct";
import {
	parseRenderFarmPrepareSupport,
	type RenderFarmPrepareSupport,
} from "@/lib/render-farm-direct-plan";
import { recordRenderFarmSave } from "@/lib/render-farm-records";
import { renderFarmSaveIsCurrent } from "@/lib/render-farm-status";
import { PRO_DURATION_SECONDS } from "@/lib/render-recording-eligibility";
import {
	SHARE_RENDER_COMPRESSION,
	SHARE_RENDER_RESOLUTION,
	type ShareRenderCompression,
	shareRenderFps,
} from "@/lib/share-render";
import type * as StudioSound from "@/lib/studio-sound";
import { decodeStorageVideo } from "@/lib/video-storage";

type DbVideo = typeof videos.$inferSelect;

export type RenderFarmJobSettings = {
	resolution: [number, number];
	fps: number;
	compression: ShareRenderCompression;
};

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const mainSourceKeys = Effect.fn("renderFarmMainSourceKeys")(function* (
	video: DbVideo,
) {
	const database = yield* Database;
	const [legacyEdit] = yield* database.use((client) =>
		client
			.select({ sourceKey: videoEdits.sourceKey })
			.from(videoEdits)
			.where(eq(videoEdits.videoId, video.id)),
	);
	const sources = video.metadata?.editorSources;
	if (legacyEdit || !sources || sources.version !== 1) {
		return {
			display:
				legacyEdit?.sourceKey ?? `${video.ownerId}/${video.id}/result.mp4`,
		};
	}
	return {
		display: sources.display.key,
		camera: sources.camera?.key,
		mic: sources.mic?.key,
		systemAudio: sources.systemAudio?.key,
	};
});

export function canSaveEditorVideo(video: {
	duration: number | null;
	captionsEnabled: boolean;
}) {
	return (video.duration ?? 0) < PRO_DURATION_SECONDS || video.captionsEnabled;
}

const FARM_HEALTH_TTL_MS = 30_000;

type RenderFarmHealth = {
	healthy: boolean;
	prepare: RenderFarmPrepareSupport | null;
};

let farmHealth: {
	checkedAt: number;
	health: Promise<RenderFarmHealth>;
} | null = null;

function renderFarmHealth(
	config: NonNullable<ReturnType<typeof renderFarmConfig>>,
) {
	if (farmHealth && Date.now() - farmHealth.checkedAt < FARM_HEALTH_TTL_MS) {
		return farmHealth.health;
	}
	const health = renderFarmFetch(config, "/health", {
		signal: AbortSignal.timeout(3_000),
	})
		.then(async (response): Promise<RenderFarmHealth> => {
			const body: unknown = await response.json().catch(() => null);
			const healthy =
				response.ok &&
				asRecord(body) &&
				typeof body.workers === "number" &&
				body.workers > 0;
			return {
				healthy,
				prepare:
					healthy && asRecord(body)
						? parseRenderFarmPrepareSupport(body.prepare)
						: null,
			};
		})
		.catch(() => ({ healthy: false, prepare: null }));
	farmHealth = { checkedAt: Date.now(), health };
	return health;
}

export async function renderFarmPrepareSupport() {
	const config = renderFarmConfig();
	if (!config?.callbackSecret) return null;
	const health = await renderFarmHealth(config);
	return health.healthy ? health.prepare : null;
}

export async function renderFarmSaveUnavailable() {
	const config = renderFarmConfig();
	if (!config?.callbackSecret) return "The render farm is not configured";
	const health = await renderFarmHealth(config);
	if (!health.healthy) return "The render farm is not responding";
	if (!health.prepare) return "The render farm can't prepare projects";
	return null;
}

/// The row's fps is rewritten by every upload and publish, so the rate comes
/// from the recorded sources, as it does for the browser Save.
export function shareRenderSettings(
	video: Pick<DbVideo, "fps" | "metadata">,
): RenderFarmJobSettings {
	const sources = video.metadata?.editorSources;
	return {
		resolution: SHARE_RENDER_RESOLUTION,
		fps: shareRenderFps(
			sources?.display.fps ?? video.fps,
			sources?.camera?.fps,
		),
		compression: SHARE_RENDER_COMPRESSION,
	};
}

export async function editorSaveRenderer(directLikely: boolean) {
	const reason = await renderFarmSaveUnavailable();
	if (reason) return { renderer: "browser" as const, reason };
	if (!directLikely) {
		return {
			renderer: "browser" as const,
			reason: "The render farm can't prepare this project",
		};
	}
	return { renderer: "farm" as const, reason: null };
}

export const startRenderFarmSave = Effect.fn("startRenderFarmSave")(function* (
	videoId: Video.VideoId,
	origin: string,
) {
	const video = yield* loadEligibleEditorVideo(videoId);
	if (!canSaveEditorVideo(video)) return yield* new HttpApiError.Forbidden();
	if (renderFarmSaveIsCurrent(video.metadata)) {
		return yield* new HttpApiError.Conflict();
	}
	const support = yield* Effect.promise(renderFarmPrepareSupport);
	if (!support) return yield* new HttpApiError.ServiceUnavailable();
	const started = yield* startRenderFarmJobDirect({
		video,
		origin,
		kind: "save",
		support,
	});
	if ("unsupported" in started) {
		console.info(
			`[renderFarm] save ${video.id} renders in the browser: ${started.unsupported}`,
		);
		return yield* new HttpApiError.ServiceUnavailable();
	}
	const recorded = yield* Effect.tryPromise({
		try: () =>
			recordRenderFarmSave(
				video.id,
				video.metadata?.renderFarmSave?.exportId ?? null,
				{
					version: 1,
					exportId: started.exportId,
					jobId: started.jobId,
					status: "rendering",
					projectSavedAt: video.metadata?.webEditorProject?.savedAt ?? null,
					startedAt: new Date().toISOString(),
					outputKey: started.target.outputKey,
					hlsPrefix: started.target.hlsPrefix,
				},
			),
		catch: () => new HttpApiError.InternalServerError(),
	});
	if (!recorded) return yield* new HttpApiError.Conflict();
	return {
		exportId: started.exportId,
		jobId: started.jobId,
		shareUrl: `${origin}/s/${video.id}`,
	};
});

export function renderFarmJobRequest({
	target,
	callbackUrl,
	reference,
	settings,
}: {
	target: ReturnType<typeof renderFarmKeys>;
	callbackUrl: string;
	reference: string;
	settings: RenderFarmJobSettings;
}) {
	return {
		recording: target.recording,
		sourceRoot: target.root,
		output: { key: target.outputKey, hlsPrefix: target.hlsPrefix },
		callbackUrl,
		reference,
		resolution: settings.resolution,
		fps: settings.fps,
		compression: settings.compression,
		prepare: "prepare.json",
	};
}

const postRenderFarmJob = Effect.fn("postRenderFarmJob")(function* ({
	config,
	video,
	target,
	kind,
	origin,
	settings,
}: {
	config: NonNullable<ReturnType<typeof renderFarmConfig>>;
	video: DbVideo;
	target: ReturnType<typeof renderFarmKeys>;
	kind: RenderFarmJobKind;
	origin: string;
	settings?: RenderFarmJobSettings;
}) {
	const jobSettings = settings ?? shareRenderSettings(video);
	const jobResponse = yield* Effect.tryPromise({
		try: () =>
			renderFarmFetch(config, "/jobs", {
				method: "POST",
				body: JSON.stringify(
					renderFarmJobRequest({
						target,
						callbackUrl: renderFarmCallbackUrl(
							origin,
							process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
						),
						reference: renderFarmReference(kind, video.id),
						settings: jobSettings,
					}),
				),
			}),
		catch: () => new HttpApiError.ServiceUnavailable(),
	});
	const job: unknown = yield* Effect.tryPromise({
		try: () => jobResponse.json() as Promise<unknown>,
		catch: () => new HttpApiError.ServiceUnavailable(),
	});
	if (!jobResponse.ok || !asRecord(job) || typeof job.id !== "string") {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	return { jobId: job.id, settings: jobSettings };
});

async function displayHasAudio(url: string) {
	const { ALL_FORMATS, Input, UrlSource } = await import("mediabunny");
	const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url) });
	try {
		return (await input.getAudioTracks()).length > 0;
	} finally {
		input.dispose();
	}
}

export const startRenderFarmJobDirect = Effect.fn("startRenderFarmJobDirect")(
	function* ({
		video,
		origin,
		kind,
		support,
		exportId = randomUUID(),
		settings,
	}: {
		video: DbVideo & {
			captionsEnabled: boolean;
			defaultStyle?: EditorDefaultStyle | null;
			audioDefault?: StudioSound.Preference | null;
		};
		origin: string;
		kind: RenderFarmJobKind;
		support: RenderFarmPrepareSupport;
		exportId?: string;
		settings?: RenderFarmJobSettings;
	}) {
		const config = renderFarmConfig();
		if (!config?.callbackSecret) {
			return yield* new HttpApiError.ServiceUnavailable();
		}
		const [storage] = yield* Storage.getAccessForVideo(
			decodeStorageVideo(video),
			{ resolvePublishedOutput: false },
		).pipe(
			Effect.catchTag("StorageError", () =>
				Effect.fail(new HttpApiError.ServiceUnavailable()),
			),
		);
		if (
			storage.provider !== "s3" ||
			storage.bucketName !== serverEnv().CAP_AWS_BUCKET
		) {
			return { unsupported: "The recording is not in Cap's storage" } as const;
		}
		const target = renderFarmKeys(video.ownerId, video.id, exportId);
		const planned = yield* planDirectRender(
			video,
			target,
			support,
			displayHasAudio,
		);
		if ("unsupported" in planned) return planned;
		yield* Effect.all(
			[
				storage.putObject(
					`${target.recording}/prepare.json`,
					JSON.stringify(planned.prepare),
					{ contentType: "application/json" },
				),
				storage.putObject(
					`${target.recording}/manifest.json`,
					JSON.stringify({ files: planned.entries }),
					{ contentType: "application/json" },
				),
			],
			{ concurrency: 2 },
		).pipe(
			Effect.catchTag("StorageError", () =>
				Effect.fail(new HttpApiError.ServiceUnavailable()),
			),
		);
		const started = yield* postRenderFarmJob({
			config,
			video,
			target,
			kind,
			origin,
			settings,
		});
		return {
			exportId,
			...started,
			target,
			projectConfig: planned.config,
		};
	},
);

export const prewarmRenderFarmSource = Effect.fn("prewarmRenderFarmSource")(
	function* (video: Video.Video, key: string) {
		const config = renderFarmConfig();
		if (!config) return;
		const [storage] = yield* Storage.getAccessForVideo(video, {
			resolvePublishedOutput: false,
		});
		if (
			storage.provider !== "s3" ||
			storage.bucketName !== serverEnv().CAP_AWS_BUCKET
		) {
			return;
		}
		const head = yield* storage.headObject(key);
		if (!head.ETag) return;
		const root = `${video.ownerId}/${video.id}/`;
		yield* Effect.tryPromise(() =>
			renderFarmFetch(config, "/transcodes", {
				method: "POST",
				body: JSON.stringify({
					sourceRoot: root,
					source: key,
					output: renderFarmTranscodeKey(root, key, head.ETag as string),
				}),
			}),
		);
	},
);

export const prewarmRenderFarmSources = Effect.fn("prewarmRenderFarmSources")(
	function* (video: DbVideo) {
		if (!renderFarmConfig()) return;
		const keys = yield* mainSourceKeys(video);
		for (const key of [keys.display, keys.camera]) {
			if (key) {
				yield* prewarmRenderFarmSource(decodeStorageVideo(video), key).pipe(
					Effect.ignore,
				);
			}
		}
	},
);
