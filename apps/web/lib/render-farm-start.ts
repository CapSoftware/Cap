import { randomUUID } from "node:crypto";
import { videoEdits, type videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Database, Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { HttpApiError } from "@effect/platform";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { hasEditorCaptionContent } from "@/lib/editor-caption-access";
import {
	loadEligibleEditorVideo,
	requestMediaEditor,
	verifyOwnedEditorSession,
} from "@/lib/editor-session";
import {
	renderFarmConfig,
	renderFarmFetch,
	renderFarmKeys,
	renderFarmTranscodeKey,
} from "@/lib/render-farm";
import {
	buildRenderProject,
	finishRenderManifest,
	RenderProjectError,
	type RenderProjectFile,
	type RenderProjectSource,
} from "@/lib/render-farm-project";
import { recordRenderFarmSave } from "@/lib/render-farm-save";
import { decodeStorageVideo } from "@/lib/video-storage";

type DbVideo = typeof videos.$inferSelect;

const PRO_DURATION_SECONDS = 5 * 60;
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

export const startRenderFarmSave = Effect.fn("startRenderFarmSave")(function* (
	videoId: Video.VideoId,
	sessionId: string,
	origin: string,
) {
	const config = renderFarmConfig();
	if (!config?.callbackSecret) {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	const sessionPath = yield* verifyOwnedEditorSession(videoId, sessionId);
	const video = yield* loadEligibleEditorVideo(videoId);
	if ((video.duration ?? 0) >= PRO_DURATION_SECONDS && !video.captionsEnabled) {
		return yield* new HttpApiError.Forbidden();
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
	const listingResponse = yield* requestMediaEditor(
		`${sessionPath}/render-project`,
	);
	const configResponse = yield* requestMediaEditor(`${sessionPath}/config`);
	if (!listingResponse.ok || !configResponse.ok) {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	const listing = parseListing(yield* readJson(listingResponse));
	const projectConfig = yield* readJson(configResponse);
	if (!listing) return yield* new HttpApiError.ServiceUnavailable();
	if (!video.captionsEnabled && hasEditorCaptionContent(projectConfig)) {
		return yield* new HttpApiError.Forbidden();
	}

	const keys = yield* mainSourceKeys(video).pipe(
		Effect.catchTag("DatabaseError", () =>
			Effect.fail(new HttpApiError.InternalServerError()),
		),
	);
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

	const exportId = randomUUID();
	const target = renderFarmKeys(video.ownerId, video.id, exportId);
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

	const fps = Math.min(60, Math.max(24, Math.round(video.fps ?? 30)));
	const jobResponse = yield* Effect.tryPromise({
		try: () =>
			renderFarmFetch(config, "/jobs", {
				method: "POST",
				body: JSON.stringify({
					recording: target.recording,
					sourceRoot: target.root,
					output: { key: target.outputKey, hlsPrefix: target.hlsPrefix },
					callbackUrl: `${origin}/api/render-farm/callback`,
					reference: video.id,
					resolution: SAVE_RESOLUTION,
					fps,
					compression: "Maximum",
				}),
			}),
		catch: () => new HttpApiError.ServiceUnavailable(),
	});
	const job = yield* readJson(jobResponse);
	if (!jobResponse.ok || !asRecord(job) || typeof job.id !== "string") {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	const jobId = job.id;
	yield* Effect.tryPromise({
		try: () =>
			recordRenderFarmSave(video.id, {
				version: 1,
				exportId,
				jobId,
				status: "rendering",
				startedAt: new Date().toISOString(),
				outputKey: target.outputKey,
				hlsPrefix: target.hlsPrefix,
			}),
		catch: () => new HttpApiError.InternalServerError(),
	});
	return { exportId, jobId, shareUrl: `${origin}/s/${video.id}` };
});

/**
 * Starts transcoding a recording's videos when its editor opens, so a later
 * Save only waits for the render itself. Best effort.
 */
export const prewarmRenderFarmSources = Effect.fn("prewarmRenderFarmSources")(
	function* (video: DbVideo) {
		const config = renderFarmConfig();
		if (!config) return;
		const [storage] = yield* Storage.getAccessForVideo(
			decodeStorageVideo(video),
			{ resolvePublishedOutput: false },
		);
		if (
			storage.provider !== "s3" ||
			storage.bucketName !== serverEnv().CAP_AWS_BUCKET
		) {
			return;
		}
		const keys = yield* mainSourceKeys(video);
		const root = `${video.ownerId}/${video.id}/`;
		for (const key of [keys.display, keys.camera]) {
			if (!key) continue;
			const head = yield* storage.headObject(key);
			if (!head.ETag) continue;
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
		}
	},
);
