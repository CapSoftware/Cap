import type { VideoMetadata } from "@cap/database/types";
import {
	applyDefaultStyle,
	type EditorDefaultStyle,
} from "@cap/editor-cap-bundle/default-style";
import { hasEditorCaptionContent } from "./editor-caption-access";
import {
	buildRenderProject,
	type RenderManifestEntry,
	type RenderProjectFile,
	type RenderProjectSource,
} from "./render-farm-project";

/**
 * What a render farm that prepares projects itself advertises on /health:
 * the configuration a never-edited recording opens with, and the built-in
 * music it ships.
 */
export type RenderFarmPrepareSupport = {
	version: 1;
	defaultConfig: Record<string, unknown>;
	music: string[];
};

export function parseRenderFarmPrepareSupport(
	value: unknown,
): RenderFarmPrepareSupport | null {
	if (!asRecord(value) || value.version !== 1) return null;
	if (!asRecord(value.defaultConfig)) return null;
	if (
		!Array.isArray(value.music) ||
		!value.music.every((id) => typeof id === "string")
	) {
		return null;
	}
	return {
		version: 1,
		defaultConfig: value.defaultConfig,
		music: value.music as string[],
	};
}

type SourceMedia = { contentType: string; fps?: number; offsetMs?: number };
type SourceAsset = { path: string; size: number };

export type DirectRenderSources = {
	title: string;
	display: SourceMedia;
	camera?: SourceMedia & { offsetMs: number };
	mic?: SourceMedia & { offsetMs: number };
	systemAudio?: SourceMedia & { offsetMs: number };
	inputEvents?: unknown;
	projectConfig?: Record<string, unknown>;
	audioDefault?: {
		enabledByDefault: boolean;
		isolation: string;
	} | null;
	legacyEditSpec?: unknown;
	audioAssets?: SourceAsset[];
	imageAssets?: SourceAsset[];
	videoAssets?: unknown;
	clips?: unknown;
	imports?: unknown;
};

type SignedSources = DirectRenderSources;
type EditorSources = NonNullable<VideoMetadata["editorSources"]>;

type WebProjectVideo = { path: string; fps: number; offsetMs: number };
type WebProjectAudio = { path: string; offsetMs: number };

/** The `sources` of the farm engine's `prepare` op (cap_export::web_project). */
export type RenderFarmPrepareSources = {
	title: string;
	display: WebProjectVideo;
	camera: WebProjectVideo | null;
	mic: WebProjectAudio | null;
	systemAudio: WebProjectAudio | null;
	audioDefault: null;
	initialProjectConfig: Record<string, unknown>;
	legacyEditSpec: null;
};

export type RenderFarmPrepare = {
	version: 1;
	sources: RenderFarmPrepareSources;
	/** The display as recorded, which sets a never-edited timeline's length. */
	display: { key: string; contentType: string };
	/**
	 * Never edited: the farm fills in what opening an editor session does
	 * (a whole-recording timeline, clip audio offsets). A saved project is
	 * rendered as saved.
	 */
	sessionDefaults: boolean;
	inputEvents: { key: string; size: number } | null;
};

export type DirectRenderPlan = {
	prepare: RenderFarmPrepare;
	entries: RenderManifestEntry[];
	config: Record<string, unknown>;
};

export type DirectRenderUnsupported = { unsupported: string };

const MUSIC_TRACK = /^assets\/audio\/library-([a-z0-9-]+)\.mp3$/;

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An editor worker probes the file for any other frame rate. */
function reportedFps(fps: number | undefined) {
	return Number.isInteger(fps) && fps !== undefined && fps >= 1 && fps <= 120
		? fps
		: null;
}

function videoExtension(contentType: string) {
	return contentType === "video/webm" ? "webm" : "mp4";
}

function audioExtension(contentType: string) {
	return contentType === "audio/webm" ? "webm" : "mp4";
}

function musicTracks(config: Record<string, unknown>) {
	const timeline = config.timeline;
	if (!asRecord(timeline) || !Array.isArray(timeline.audioSegments)) return [];
	const ids = new Set<string>();
	for (const segment of timeline.audioSegments) {
		if (!asRecord(segment) || typeof segment.path !== "string") continue;
		const match = MUSIC_TRACK.exec(segment.path);
		if (match?.[1]) ids.add(match[1]);
	}
	return [...ids];
}

