import { renderFarmTranscodeKey } from "./render-farm";

const MAX_MANIFEST_FILES = 4096;
const MAX_SIDECAR_BYTES = 64 * 1024 * 1024;
const FARM_AUDIO_FILE = /\.(ogg|m4a|wav|mp3|aac|opus|flac)$/i;
const WALLPAPER_PREFIX = "cap-web-wallpaper://assets/backgrounds/";
const WALLPAPER_FILE =
	/^(macOS|blue|purple|cities|dark|orange)\/[a-z0-9-]+\.jpg$/;
const PROJECT_ROOT_TOKEN = "$RF_PROJECT";
const GENERATED_FILES = new Set([
	"recording-meta.json",
	"project-config.json",
	"recording-diagnostics.json",
]);

export class RenderProjectError extends Error {}

export type RenderProjectFile = { path: string; size: number; inode: string };

export type RenderProjectSource = {
	key: string;
	size: number;
	identity: string;
};

export type RenderManifestEntry = {
	path: string;
	size?: number;
	key?: string;
	transcodeFrom?: string;
};

export type RenderProjectPlan = {
	entries: RenderManifestEntry[];
	uploads: string[];
	wallpapers: string[];
	recordingMeta: Record<string, unknown>;
	config: Record<string, unknown>;
};

type MediaRef = { path?: unknown; [key: string]: unknown };

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stem(path: string) {
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	return dot > slash ? path.slice(0, dot) : path;
}

function extension(path: string) {
	const slash = path.lastIndexOf("/");
	const dot = path.lastIndexOf(".");
	return dot > slash ? path.slice(dot + 1).toLowerCase() : "";
}

function mapBackgroundPaths(background: unknown, wallpapers: Set<string>) {
	if (!asRecord(background) || !asRecord(background.source)) return background;
	const source = background.source;
	if (typeof source.path !== "string" || source.path === "") return background;
	let path: string;
	if (source.type === "wallpaper") {
		if (!source.path.startsWith(WALLPAPER_PREFIX)) {
			throw new RenderProjectError("Unsupported wallpaper");
		}
		const file = source.path.slice(WALLPAPER_PREFIX.length);
		if (!WALLPAPER_FILE.test(file)) {
			throw new RenderProjectError("Unsupported wallpaper");
		}
		wallpapers.add(file);
		path = `${PROJECT_ROOT_TOKEN}/assets/backgrounds/${file}`;
	} else if (source.type === "image") {
		if (source.path.startsWith("/") || source.path.includes("..")) {
			throw new RenderProjectError("Unsupported background image");
		}
		path = `${PROJECT_ROOT_TOKEN}/${source.path}`;
	} else {
		return background;
	}
	return { ...background, source: { ...source, path } };
}

function renderConfig(
	config: Record<string, unknown>,
	wallpapers: Set<string>,
) {
	const timeline = asRecord(config.timeline) ? config.timeline : null;
	if (
		timeline &&
		Array.isArray(timeline.videoSegments) &&
		timeline.videoSegments.some(
			(segment) => asRecord(segment) && segment.path !== "",
		)
	) {
		throw new RenderProjectError(
			"Video clips on the timeline can't be saved this way yet; use Export",
		);
	}
	return {
		...config,
		background: mapBackgroundPaths(config.background, wallpapers),
		...(timeline && Array.isArray(timeline.styleSegments)
			? {
					timeline: {
						...timeline,
						styleSegments: timeline.styleSegments.map((segment) =>
							asRecord(segment) && asRecord(segment.overrides)
								? {
										...segment,
										overrides: {
											...segment.overrides,
											background: mapBackgroundPaths(
												segment.overrides.background,
												wallpapers,
											),
										},
									}
								: segment,
						),
					},
				}
			: {}),
	};
}

/**
 * Turns an editor session's project into a render-farm manifest. Browser
 * recordings are WebM or fragmented MP4, which the farm cannot seek into, so
 * every segment video is transcoded (keyed by source identity so later saves
 * reuse it); everything else is read in place or uploaded from the session.
 */
