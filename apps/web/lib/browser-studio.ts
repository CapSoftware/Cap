export const BROWSER_STUDIO_MANIFEST_SUBPATH = "studio/manifest.json";
export const BROWSER_STUDIO_DEFAULT_SOURCE_SUBPATH = "result.mp4";

export type BrowserStudioAssetKind =
	| "screen"
	| "camera"
	| "microphone"
	| "system-audio"
	| "mixed";

export type BrowserStudioManifestChunk = {
	index: number;
	size: number;
	checksum: string;
	createdAt: number;
};

export type BrowserStudioManifestAsset = {
	assetId: string;
	trackId: string;
	kind: BrowserStudioAssetKind;
	label: string;
	mimeType: string;
	fileExtension: string;
	width: number | null;
	height: number | null;
	frameRate: number | null;
	sampleRate: number | null;
	channelCount: number | null;
	totalBytes: number;
	chunkCount: number;
	chunks: BrowserStudioManifestChunk[];
	sourceSubpath: string;
};

export type BrowserStudioManifestTrack = {
	trackId: string;
	assetId: string;
	kind: BrowserStudioAssetKind;
	label: string;
	startMs: number;
	durationMs: number | null;
	muted: boolean;
};

export type BrowserStudioManifestProject = {
	schemaVersion: 1;
	source: "browser-recorder";
	title: string | null;
	timeline: {
		durationMs: number | null;
		tracks: BrowserStudioManifestTrack[];
	};
	exportSettings: {
		format: "mp4";
		quality: "source";
	};
};

export type BrowserStudioCanvasAspectRatio = "source" | "16:9" | "1:1" | "9:16";

export type BrowserStudioBackgroundMode = "solid" | "blur";

export type BrowserStudioCameraPosition =
	| "top-left"
	| "top-right"
	| "bottom-left"
	| "bottom-right";

export type BrowserStudioZoomSegment = {
	id: string;
	startMs: number;
	endMs: number;
	scale: number;
	originX: number;
	originY: number;
};

export type BrowserStudioTextOverlay = {
	id: string;
	startMs: number;
	endMs: number;
	text: string;
	x: number;
	y: number;
	size: number;
	color: string;
	background: string;
};

export type BrowserStudioEditSettings = {
	trim: {
		startMs: number;
		endMs: number | null;
	};
	canvas: {
		aspectRatio: BrowserStudioCanvasAspectRatio;
		backgroundMode: BrowserStudioBackgroundMode;
		background: string;
		padding: number;
		scale: number;
		cameraPosition: BrowserStudioCameraPosition;
		cameraSize: number;
	};
	audio: {
		volume: number;
	};
	zooms: BrowserStudioZoomSegment[];
	textOverlays: BrowserStudioTextOverlay[];
};

export type BrowserStudioCloudManifest = {
	schemaVersion: 1;
	videoId: string;
	sessionId: string;
	source: "browser-studio-vault";
	createdAt: number;
	updatedAt: number;
	browser: {
		userAgent: string;
		platform: string | null;
	};
	project: BrowserStudioManifestProject;
	assets: BrowserStudioManifestAsset[];
	totalBytes: number;
	chunkCount: number;
	edit?: BrowserStudioEditSettings;
};

export type BrowserStudioSource = {
	subpath: string;
	url: string;
	contentType: string | null;
	size: number | null;
};

