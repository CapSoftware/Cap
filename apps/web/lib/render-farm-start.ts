import { randomUUID } from "node:crypto";
import { videoEdits, type videos } from "@cap/database/schema";
import {
	applyDefaultStyle,
	type EditorDefaultStyle,
} from "@cap/editor-cap-bundle/default-style";
import { serverEnv } from "@cap/env";
import { Database, Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { HttpApiError } from "@effect/platform";
import { eq } from "drizzle-orm";
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
import { parseEditorWorkerPool } from "@/lib/editor-worker-routing";
import {
	type RenderFarmJobKind,
	renderFarmCallbackUrl,
	renderFarmConfig,
	renderFarmFetch,
	renderFarmKeys,
	renderFarmReference,
	renderFarmTranscodeKey,
} from "@/lib/render-farm";
import {
	buildRenderProject,
	finishRenderManifest,
	RenderProjectError,
	type RenderProjectFile,
	type RenderProjectSource,
} from "@/lib/render-farm-project";
import {
	recordRenderFarmExport,
	recordRenderFarmSave,
} from "@/lib/render-farm-records";
import { renderExportFileName } from "@/lib/render-farm-status";
import { PRO_DURATION_SECONDS } from "@/lib/render-recording-eligibility";
import { decodeStorageVideo } from "@/lib/video-storage";

type DbVideo = typeof videos.$inferSelect;

export type RenderFarmCompression = "Maximum" | "Social" | "Web" | "Potato";

export type RenderFarmJobSettings = {
	resolution: [number, number];
	fps: number;
	compression: RenderFarmCompression;
};

const UPLOAD_URL_TTL_SECONDS = 30 * 60;
const WORKER_UPLOAD_TIMEOUT_MS = 4 * 60 * 1000;
const SAVE_RESOLUTION: [number, number] = [1920, 1080];

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mediaPath(segment: unknown, field: string) {
	if (!asRecord(segment)) return null;
	const media = segment[field];
	return asRecord(media) && typeof media.path === "string" ? media.path : null;
}

function parseListing(value: unknown) {
	if (
		!asRecord(value) ||
		!Array.isArray(value.files) ||
		!asRecord(value.recordingMeta)
	) {
		return null;
	}
	const files: RenderProjectFile[] = [];
	for (const file of value.files) {
		if (
			!asRecord(file) ||
			typeof file.path !== "string" ||
			typeof file.inode !== "string" ||
			typeof file.size !== "number" ||
			!Number.isSafeInteger(file.size) ||
			file.size < 0
		) {
			return null;
		}
		files.push({ path: file.path, size: file.size, inode: file.inode });
	}
	return { files, recordingMeta: value.recordingMeta };
}

function parseUploaded(value: unknown) {
	if (
		!asRecord(value) ||
		!Array.isArray(value.files) ||
		!Array.isArray(value.wallpapers)
	) {
		return null;
	}
	const sizes = new Map<string, number>();
	for (const [list, name, prefix] of [
		[value.files, "path", ""],
		[value.wallpapers, "file", "assets/backgrounds/"],
	] as const) {
		for (const item of list) {
			if (
				!asRecord(item) ||
				typeof item[name] !== "string" ||
				typeof item.size !== "number" ||
				!Number.isSafeInteger(item.size)
			) {
				return null;
			}
			sizes.set(`${prefix}${item[name]}`, item.size);
		}
	}
	return sizes;
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

/** Saving recordings of five minutes or longer needs Cap Pro. */
export function canSaveEditorVideo(video: {
	duration: number | null;
	captionsEnabled: boolean;
}) {
	return (video.duration ?? 0) < PRO_DURATION_SECONDS || video.captionsEnabled;
}

const FARM_HEALTH_TTL_MS = 30_000;
let farmHealth: { checkedAt: number; healthy: Promise<boolean> } | null = null;

function renderFarmHealthy(
	config: NonNullable<ReturnType<typeof renderFarmConfig>>,
) {
	if (farmHealth && Date.now() - farmHealth.checkedAt < FARM_HEALTH_TTL_MS) {
		return farmHealth.healthy;
	}
	const healthy = renderFarmFetch(config, "/health", {
		signal: AbortSignal.timeout(3_000),
	})
		.then(async (response) => {
			const body: unknown = await response.json().catch(() => null);
			return (
				response.ok &&
				asRecord(body) &&
				typeof body.workers === "number" &&
				body.workers > 0
			);
		})
		.catch(() => false);
	farmHealth = { checkedAt: Date.now(), healthy };
	return healthy;
}

/**
 * Why Save can't render on the farm right now, or null when it can. The
 * editor renders in the browser instead of waiting on a farm that is not
 * there.
 */
export async function renderFarmSaveUnavailable() {
	const config = renderFarmConfig();
	if (!config?.callbackSecret) return "The render farm is not configured";
	const env = serverEnv();
	let workers = 0;
	try {
		workers = parseEditorWorkerPool(
			env.CAP_WEB_EDITOR_WORKER_POOL,
			env.CAP_WEB_EDITOR_WORKER_URL,
		).length;
	} catch {}
	if (!env.MEDIA_SERVER_WEBHOOK_SECRET || workers === 0) {
		return "No editor worker is configured";
	}
	if (!(await renderFarmHealthy(config))) {
		return "The render farm is not responding";
	}
	return null;
}

export const startRenderFarmSave = Effect.fn("startRenderFarmSave")(function* (
	videoId: Video.VideoId,
	sessionId: string,
	origin: string,
) {
	const [sessionPath, video] = yield* Effect.all(
		[
			verifyOwnedEditorSession(videoId, sessionId),
			loadEligibleEditorVideo(videoId),
		],
		{ concurrency: 2 },
	);
	if (!canSaveEditorVideo(video)) return yield* new HttpApiError.Forbidden();
	const started = yield* startRenderFarmJob({
		video,
		sessionPath,
		origin,
		kind: "save",
	});
	yield* Effect.tryPromise({
		try: () =>
			recordRenderFarmSave(video.id, {
				version: 1,
				exportId: started.exportId,
				jobId: started.jobId,
				status: "rendering",
				startedAt: new Date().toISOString(),
				outputKey: started.target.outputKey,
				hlsPrefix: started.target.hlsPrefix,
			}),
		catch: () => new HttpApiError.InternalServerError(),
	});
	return {
		exportId: started.exportId,
		jobId: started.jobId,
		shareUrl: `${origin}/s/${video.id}`,
	};
});

/**
 * Renders the editor's current project with the chosen export settings into
 * a separate download, leaving the share link's video untouched.
 */
export const startRenderFarmExport = Effect.fn("startRenderFarmExport")(
	function* (
		videoId: Video.VideoId,
		sessionId: string,
		origin: string,
		settings: RenderFarmJobSettings,
	) {
		const sessionPath = yield* verifyOwnedEditorSession(videoId, sessionId);
		const video = yield* loadEligibleEditorVideo(videoId);
		if (
			(video.duration ?? 0) >= PRO_DURATION_SECONDS &&
			!video.captionsEnabled
		) {
			return yield* new HttpApiError.Forbidden();
		}
		const started = yield* startRenderFarmJob({
			video,
			sessionPath,
			origin,
			kind: "export",
			settings,
		});
		yield* Effect.tryPromise({
			try: () =>
				recordRenderFarmExport(video.id, {
					exportId: started.exportId,
					jobId: started.jobId,
					status: "rendering",
					startedAt: new Date().toISOString(),
					outputKey: started.target.outputKey,
					fileName: renderExportFileName(video.name),
					resolution: started.settings.resolution,
					fps: started.settings.fps,
				}),
			catch: () => new HttpApiError.InternalServerError(),
		});
		return {
			exportId: started.exportId,
			downloadUrl: `${origin}/s/${video.id}/download?export=${encodeURIComponent(started.exportId)}`,
		};
	},
);

/**
 * Builds a render project from a prepared editor worker session and starts
 * a render-farm job for it. The caller records what the job is for.
 */
export const startRenderFarmJob = Effect.fn("startRenderFarmJob")(function* ({
	video,
	sessionPath,
	origin,
	kind,
	exportId = randomUUID(),
	settings,
}: {
	video: DbVideo & {
		captionsEnabled: boolean;
		defaultStyle?: EditorDefaultStyle | null;
	};
	sessionPath: string;
	origin: string;
	kind: RenderFarmJobKind;
	exportId?: string;
	settings?: RenderFarmJobSettings;
}) {
	const config = renderFarmConfig();
	if (!config?.callbackSecret) {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	const [storage] = yield* Storage.getAccessForVideo(
		decodeStorageVideo(video),
		{
			resolvePublishedOutput: false,
		},
	).pipe(
		Effect.catchTag("StorageError", () =>
			Effect.fail(new HttpApiError.ServiceUnavailable()),
		),
	);
	if (
		storage.provider !== "s3" ||
		storage.bucketName !== serverEnv().CAP_AWS_BUCKET
	) {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	const readJson = (response: Response) =>
		Effect.tryPromise({
			try: () => response.json() as Promise<unknown>,
			catch: () => new HttpApiError.ServiceUnavailable(),
		});
	// The worker may have been prepared before the latest edits, so it gets
	// the stored project first rather than being prepared again.
	const savedProject = video.metadata?.webEditorProject
		? decodeWebEditorProject(video.metadata.webEditorProject)
		: null;
	const syncProject = Effect.gen(function* () {
		if (!savedProject) return;
		const synced = yield* requestMediaEditor(`${sessionPath}/config`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(
				video.captionsEnabled
					? savedProject
					: stripEditorCaptionContent(savedProject),
			),
		});
		if (synced.status !== 204) {
			return yield* new HttpApiError.ServiceUnavailable();
		}
	});
	const [listingResponse, configResponse, keys] = yield* Effect.all(
		[
			requestMediaEditor(`${sessionPath}/render-project`),
			syncProject.pipe(
				Effect.andThen(requestMediaEditor(`${sessionPath}/config`)),
			),
			mainSourceKeys(video).pipe(
				Effect.catchTag("DatabaseError", () =>
					Effect.fail(new HttpApiError.InternalServerError()),
				),
			),
		],
		{ concurrency: "unbounded" },
	);
	if (!listingResponse.ok || !configResponse.ok) {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	const [listingJson, sessionConfig] = yield* Effect.all(
		[readJson(listingResponse), readJson(configResponse)],
		{ concurrency: 2 },
	);
	const listing = parseListing(listingJson);
	if (!listing || !asRecord(sessionConfig)) {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	// A project nobody has edited yet is shown with the owner's saved style
	// (see getSignedEditorSources), so it renders with it too.
	const projectConfig =
		!video.metadata?.webEditorProject && video.defaultStyle
			? applyDefaultStyle(sessionConfig, video.defaultStyle)
			: sessionConfig;
	if (!video.captionsEnabled && hasEditorCaptionContent(projectConfig)) {
		return yield* new HttpApiError.Forbidden();
	}

	const firstSegment = Array.isArray(listing.recordingMeta.segments)
		? listing.recordingMeta.segments[0]
		: undefined;
	const mainPaths = [
		[mediaPath(firstSegment, "display"), keys.display],
		[mediaPath(firstSegment, "camera"), keys.camera],
		[mediaPath(firstSegment, "mic"), keys.mic],
		[mediaPath(firstSegment, "system_audio"), keys.systemAudio],
	].filter((pair): pair is [string, string] => !!pair[0] && !!pair[1]);
	const heads = yield* Effect.all(
		mainPaths.map(([, key]) => storage.headObject(key)),
		{ concurrency: 4 },
	).pipe(
		Effect.catchTag("StorageError", () =>
			Effect.fail(new HttpApiError.ServiceUnavailable()),
		),
	);
	const sources = new Map<string, RenderProjectSource>();
	mainPaths.forEach(([path, key], index) => {
		const head = heads[index];
		if (head?.ContentLength && head.ETag) {
			sources.set(path, { key, size: head.ContentLength, identity: head.ETag });
		}
	});
	for (const asset of [
		...(video.metadata?.webEditorAssets?.items ?? []),
		...(video.metadata?.webEditorVideos?.items ?? []),
	]) {
		if (asset.key.startsWith(`${video.ownerId}/${video.id}/`)) {
			sources.set(asset.path, {
				key: asset.key,
				size: asset.size,
				identity: asset.objectIdentity ?? `size:${asset.size}`,
			});
		}
	}

	const target = renderFarmKeys(
		video.ownerId,
		video.id,
		exportId,
		kind === "export" ? "export" : "result",
	);
	const plan = yield* Effect.try({
		try: () =>
			buildRenderProject({
				root: target.root,
				recording: target.recording,
				files: listing.files,
				recordingMeta: listing.recordingMeta,
				config: projectConfig,
				sources,
			}),
		catch: (error) =>
			error instanceof RenderProjectError
				? new HttpApiError.BadRequest()
				: new HttpApiError.ServiceUnavailable(),
	});

	const signPut = (key: string) =>
		storage
			.getInternalPresignedPutUrl(key, undefined, {
				expiresIn: UPLOAD_URL_TTL_SECONDS,
			})
			.pipe(
				Effect.catchTag("StorageError", () =>
					Effect.fail(new HttpApiError.ServiceUnavailable()),
				),
			);
	const fileUploads = yield* Effect.all(
		plan.uploads.map((path) =>
			signPut(`${target.recording}/${path}`).pipe(
				Effect.map((url) => ({ path, url })),
			),
		),
		{ concurrency: 8 },
	);
	const wallpaperUploads = yield* Effect.all(
		plan.wallpapers.map((file) =>
			signPut(`${target.recording}/assets/backgrounds/${file}`).pipe(
				Effect.map((url) => ({ file, url })),
			),
		),
		{ concurrency: 8 },
	);
	const uploadResponse = yield* requestMediaEditor(
		`${sessionPath}/render-project/uploads`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				files: fileUploads,
				wallpapers: wallpaperUploads,
			}),
		},
		WORKER_UPLOAD_TIMEOUT_MS,
	);
	if (!uploadResponse.ok) return yield* new HttpApiError.ServiceUnavailable();
	const uploaded = parseUploaded(yield* readJson(uploadResponse));
	if (!uploaded) return yield* new HttpApiError.ServiceUnavailable();

	const recordingMeta = JSON.stringify(plan.recordingMeta);
	const renderConfig = JSON.stringify(plan.config);
	const manifest = yield* Effect.try({
		try: () =>
			finishRenderManifest(plan, uploaded, [
				{
					path: "recording-meta.json",
					size: Buffer.byteLength(recordingMeta),
				},
				{
					path: "project-config.json",
					size: Buffer.byteLength(renderConfig),
				},
			]),
		catch: () => new HttpApiError.ServiceUnavailable(),
	});
	yield* Effect.all(
		[
			storage.putObject(
				`${target.recording}/recording-meta.json`,
				recordingMeta,
				{
					contentType: "application/json",
				},
			),
			storage.putObject(
				`${target.recording}/project-config.json`,
				renderConfig,
				{
					contentType: "application/json",
				},
			),
			storage.putObject(
				`${target.recording}/manifest.json`,
				JSON.stringify(manifest),
				{ contentType: "application/json" },
			),
		],
		{ concurrency: 3 },
	).pipe(
		Effect.catchTag("StorageError", () =>
			Effect.fail(new HttpApiError.ServiceUnavailable()),
		),
	);

	const jobSettings: RenderFarmJobSettings = settings ?? {
		resolution: SAVE_RESOLUTION,
		fps: Math.min(60, Math.max(24, Math.round(video.fps ?? 30))),
		compression: "Maximum",
	};
	const jobResponse = yield* Effect.tryPromise({
		try: () =>
			renderFarmFetch(config, "/jobs", {
				method: "POST",
				body: JSON.stringify({
					recording: target.recording,
					sourceRoot: target.root,
					output: { key: target.outputKey, hlsPrefix: target.hlsPrefix },
					callbackUrl: renderFarmCallbackUrl(
						origin,
						process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
					),
					reference: renderFarmReference(kind, video.id),
					resolution: jobSettings.resolution,
					fps: jobSettings.fps,
					compression: jobSettings.compression,
				}),
			}),
		catch: () => new HttpApiError.ServiceUnavailable(),
	});
	const job = yield* readJson(jobResponse);
	if (!jobResponse.ok || !asRecord(job) || typeof job.id !== "string") {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	return {
		exportId,
		jobId: job.id,
		target,
		settings: jobSettings,
		projectConfig,
	};
});

/**
 * Starts the farm transcoding one of a recording's videos, so a later render
 * only waits for the render itself. Best effort.
 */
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

/** Pre-warms a recording's screen and camera videos when its editor opens. */
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
