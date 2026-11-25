import { users, videoEdits, videos, videoUploads } from "@cap/database/schema";
import type { VideoEditSpec } from "@cap/database/types";
import { userIsPro } from "@cap/utils";
import { Database, Storage } from "@cap/web-backend";
import { getRecordingObjectIdentity } from "@cap/web-backend/src/Storage/recording-object-identity";
import { CurrentUser, type Video } from "@cap/web-domain";
import { HttpApiError } from "@effect/platform";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { CAP_BUNDLE_CONTENT_TYPE } from "./editor-cap-bundle";
import { stripEditorCaptionContent } from "./editor-caption-access";
import { MAX_WEB_EDITOR_CLIPS, validWebEditorClip } from "./editor-clips";
import {
	type EditorDefaultStyle,
	recordingDefaultStyle,
} from "./editor-default-style";
import { normalizeWebEditorImportOrder } from "./editor-imports";
import { decodeWebEditorProject } from "./editor-project-storage";
import {
	isAbandonedEditorReplacementUpload,
	isActiveEditorReplacementUpload,
} from "./editor-replacement-upload";
import { editorSourcesUploaded } from "./editor-sources-ready";
import {
	MAX_EDITOR_VIDEO_BYTES,
	MAX_EDITOR_VIDEO_COUNT,
	validEditorVideoAsset,
} from "./editor-video-upload";
import { isStorageObjectNotFound } from "./storage-not-found";
import * as StudioSound from "./studio-sound";
import { getEditSourceKey } from "./video-edit-processing";
import { decodeStorageVideo } from "./video-storage";
import { isWebStudioEnabledForEmail } from "./web-studio-rollout";

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

export const loadEligibleEditorVideo = Effect.fn("loadEligibleEditorVideo")(
	function* (
		videoId: Video.VideoId,
		allowReplacementUpload = false,
		requirePro = false,
	) {
		const currentUser = yield* CurrentUser;
		if (!isWebStudioEnabledForEmail(currentUser.email)) {
			return yield* new HttpApiError.NotFound();
		}
		const database = yield* Database;
		const [record] = yield* database
			.use((client) =>
				client
					.select({
						video: videos,
						owner: users,
						uploadPhase: videoUploads.phase,
						uploadKey: videoUploads.rawFileKey,
						uploadUpdatedAt: videoUploads.updatedAt,
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
			!!record &&
			((allowReplacementUpload &&
				isActiveEditorReplacementUpload(
					record.video.ownerId,
					record.video.id,
					record.uploadPhase,
					record.uploadKey,
				)) ||
				isAbandonedEditorReplacementUpload(
					record.video.ownerId,
					record.video.id,
					record.uploadPhase,
					record.uploadKey,
					record.uploadUpdatedAt,
				));
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
				!replacementUpload &&
				!editorSourcesUploaded(record.video.metadata, record.uploadPhase))
		) {
			return yield* new HttpApiError.NotFound();
		}
		const captionsEnabled = userIsPro(record.owner);
		if (requirePro && !captionsEnabled) {
			return yield* new HttpApiError.Forbidden();
		}
		return {
			...record.video,
			captionsEnabled,
			audioDefault:
				StudioSound.parsePreference(
					record.video.metadata?.webEditorAudioDefault,
				) ?? StudioSound.fromUserPreferences(record.owner.preferences),
			defaultStyle: recordingDefaultStyle(
				record.owner.preferences?.editorDefaultStyle,
				record.video.metadata?.recorderCamera,
			),
		};
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
	function* (
		video: DbVideo & {
			captionsEnabled?: boolean;
			defaultStyle?: EditorDefaultStyle | null;
			audioDefault?: StudioSound.Preference | null;
		},
		audience: "farm" | "browser" = "farm",
	) {
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
		const signedUrlExpiresAt = Date.now() + SOURCE_URL_TTL_SECONDS * 1000;
		const signSource = (key: string) =>
			audience === "browser"
				? storage.getSignedObjectUrl(key, {
						expiresIn: SOURCE_URL_TTL_SECONDS,
					})
				: storage.getInternalSignedObjectUrl(key, {
						expiresIn: SOURCE_URL_TTL_SECONDS,
					});
		const [displayHead, cameraHead, micHead, systemAudioHead] =
			yield* Effect.all(
				[
					storage.headObject(displaySource.key),
					cameraSource
						? storage.headObject(cameraSource.key)
						: Effect.succeed(null),
					micSource ? storage.headObject(micSource.key) : Effect.succeed(null),
					systemAudioSource
						? storage.headObject(systemAudioSource.key)
						: Effect.succeed(null),
				],
				{ concurrency: 4 },
			).pipe(
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
		const [displayUrl, cameraUrl, micUrl, systemAudioUrl] = yield* Effect.all(
			[
				signSource(displaySource.key),
				cameraSource ? signSource(cameraSource.key) : Effect.succeed(null),
				micSource ? signSource(micSource.key) : Effect.succeed(null),
				systemAudioSource
					? signSource(systemAudioSource.key)
					: Effect.succeed(null),
			],
			{ concurrency: 4 },
		).pipe(
			Effect.catchTag("StorageError", () =>
				Effect.fail(new HttpApiError.ServiceUnavailable()),
			),
		);
		// A saved image whose object is gone is left out, so the editor still
		// opens. The file route answers 410 for it, and the preview and export
		// draw nothing in its place.
		const assetHeads = yield* Effect.all(
			assets.map((asset) =>
				storage.headObject(asset.key).pipe(
					Effect.catchIf(
						(error) => asset.kind === "image" && isStorageObjectNotFound(error),
						() => Effect.succeed(null),
					),
				),
			),
			{ concurrency: 4 },
		).pipe(
			Effect.catchTag("StorageError", () =>
				Effect.fail(new HttpApiError.ServiceUnavailable()),
			),
		);
		const availableAssets = assets.flatMap((asset, index) => {
			const head = assetHeads[index];
			return head ? [{ asset, head }] : [];
		});
		const signedAssets = yield* Effect.all(
			availableAssets.map(({ asset, head }) => {
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
				return signSource(asset.key).pipe(
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
				return signSource(asset.key).pipe(
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
			...(audience === "browser"
				? {
						signedUrlExpiresAt,
						displayHasAudio:
							legacySource || sources?.display?.embeddedAudio === true,
						// Sizes the first read of each source's tail; the exact
						// duration still comes from the media.
						...(typeof video.duration === "number" &&
						Number.isFinite(video.duration) &&
						video.duration > 0
							? { durationHint: video.duration }
							: {}),
					}
				: {}),
			...(video.metadata?.audioOnly === true ? { audioOnly: true } : {}),
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
			...(!restoredProject && audience === "browser" && video.defaultStyle
				? { defaultStyle: video.defaultStyle }
				: {}),
			...(!restoredProject && video.audioDefault
				? { audioDefault: video.audioDefault }
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