type FallbackBrowserStudioManifestInput = {
	videoId: string;
	title: string | null;
	durationMs: number | null;
	width: number | null;
	height: number | null;
	sourceSubpath?: string;
	userAgent?: string;
	platform?: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";

const isNumber = (value: unknown): value is number =>
	typeof value === "number" && Number.isFinite(value);

const isNullableNumber = (value: unknown): value is number | null =>
	value === null || isNumber(value);

export const isSafeBrowserStudioSubpath = (value: string) =>
	value.length > 0 && !value.includes("..") && !value.startsWith("/");

export const createDefaultBrowserStudioEdit = (
	durationMs: number | null,
): BrowserStudioEditSettings => ({
	trim: {
		startMs: 0,
		endMs: durationMs,
	},
	canvas: {
		aspectRatio: "source",
		backgroundMode: "solid",
		background: "#111111",
		padding: 8,
		scale: 1,
		cameraPosition: "bottom-right",
		cameraSize: 22,
	},
	audio: {
		volume: 1,
	},
	zooms: [],
	textOverlays: [],
});

export const getBrowserStudioEditSettings = (
	manifest: BrowserStudioCloudManifest,
) =>
	manifest.edit
		? {
				...createDefaultBrowserStudioEdit(manifest.project.timeline.durationMs),
				...manifest.edit,
				trim: {
					...createDefaultBrowserStudioEdit(
						manifest.project.timeline.durationMs,
					).trim,
					...manifest.edit.trim,
				},
				canvas: {
					...createDefaultBrowserStudioEdit(
						manifest.project.timeline.durationMs,
					).canvas,
					...manifest.edit.canvas,
				},
				audio: {
					...createDefaultBrowserStudioEdit(
						manifest.project.timeline.durationMs,
					).audio,
					...manifest.edit.audio,
				},
				zooms: Array.isArray(manifest.edit.zooms) ? manifest.edit.zooms : [],
				textOverlays: Array.isArray(manifest.edit.textOverlays)
					? manifest.edit.textOverlays
					: [],
			}
		: createDefaultBrowserStudioEdit(manifest.project.timeline.durationMs);

export const normalizeBrowserStudioManifest = (
	manifest: BrowserStudioCloudManifest,
): BrowserStudioCloudManifest => ({
	...manifest,
	edit: getBrowserStudioEditSettings(manifest),
});

export const isBrowserStudioCloudManifest = (
	value: unknown,
): value is BrowserStudioCloudManifest => {
	if (!isRecord(value)) return false;
	if (value.schemaVersion !== 1) return false;
	if (!isString(value.videoId)) return false;
	if (!isString(value.sessionId)) return false;
	if (value.source !== "browser-studio-vault") return false;
	if (!isNumber(value.createdAt) || !isNumber(value.updatedAt)) return false;
	if (!isRecord(value.browser)) return false;
	if (!isString(value.browser.userAgent)) return false;
	if (
		value.browser.platform !== null &&
		value.browser.platform !== undefined &&
		!isString(value.browser.platform)
	)
		return false;
	if (!isRecord(value.project)) return false;
	if (value.project.schemaVersion !== 1) return false;
	if (value.project.source !== "browser-recorder") return false;
	if (!isRecord(value.project.timeline)) return false;
	if (!isNullableNumber(value.project.timeline.durationMs)) return false;
	if (!Array.isArray(value.project.timeline.tracks)) return false;
	if (!Array.isArray(value.assets)) return false;
	if (!isNumber(value.totalBytes) || !isNumber(value.chunkCount)) return false;

	return value.assets.every((asset) => {
		if (!isRecord(asset)) return false;
		if (!isString(asset.assetId)) return false;
		if (!isString(asset.trackId)) return false;
		if (!isString(asset.kind)) return false;
		if (!isString(asset.label)) return false;
		if (!isString(asset.mimeType)) return false;
		if (!isString(asset.fileExtension)) return false;
		if (!isNullableNumber(asset.width)) return false;
		if (!isNullableNumber(asset.height)) return false;
		if (!isNullableNumber(asset.frameRate)) return false;
		if (!isNullableNumber(asset.sampleRate)) return false;
		if (!isNullableNumber(asset.channelCount)) return false;
		if (!isNumber(asset.totalBytes)) return false;
		if (!isNumber(asset.chunkCount)) return false;
		if (!Array.isArray(asset.chunks)) return false;
		if (!isString(asset.sourceSubpath)) return false;
		return isSafeBrowserStudioSubpath(asset.sourceSubpath);
	});
};

export const uniqueBrowserStudioSourceSubpaths = (
	manifest: BrowserStudioCloudManifest,
) => {
	const subpaths = manifest.assets
		.map((asset) => asset.sourceSubpath)
		.filter(isSafeBrowserStudioSubpath);

	return [
		...new Set(
			subpaths.length > 0 ? subpaths : [BROWSER_STUDIO_DEFAULT_SOURCE_SUBPATH],
		),
	];
};

export const createFallbackBrowserStudioManifest = ({
	videoId,
	title,
	durationMs,
	width,
	height,
	sourceSubpath = BROWSER_STUDIO_DEFAULT_SOURCE_SUBPATH,
	userAgent = "unknown",
	platform = null,
}: FallbackBrowserStudioManifestInput): BrowserStudioCloudManifest => {
	const timestamp = Date.now();
	const assetId = "asset-screen";
	const trackId = "track-screen";

	return {
		schemaVersion: 1,
		videoId,
		sessionId: `browser-studio-${videoId}`,
		source: "browser-studio-vault",
		createdAt: timestamp,
		updatedAt: timestamp,
		browser: {
			userAgent,
			platform,
		},
		project: {
			schemaVersion: 1,
			source: "browser-recorder",
			title,
			timeline: {
				durationMs,
				tracks: [
					{
						trackId,
						assetId,
						kind: "screen",
						label: title ?? "Screen recording",
						startMs: 0,
						durationMs,
						muted: false,
					},
				],
			},
			exportSettings: {
				format: "mp4",
				quality: "source",
			},
		},
		assets: [
			{
				assetId,
				trackId,
				kind: "screen",
				label: title ?? "Screen recording",
				mimeType: "video/mp4",
				fileExtension: "mp4",
				width,
				height,
				frameRate: null,
				sampleRate: null,
				channelCount: null,
				totalBytes: 0,
				chunkCount: 0,
				chunks: [],
				sourceSubpath,
			},
		],
		totalBytes: 0,
		chunkCount: 0,
		edit: createDefaultBrowserStudioEdit(durationMs),
	};
};
