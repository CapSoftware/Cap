import { users, videoEdits, videos, videoUploads } from "@cap/database/schema";
import type { VideoEditSpec } from "@cap/database/types";
import { CAP_BUNDLE_CONTENT_TYPE } from "@cap/editor-cap-bundle";
import { serverEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";
import { Database, Storage } from "@cap/web-backend";
import { getRecordingObjectIdentity } from "@cap/web-backend/src/Storage/recording-object-identity";
import { CurrentUser, type Video } from "@cap/web-domain";
import { HttpApiError } from "@effect/platform";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { stripEditorCaptionContent } from "./editor-caption-access";
import { MAX_WEB_EDITOR_CLIPS, validWebEditorClip } from "./editor-clips";
import { normalizeWebEditorImportOrder } from "./editor-imports";
import { decodeWebEditorProject } from "./editor-project-storage";
import {
	MAX_EDITOR_VIDEO_BYTES,
	MAX_EDITOR_VIDEO_COUNT,
	validEditorVideoAsset,
} from "./editor-video-upload";
import {
	editorWorkerForRequest,
	parseEditorWorkerPool,
} from "./editor-worker-routing";
import { getEditSourceKey } from "./video-edit-processing";
import { decodeStorageVideo } from "./video-storage";

const MAX_SOURCE_BYTES = 12 * 1024 * 1024 * 1024;
const SOURCE_URL_TTL_SECONDS = 20 * 60;
const AUDIO_ASSET_PATH =
	/^assets\/audio\/import-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(ogg|m4a|mp3|wav|aac|flac)$/;
const IMAGE_ASSET_PATH =
	/^content\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif|bmp|tiff)$/;
const AUDIO_ASSET_TYPES: Record<string, string> = {
	ogg: "audio/ogg",
	m4a: "audio/mp4",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	aac: "audio/aac",
	flac: "audio/flac",
};
const IMAGE_ASSET_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
	tiff: "image/tiff",
};

type DbVideo = typeof videos.$inferSelect;
type EditorSource = NonNullable<DbVideo["metadata"]>["editorSources"];

export function isActiveEditorReplacementUpload(
	ownerId: string,
	videoId: string,
	phase: string | null,
	key: string | null,
) {
	if (phase !== "uploading" || !key) return false;
	const prefix = `${ownerId}/${videoId}/.recording/outputs/reupload-`;
	return (
		key.startsWith(prefix) &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/result\.mp4$/.test(
			key.slice(prefix.length),
		)
	);
}

export const loadEligibleEditorVideo = Effect.fn("loadEligibleEditorVideo")(
	function* (
		videoId: Video.VideoId,
		allowReplacementUpload = false,
		requirePro = false,
	) {
		const currentUser = yield* CurrentUser;
		const database = yield* Database;
		const [record] = yield* database
			.use((client) =>
				client
					.select({
						video: videos,
						owner: users,
						uploadPhase: videoUploads.phase,
						uploadKey: videoUploads.rawFileKey,
					})
					.from(videos)
					.innerJoin(users, eq(videos.ownerId, users.id))
					.leftJoin(videoUploads, eq(videos.id, videoUploads.videoId))
					.where(eq(videos.id, videoId)),
			)
			.pipe(
				Effect.catchTag("DatabaseError", () =>
					Effect.fail(new HttpApiError.InternalServerError()),
				),
			);
		const replacementUpload =
			allowReplacementUpload &&
			!!record &&
			isActiveEditorReplacementUpload(
				record.video.ownerId,
				record.video.id,
				record.uploadPhase,
				record.uploadKey,
			);
		if (
			!record ||
			record.video.ownerId !== currentUser.id ||
			record.video.isScreenshot ||
			(record.video.source.type !== "desktopMP4" &&
				record.video.source.type !== "webMP4") ||
			!record.video.duration ||
			record.video.duration <= 0 ||
			record.video.metadata?.editProcessing ||
			(record.uploadPhase &&
				["uploading", "processing", "generating_thumbnail"].includes(
					record.uploadPhase,
				) &&
				!replacementUpload)
		) {
			return yield* new HttpApiError.NotFound();
		}
		const captionsEnabled = userIsPro(record.owner);
		if (requirePro && !captionsEnabled) {
			return yield* new HttpApiError.Forbidden();
		}
		return { ...record.video, captionsEnabled };
	},
);