function sessionConfig(
	sources: SignedSources,
	support: RenderFarmPrepareSupport,
) {
	if (sources.projectConfig) return sources.projectConfig;
	const config = structuredClone(support.defaultConfig);
	if (sources.audioDefault) {
		const audio = asRecord(config.audio) ? config.audio : {};
		config.audio = {
			...audio,
			improve: sources.audioDefault.enabledByDefault,
			isolation: sources.audioDefault.isolation,
		};
	}
	return config;
}

type SourceHead = { size: number; etag: string };

export type DirectRenderInput = {
	sources: SignedSources;
	editorSources: EditorSources;
	heads: Map<string, SourceHead | null>;
	savedAssets: {
		path: string;
		key: string;
		size: number;
		objectIdentity?: string | null;
	}[];
	ownerId: string;
	videoId: string;
	hasSavedProject: boolean;
	defaultStyle: EditorDefaultStyle | null | undefined;
	captionsEnabled: boolean;
	target: { root: string; recording: string };
	support: RenderFarmPrepareSupport;
	mixedAudioInDisplay: boolean;
};

/**
 * Whether a recording's stored metadata alone allows a farm-prepared render,
 * so the editor can skip starting a worker session. The render still falls
 * back when the full check disagrees.
 */
export function directRenderLikely(metadata: VideoMetadata | null | undefined) {
	const editorSources = metadata?.editorSources;
	return (
		!!editorSources &&
		editorSources.version === 1 &&
		reportedFps(editorSources.display.fps) !== null &&
		(!editorSources.camera || reportedFps(editorSources.camera.fps) !== null) &&
		!metadata?.webEditorClips?.items?.length &&
		!metadata?.webEditorImports?.items?.length &&
		!metadata?.webEditorVideos?.items?.length
	);
}

export function directRenderBlocker(sources: SignedSources) {
	if (sources.legacyEditSpec) return "The recording has a legacy edit";
	if ("clips" in sources || "imports" in sources || "videoAssets" in sources) {
		return "The project has imported clips";
	}
	if (
		reportedFps(sources.display.fps) === null ||
		(sources.camera && reportedFps(sources.camera.fps) === null)
	) {
		return "A source frame rate needs probing";
	}
	return null;
}

export function directRenderProbesDisplayAudio(sources: SignedSources) {
	return !sources.mic && !sources.systemAudio;
}

const SEGMENT = "content/segments/segment-0";

export function directRenderMedia(
	sources: SignedSources,
	editorSources: DirectRenderInput["editorSources"],
) {
	return [
		[
			`${SEGMENT}/display.${videoExtension(sources.display.contentType)}`,
			editorSources.display.key,
		],
		[
			sources.camera
				? `${SEGMENT}/camera.${videoExtension(sources.camera.contentType)}`
				: null,
			editorSources.camera?.key,
		],
		[
			sources.mic
				? `${SEGMENT}/mic.${audioExtension(sources.mic.contentType)}`
				: null,
			editorSources.mic?.key,
		],
		[
			sources.systemAudio
				? `${SEGMENT}/system-audio.${audioExtension(sources.systemAudio.contentType)}`
				: null,
			editorSources.systemAudio?.key,
		],
	].filter((pair): pair is [string, string] => !!pair[0] && !!pair[1]);
}

/**
 * Plans a render the farm prepares itself, mirroring what an editor worker
 * does with the same sources: the files it would stage, the frame rates and
 * audio layout it would choose, and the configuration it would open.
 */