export function buildRenderProject(input: {
	root: string;
	recording: string;
	files: RenderProjectFile[];
	recordingMeta: unknown;
	config: unknown;
	sources: Map<string, RenderProjectSource>;
}): RenderProjectPlan {
	if (!asRecord(input.recordingMeta) || !asRecord(input.config)) {
		throw new RenderProjectError("Invalid editor project");
	}
	const segments = input.recordingMeta.segments;
	if (!Array.isArray(segments) || segments.length === 0) {
		throw new RenderProjectError(
			"Only multi-segment Studio projects can be saved",
		);
	}
	const files = new Map(input.files.map((file) => [file.path, file]));
	const sourceByInode = new Map<string, RenderProjectSource>();
	for (const [path, source] of input.sources) {
		const file = files.get(path);
		if (file) sourceByInode.set(file.inode, source);
	}
	const sourceFor = (path: string) => {
		const file = files.get(path);
		if (!file) throw new RenderProjectError(`Project file ${path} is missing`);
		return input.sources.get(path) ?? sourceByInode.get(file.inode) ?? null;
	};
	const entries = new Map<string, RenderManifestEntry>();
	const uploads = new Set<string>();
	const handled = new Set<string>();
	const readable = (path: string) => {
		const source = sourceFor(path);
		if (source) return { key: source.key, size: source.size, source };
		uploads.add(path);
		return {
			key: `${input.recording}/${path}`,
			size: (files.get(path) as RenderProjectFile).size,
			source: null,
		};
	};

	const videoPath = (path: string) => {
		const from = readable(path);
		const target = `${stem(path)}.h264.mp4`;
		entries.set(target, {
			path: target,
			key: from.source
				? renderFarmTranscodeKey(input.root, from.key, from.source.identity)
				: `${input.recording}/transcoded/${target}`,
			transcodeFrom: from.key,
		});
		handled.add(path);
		return target;
	};
	const audioPath = (path: string, suffix: string) => {
		const from = readable(path);
		const ext = extension(path);
		const target = FARM_AUDIO_FILE.test(path)
			? path
			: `${stem(path)}${suffix}.${ext === "mp4" || ext === "m4a" ? "m4a" : "opus"}`;
		entries.set(target, { path: target, key: from.key, size: from.size });
		handled.add(path);
		return target;
	};

	const renderSegments = segments.map((segment: unknown) => {
		if (!asRecord(segment)) throw new RenderProjectError("Invalid segment");
		const next: Record<string, unknown> = { ...segment };
		const display = segment.display as MediaRef | undefined;
		if (!display || typeof display.path !== "string") {
			throw new RenderProjectError("Segment has no display video");
		}
		const displaySource = display.path;
		next.display = { ...display, path: videoPath(displaySource) };
		const camera = segment.camera as MediaRef | undefined;
		if (camera && typeof camera.path === "string") {
			next.camera = { ...camera, path: videoPath(camera.path) };
		}
		for (const [field, suffix] of [
			["mic", ".mic"],
			["system_audio", ".system"],
		] as const) {
			const audio = segment[field] as MediaRef | undefined;
			if (audio && typeof audio.path === "string") {
				next[field] = { ...audio, path: audioPath(audio.path, suffix) };
			}
		}
		return next;
	});

	for (const file of input.files) {
		if (
			handled.has(file.path) ||
			GENERATED_FILES.has(file.path) ||
			entries.has(file.path) ||
			file.path.startsWith("content/videos/")
		) {
			continue;
		}
		const from = readable(file.path);
		if (
			!from.source &&
			!FARM_AUDIO_FILE.test(file.path) &&
			from.size > MAX_SIDECAR_BYTES
		) {
			throw new RenderProjectError(`Project file ${file.path} is too large`);
		}
		entries.set(
			file.path,
			from.source
				? { path: file.path, key: from.key, size: from.size }
				: { path: file.path, size: from.size },
		);
	}

	const wallpapers = new Set<string>();
	const config = renderConfig(input.config, wallpapers);
	for (const file of wallpapers) {
		entries.set(`assets/backgrounds/${file}`, {
			path: `assets/backgrounds/${file}`,
		});
	}
	if (entries.size + 2 > MAX_MANIFEST_FILES) {
		throw new RenderProjectError("Project has too many files");
	}
	return {
		entries: [...entries.values()],
		uploads: [...uploads],
		wallpapers: [...wallpapers],
		recordingMeta: { ...input.recordingMeta, segments: renderSegments },
		config,
	};
}

/** The manifest once uploads have reported the sizes they stored. */
export function finishRenderManifest(
	plan: RenderProjectPlan,
	uploaded: Map<string, number>,
	generated: { path: string; size: number }[],
) {
	return {
		files: [
			...plan.entries.map((entry) => {
				if (entry.key || entry.transcodeFrom) return entry;
				const size = uploaded.get(entry.path);
				if (size === undefined) {
					throw new RenderProjectError(
						`Project file ${entry.path} was not uploaded`,
					);
				}
				return { ...entry, size };
			}),
			...generated,
		],
	};
}