export const verifyOwnedEditorSession = Effect.fn("verifyOwnedEditorSession")(
	function* (videoId: Video.VideoId, sessionId: string) {
		const video = yield* loadEligibleEditorVideo(videoId, true);
		const path = `/editor/sessions/${encodeURIComponent(sessionId)}`;
		const identity = yield* requestMediaEditor(path);
		if (identity.status === 404) return yield* new HttpApiError.NotFound();
		if (!identity.ok) return yield* new HttpApiError.ServiceUnavailable();
		const data: unknown = yield* Effect.tryPromise({
			try: () => identity.json(),
			catch: () => new HttpApiError.ServiceUnavailable(),
		});
		if (
			typeof data !== "object" ||
			data === null ||
			!("videoId" in data) ||
			data.videoId !== video.id
		) {
			return yield* new HttpApiError.NotFound();
		}
		return path;
	},
);

function validSource(
	source: { key: string; size?: number; contentType: string },
	video: DbVideo,
) {
	return (
		source.key.startsWith(`${video.ownerId}/${video.id}/`) &&
		Number.isSafeInteger(source.size) &&
		source.size !== undefined &&
		source.size > 0 &&
		source.size <= MAX_SOURCE_BYTES &&
		(source.contentType === "video/webm" || source.contentType === "video/mp4")
	);
}

function validAudioSource(
	source: {
		key: string;
		size: number;
		contentType: string;
		offsetMs: number;
	},
	video: DbVideo,
	kind: "mic" | "system-audio",
) {
	const extension =
		source.contentType === "audio/webm"
			? "webm"
			: source.contentType === "audio/mp4"
				? "mp4"
				: null;
	return (
		extension !== null &&
		source.key === `${video.ownerId}/${video.id}/${kind}-upload.${extension}` &&
		Number.isSafeInteger(source.size) &&
		source.size > 0 &&
		source.size <= MAX_SOURCE_BYTES &&
		Number.isSafeInteger(source.offsetMs) &&
		Math.abs(source.offsetMs) <= 30_000
	);
}

function validSavedAsset(asset: unknown, video: DbVideo) {
	if (typeof asset !== "object" || asset === null) return false;
	if (!("path" in asset) || typeof asset.path !== "string") return false;
	if (!("kind" in asset)) return false;
	const kind = asset.kind;
	if (kind !== "audio" && kind !== "image") return false;
	const match =
		kind === "audio"
			? AUDIO_ASSET_PATH.exec(asset.path)
			: IMAGE_ASSET_PATH.exec(asset.path);
	if (!match) return false;
	const key =
		kind === "audio"
			? `${video.ownerId}/${video.id}/editor-assets/${asset.path.slice("assets/audio/".length)}`
			: `${video.ownerId}/${video.id}/editor-assets/images/${asset.path.slice("content/images/".length)}`;
	const types = kind === "audio" ? AUDIO_ASSET_TYPES : IMAGE_ASSET_TYPES;
	return (
		"key" in asset &&
		asset.key === key &&
		"contentType" in asset &&
		asset.contentType === types[match[1] ?? ""] &&
		"size" in asset &&
		typeof asset.size === "number" &&
		Number.isSafeInteger(asset.size) &&
		asset.size >= 1 &&
		asset.size <= (kind === "audio" ? 32 : 64) * 1024 * 1024 &&
		"name" in asset &&
		typeof asset.name === "string" &&
		asset.name.length >= 1 &&
		asset.name.length <= 100 &&
		!asset.name
			.split("")
			.some(
				(character) =>
					character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
			) &&
		"objectIdentity" in asset &&
		(asset.objectIdentity === null ||
			(typeof asset.objectIdentity === "string" &&
				asset.objectIdentity.length >= 1 &&
				asset.objectIdentity.length <= 256))
	);
}