export function planDirectRenderProject(
	input: DirectRenderInput,
): DirectRenderPlan | DirectRenderUnsupported {
	const { sources, editorSources, support } = input;
	const blocker = directRenderBlocker(sources);
	if (blocker) return { unsupported: blocker };
	const displayFps = reportedFps(sources.display.fps) as number;
	const cameraFps = sources.camera ? reportedFps(sources.camera.fps) : null;
	const main = directRenderMedia(sources, editorSources);
	const displayPath = main[0]?.[0] as string;
	const pathOf = (prefix: string) =>
		main.find(([path]) => path.startsWith(`${SEGMENT}/${prefix}.`))?.[0] ??
		null;
	const cameraPath = pathOf("camera");
	const micPath = pathOf("mic");
	const systemAudioPath = pathOf("system-audio");

	const files: RenderProjectFile[] = [];
	const projectSources = new Map<string, RenderProjectSource>();
	for (const [path, key] of main) {
		const head = input.heads.get(key);
		files.push({ path, size: head?.size ?? 0, inode: `source:${key}` });
		if (head?.size && head.etag) {
			projectSources.set(path, {
				key,
				size: head.size,
				identity: head.etag,
			});
		}
	}
	for (const asset of [
		...(sources.audioAssets ?? []),
		...(sources.imageAssets ?? []),
	]) {
		const saved = input.savedAssets.find((item) => item.path === asset.path);
		if (!saved || !saved.key.startsWith(`${input.ownerId}/${input.videoId}/`)) {
			return { unsupported: "A saved asset is outside the recording" };
		}
		files.push({
			path: asset.path,
			size: asset.size,
			inode: `asset:${saved.key}`,
		});
	}
	for (const saved of input.savedAssets) {
		if (saved.key.startsWith(`${input.ownerId}/${input.videoId}/`)) {
			projectSources.set(saved.path, {
				key: saved.key,
				size: saved.size,
				identity: saved.objectIdentity ?? `size:${saved.size}`,
			});
		}
	}

	const opened = sessionConfig(sources, support);
	const projectConfig =
		!input.hasSavedProject && input.defaultStyle
			? applyDefaultStyle(opened, input.defaultStyle)
			: opened;
	if (!input.captionsEnabled && hasEditorCaptionContent(projectConfig)) {
		throw new DirectRenderForbidden();
	}

	const plan = buildRenderProject({
		root: input.target.root,
		recording: input.target.recording,
		files,
		recordingMeta: {
			segments: [
				{
					display: { path: displayPath },
					...(cameraPath ? { camera: { path: cameraPath } } : {}),
					...(micPath ? { mic: { path: micPath } } : {}),
					...(systemAudioPath
						? { system_audio: { path: systemAudioPath } }
						: input.mixedAudioInDisplay
							? { system_audio: { path: displayPath } }
							: {}),
				},
			],
		},
		config: projectConfig,
		sources: projectSources,
	});
	if (plan.uploads.length > 0) {
		return { unsupported: "Project files need an editor worker" };
	}

	const staged = plan.recordingMeta.segments;
	const first = Array.isArray(staged) && asRecord(staged[0]) ? staged[0] : {};
	const renderPath = (field: string) => {
		const media = first[field];
		return asRecord(media) && typeof media.path === "string"
			? media.path
			: null;
	};
	const renderDisplay = renderPath("display") as string;
	const renderCamera = renderPath("camera");
	const renderMic = renderPath("mic");
	const renderSystemAudio = renderPath("system_audio");
	const tracks = musicTracks(projectConfig).filter((id) =>
		support.music.includes(id),
	);

	return {
		prepare: {
			version: 1,
			sources: {
				title: sources.title,
				display: { path: renderDisplay, fps: displayFps, offsetMs: 0 },
				camera:
					renderCamera && sources.camera
						? {
								path: renderCamera,
								fps: cameraFps ?? displayFps,
								offsetMs: sources.camera.offsetMs,
							}
						: null,
				mic:
					renderMic && sources.mic
						? { path: renderMic, offsetMs: sources.mic.offsetMs }
						: null,
				systemAudio: renderSystemAudio
					? {
							path: renderSystemAudio,
							offsetMs: sources.systemAudio?.offsetMs ?? 0,
						}
					: null,
				audioDefault: null,
				initialProjectConfig: plan.config,
				legacyEditSpec: null,
			},
			display: {
				key: editorSources.display.key,
				contentType: sources.display.contentType,
			},
			sessionDefaults: !sources.projectConfig,
			inputEvents:
				sources.inputEvents && editorSources.inputEvents
					? {
							key: editorSources.inputEvents.key,
							size: editorSources.inputEvents.size,
						}
					: null,
		},
		entries: [
			...plan.entries.map((entry) =>
				entry.path.startsWith("assets/backgrounds/") &&
				!entry.key &&
				!entry.transcodeFrom
					? { path: entry.path, builtin: entry.path.slice("assets/".length) }
					: entry,
			),
			...tracks.map((id) => ({
				path: `assets/audio/library-${id}.mp3`,
				builtin: `music/${id}.mp3`,
			})),
		],
		config: plan.config,
	};
}

export class DirectRenderForbidden extends Error {}