export const getSignedEditorSources = Effect.fn("getSignedEditorSources")(
	function* (video: DbVideo & { captionsEnabled?: boolean }) {
		const database = yield* Database;
		const [legacyEdit] = yield* database
			.use((client) =>
				client
					.select({
						sourceKey: videoEdits.sourceKey,
						editSpec: videoEdits.editSpec,
					})
					.from(videoEdits)
					.where(eq(videoEdits.videoId, video.id)),
			)
			.pipe(
				Effect.catchTag("DatabaseError", () =>
					Effect.fail(new HttpApiError.InternalServerError()),
				),
			);
		if (
			legacyEdit &&
			(legacyEdit.sourceKey !== getEditSourceKey(video.ownerId, video.id) ||
				legacyEdit.editSpec.version !== 1 ||
				!Number.isFinite(legacyEdit.editSpec.sourceDuration) ||
				legacyEdit.editSpec.sourceDuration <= 0)
		) {
			return yield* new HttpApiError.ServiceUnavailable();
		}
		const sources: EditorSource = video.metadata?.editorSources;
		const legacySource =
			legacyEdit !== undefined || sources === undefined || sources === null;
		const displaySource = legacySource
			? {
					key:
						legacyEdit?.sourceKey ?? `${video.ownerId}/${video.id}/result.mp4`,
					contentType: "video/mp4" as const,
					size: undefined,
					objectIdentity: undefined,
					fps: video.fps ?? undefined,
				}
			: sources.display;
		const cameraSource = legacySource ? undefined : sources.camera;
		const micSource = legacySource ? undefined : sources.mic;
		const systemAudioSource = legacySource ? undefined : sources.systemAudio;
		if (
			(!legacySource && sources.version !== 1) ||
			!displaySource ||
			(!legacySource && !validSource(displaySource, video)) ||
			(cameraSource &&
				(!validSource(cameraSource, video) ||
					!Number.isSafeInteger(cameraSource.offsetMs) ||
					Math.abs(cameraSource.offsetMs) > 30_000)) ||
			(micSource && !validAudioSource(micSource, video, "mic")) ||
			(systemAudioSource &&
				!validAudioSource(systemAudioSource, video, "system-audio"))
		) {
			return yield* new HttpApiError.NotFound();
		}
		const savedProject = video.metadata?.webEditorProject;
		const savedAssets = video.metadata?.webEditorAssets;
		const savedVideos = video.metadata?.webEditorVideos;
		const savedClips = video.metadata?.webEditorClips;
		const savedImports = video.metadata?.webEditorImports;
		const restoredProject = savedProject
			? decodeWebEditorProject(savedProject)
			: null;
		if (savedProject && !restoredProject) {
			return yield* new HttpApiError.ServiceUnavailable();
		}
		const assets = savedAssets?.items ?? [];
		const allVideoAssets = savedVideos?.items ?? [];
		const clips = savedClips?.items ?? [];
		if (
			(savedAssets && savedAssets.version !== 1) ||
			!Array.isArray(assets) ||
			assets.length > 100 ||
			assets.some((asset) => !validSavedAsset(asset, video)) ||
			assets.reduce((bytes, asset) => bytes + asset.size, 0) > 512 * 1024 * 1024
		) {
			return yield* new HttpApiError.ServiceUnavailable();
		}
		if (
			(savedVideos && savedVideos.version !== 1) ||
			!Array.isArray(allVideoAssets) ||
			allVideoAssets.length > MAX_EDITOR_VIDEO_COUNT ||
			allVideoAssets.some(
				(asset) => !validEditorVideoAsset(asset, video.ownerId, video.id),
			) ||
			allVideoAssets.reduce((bytes, asset) => bytes + asset.size, 0) >
				MAX_EDITOR_VIDEO_BYTES
		) {
			return yield* new HttpApiError.ServiceUnavailable();
		}
		if (
			(savedClips && savedClips.version !== 1) ||
			!Array.isArray(clips) ||
			clips.length > MAX_WEB_EDITOR_CLIPS ||
			clips.some(
				(clip) =>
					!validWebEditorClip(clip, allVideoAssets, video.ownerId, video.id),
			) ||
			new Set(clips.map((clip) => clip.displayPath)).size !== clips.length
		) {
			return yield* new HttpApiError.ServiceUnavailable();
		}
		const importOrder = normalizeWebEditorImportOrder(
			savedImports,
			clips,
			allVideoAssets,
			video.ownerId,
			video.id,
		);
		if (!importOrder) {
			return yield* new HttpApiError.ServiceUnavailable();
		}
		const capPaths = new Set(
			importOrder.items.flatMap((item) =>
				item.kind === "cap" ? [item.path] : [],
			),
		);
		const videoAssets = allVideoAssets.filter(
			(asset) => asset.contentType !== CAP_BUNDLE_CONTENT_TYPE,
		);
		const importedCapAssets = allVideoAssets.filter((asset) =>
			capPaths.has(asset.path),
		);
		const signedSourceAssets = [...videoAssets, ...importedCapAssets];
		const [storage] = yield* Storage.getAccessForVideo(
			decodeStorageVideo(video),
			{ resolvePublishedOutput: false },
		).pipe(
			Effect.catchTag("StorageError", () =>
				Effect.fail(new HttpApiError.ServiceUnavailable()),
			),
		);
		const [displayHead, cameraHead, micHead, systemAudioHead] =
			yield* Effect.all([
				storage.headObject(displaySource.key),
				cameraSource
					? storage.headObject(cameraSource.key)
					: Effect.succeed(null),
				micSource ? storage.headObject(micSource.key) : Effect.succeed(null),
				systemAudioSource
					? storage.headObject(systemAudioSource.key)
					: Effect.succeed(null),
			]).pipe(
				Effect.catchTag("StorageError", () =>
					Effect.fail(new HttpApiError.ServiceUnavailable()),
				),
			);
		const displayIdentity = getRecordingObjectIdentity(
			displayHead,
			displaySource.objectIdentity ?? undefined,
		);
		const cameraIdentity =
			cameraHead && cameraSource
				? getRecordingObjectIdentity(
						cameraHead,
						cameraSource.objectIdentity ?? undefined,
					)
				: null;
		const micIdentity =
			micHead && micSource
				? getRecordingObjectIdentity(
						micHead,
						micSource.objectIdentity ?? undefined,
					)
				: null;
		const systemAudioIdentity =
			systemAudioHead && systemAudioSource
				? getRecordingObjectIdentity(
						systemAudioHead,
						systemAudioSource.objectIdentity ?? undefined,
					)
				: null;
		const displaySize = legacySource
			? displayHead.ContentLength
			: displaySource.size;
		if (
			!Number.isSafeInteger(displaySize) ||
			displaySize === undefined ||
			displaySize < 1 ||
			displaySize > MAX_SOURCE_BYTES ||
			displayHead.ContentLength !== displaySize ||
			!displayIdentity ||
			(displaySource.objectIdentity &&
				displayIdentity !== displaySource.objectIdentity) ||
			(cameraSource &&
				(cameraHead?.ContentLength !== cameraSource.size ||
					!cameraIdentity ||
					(cameraSource.objectIdentity &&
						cameraIdentity !== cameraSource.objectIdentity))) ||
			(micSource &&
				(micHead?.ContentLength !== micSource.size ||
					!micIdentity ||
					(micSource.objectIdentity &&
						micIdentity !== micSource.objectIdentity))) ||
			(systemAudioSource &&
				(systemAudioHead?.ContentLength !== systemAudioSource.size ||
					!systemAudioIdentity ||
					(systemAudioSource.objectIdentity &&
						systemAudioIdentity !== systemAudioSource.objectIdentity)))
		) {
			return yield* new HttpApiError.ServiceUnavailable();
		}
		const [displayUrl, cameraUrl, micUrl, systemAudioUrl] = yield* Effect.all([
			storage.getInternalSignedObjectUrl(displaySource.key, {
				expiresIn: SOURCE_URL_TTL_SECONDS,
			}),
			cameraSource
				? storage.getInternalSignedObjectUrl(cameraSource.key, {
						expiresIn: SOURCE_URL_TTL_SECONDS,
					})
				: Effect.succeed(null),
			micSource
				? storage.getInternalSignedObjectUrl(micSource.key, {
						expiresIn: SOURCE_URL_TTL_SECONDS,
					})
				: Effect.succeed(null),
			systemAudioSource
				? storage.getInternalSignedObjectUrl(systemAudioSource.key, {
						expiresIn: SOURCE_URL_TTL_SECONDS,
					})
				: Effect.succeed(null),
		]).pipe(
			Effect.catchTag("StorageError", () =>
				Effect.fail(new HttpApiError.ServiceUnavailable()),
			),
		);
		const assetHeads = yield* Effect.all(
			assets.map((asset) => storage.headObject(asset.key)),
			{ concurrency: 4 },
		).pipe(
			Effect.catchTag("StorageError", () =>
				Effect.fail(new HttpApiError.ServiceUnavailable()),
			),
		);
		const signedAssets = yield* Effect.all(
			assets.map((asset, index) => {
				const head = assetHeads[index];
				const identity = head
					? getRecordingObjectIdentity(head, asset.objectIdentity ?? undefined)
					: null;
				if (
					head?.ContentLength !== asset.size ||
					!identity ||
					(asset.objectIdentity && identity !== asset.objectIdentity)
				) {
					return Effect.fail(new HttpApiError.ServiceUnavailable());
				}
				return storage
					.getInternalSignedObjectUrl(asset.key, {
						expiresIn: SOURCE_URL_TTL_SECONDS,
					})
					.pipe(
						Effect.map((url) => ({
							kind: asset.kind,
							path: asset.path,
							name: asset.name,
							size: asset.size,
							contentType: asset.contentType,
							objectIdentity: identity,
							url,
						})),
					);
			}),
			{ concurrency: 4 },
		).pipe(
			Effect.catchTag("StorageError", () =>
				Effect.fail(new HttpApiError.ServiceUnavailable()),
			),
		);
		const videoHeads = yield* Effect.all(
			signedSourceAssets.map((asset) => storage.headObject(asset.key)),
			{ concurrency: 4 },
		).pipe(
			Effect.catchTag("StorageError", () =>
				Effect.fail(new HttpApiError.ServiceUnavailable()),
			),
		);
		const signedImportedAssets = yield* Effect.all(
			signedSourceAssets.map((asset, index) => {
				const head = videoHeads[index];
				const identity = head
					? getRecordingObjectIdentity(head, asset.objectIdentity ?? undefined)
					: null;
				if (
					head?.ContentLength !== asset.size ||
					!identity ||
					(asset.objectIdentity && identity !== asset.objectIdentity)
				) {
					return Effect.fail(new HttpApiError.ServiceUnavailable());
				}
				return storage
					.getInternalSignedObjectUrl(asset.key, {
						expiresIn: SOURCE_URL_TTL_SECONDS,
					})
					.pipe(
						Effect.map((url) => ({
							path: asset.path,
							name: asset.name,
							size: asset.size,
							contentType: asset.contentType,
							objectIdentity: identity,
							url,
						})),
					);
			}),
			{ concurrency: 4 },
		).pipe(
			Effect.catchTag("StorageError", () =>
				Effect.fail(new HttpApiError.ServiceUnavailable()),
			),
		);
		const signedByPath = new Map(
			signedImportedAssets.map((asset) => [asset.path, asset]),
		);
		const orderedImports = importOrder.items.map((item) => {
			if (item.kind === "clip") {
				const clip = clips.find((saved) => saved.displayPath === item.path);
				return clip ? { kind: "clip" as const, clip } : null;
			}
			const asset = signedByPath.get(item.path);
			return asset
				? { kind: "cap" as const, asset, clipCount: item.clipCount }
				: null;
		});
		if (orderedImports.some((item) => item === null)) {
			return yield* new HttpApiError.ServiceUnavailable();
		}
		const signedVideos = signedImportedAssets.filter(
			(asset) => asset.contentType !== CAP_BUNDLE_CONTENT_TYPE,
		);
		const replayClips = importOrder.items.filter(
			(item) => item.kind === "clip",
		);
		const needsOrderedReplay =
			capPaths.size > 0 ||
			replayClips.some(
				(item, index) => item.path !== clips[index]?.displayPath,
			);
		const captionsEnabled = video.captionsEnabled === true;
		return {
			videoId: video.id,
			captionsEnabled,
			title: video.name?.slice(0, 255) || "Recording",
			display: {
				url: displayUrl,
				contentType: displaySource.contentType,
				size: displaySize,
				fps: displaySource.fps ?? video.fps ?? undefined,
				objectIdentity: displayIdentity,
			},
			...(cameraSource && cameraUrl && cameraIdentity
				? {
						camera: {
							url: cameraUrl,
							contentType: cameraSource.contentType,
							size: cameraSource.size,
							fps: cameraSource.fps,
							objectIdentity: cameraIdentity,
							offsetMs: cameraSource.offsetMs,
						},
					}
				: {}),
			...(micSource && micUrl && micIdentity
				? {
						mic: {
							url: micUrl,
							contentType: micSource.contentType,
							size: micSource.size,
							objectIdentity: micIdentity,
							offsetMs: micSource.offsetMs,
						},
					}
				: {}),
			...(systemAudioSource && systemAudioUrl && systemAudioIdentity
				? {
						systemAudio: {
							url: systemAudioUrl,
							contentType: systemAudioSource.contentType,
							size: systemAudioSource.size,
							objectIdentity: systemAudioIdentity,
							offsetMs: systemAudioSource.offsetMs,
						},
					}
				: {}),
			...(restoredProject
				? {
						projectConfig: captionsEnabled
							? restoredProject
							: stripEditorCaptionContent(restoredProject),
					}
				: {}),
			...(legacyEdit
				? { legacyEditSpec: legacyEdit.editSpec satisfies VideoEditSpec }
				: {}),
			...(signedAssets.some((asset) => asset.kind === "audio")
				? {
						audioAssets: signedAssets
							.filter((asset) => asset.kind === "audio")
							.map(({ kind: _kind, ...asset }) => asset),
					}
				: {}),
			...(signedAssets.some((asset) => asset.kind === "image")
				? {
						imageAssets: signedAssets
							.filter((asset) => asset.kind === "image")
							.map(({ kind: _kind, ...asset }) => asset),
					}
				: {}),
			...(signedVideos.length > 0 ? { videoAssets: signedVideos } : {}),
			...(needsOrderedReplay
				? { imports: orderedImports }
				: clips.length > 0
					? { clips }
					: {}),
		};
	},
);

export const requestMediaEditor = Effect.fn("requestMediaEditor")(function* (
	path: string,
	init?: RequestInit,
	timeoutMs = 15_000,
	selectedWorkerId?: string,
) {
	const env = serverEnv();
	if (!env.MEDIA_SERVER_WEBHOOK_SECRET) {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	if (!path.startsWith("/") || path.startsWith("//")) {
		return yield* new HttpApiError.ServiceUnavailable();
	}
	const worker = yield* Effect.try({
		try: () =>
			editorWorkerForRequest(
				parseEditorWorkerPool(
					env.CAP_WEB_EDITOR_WORKER_POOL,
					env.CAP_WEB_EDITOR_WORKER_URL,
				),
				path,
				selectedWorkerId,
			),
		catch: () => new HttpApiError.ServiceUnavailable(),
	});
	if (!worker) return yield* new HttpApiError.ServiceUnavailable();
	const headers = new Headers(init?.headers);
	headers.set("x-media-server-secret", env.MEDIA_SERVER_WEBHOOK_SECRET);
	return yield* Effect.tryPromise({
		try: () =>
			fetch(`${worker.origin}${path}`, {
				...init,
				headers,
				redirect: "error",
				signal: AbortSignal.timeout(timeoutMs),
			}),
		catch: () => new HttpApiError.ServiceUnavailable(),
	});
});
