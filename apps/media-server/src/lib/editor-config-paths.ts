import { isAbsolute, relative, resolve } from "node:path";
import {
	editorWallpaperDirectory,
	mapEditorWallpaperConfig,
} from "./editor-wallpapers";

const assetId = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const uploadedWallpaperPath = new RegExp(
	`^content/images/${assetId}\\.(?:png|jpg|webp|gif|bmp|tiff)$`,
);
const imagePath = new RegExp(
	`^(?:content/images/${assetId}\\.(?:png|jpg|webp|gif|bmp|tiff)|content/segments/segment-[0-9]+/display\\.(?:png|jpg|webp|gif|bmp|tiff))$`,
);
const audioPath = new RegExp(
	`^assets/audio/(?:library-[a-z0-9-]+\\.mp3|import-${assetId}\\.(?:ogg|m4a|mp3|wav|aac|flac))$`,
);
const videoPath = new RegExp(
	`^content/videos/${assetId}\\.(?:mp4|mov|avi|mkv|webm|wmv|m4v|flv)$`,
);
const wallpaperPath =
	/^cap-web-wallpaper:\/\/assets\/backgrounds\/(macOS|blue|purple|cities|dark|orange)\/[a-z0-9-]+\.jpg$/;

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapBackground(
	background: unknown,
	direction: "native" | "browser",
	projectPath: string,
	wallpaperDirectory: string,
) {
	if (!asRecord(background) || !asRecord(background.source)) return background;
	const source = background.source;
	const path = source.path;
	if (path === null || path === undefined || path === "") return background;
	if (typeof path !== "string")
		throw new Error("Invalid editor background path");
	if (source.type === "wallpaper") {
		const uploadedPath =
			direction === "native"
				? uploadedWallpaperPath.test(path)
					? resolve(projectPath, path)
					: null
				: isAbsolute(path)
					? relative(projectPath, path)
					: path;
		if (
			uploadedPath &&
			uploadedWallpaperPath.test(direction === "native" ? path : uploadedPath)
		) {
			return uploadedPath === path
				? background
				: { ...background, source: { ...source, path: uploadedPath } };
		}
		if (direction === "native" && !wallpaperPath.test(path)) {
			throw new Error("Invalid editor wallpaper path");
		}
		const mapped = mapEditorWallpaperConfig(
			{ background },
			direction,
			wallpaperDirectory,
		) as { background: Record<string, unknown> };
		const mappedSource = mapped.background.source;
		if (
			direction === "browser" &&
			(!asRecord(mappedSource) ||
				!wallpaperPath.test(String(mappedSource.path)))
		) {
			throw new Error("Invalid editor wallpaper path");
		}
		return mapped.background;
	}
	if (source.type !== "image") return background;
	const mappedPath =
		direction === "native"
			? imagePath.test(path)
				? resolve(projectPath, path)
				: null
			: isAbsolute(path)
				? relative(projectPath, path)
				: path;
	if (!mappedPath || (direction === "browser" && !imagePath.test(mappedPath))) {
		throw new Error("Invalid editor background image path");
	}
	if (mappedPath === path) return background;
	return { ...background, source: { ...source, path: mappedPath } };
}

function validateSegments(timeline: Record<string, unknown>) {
	for (const [name, allowed] of [
		["audioSegments", audioPath],
		["imageSegments", imagePath],
		["videoSegments", videoPath],
	] as const) {
		const segments = timeline[name];
		if (segments === undefined) continue;
		if (!Array.isArray(segments)) throw new Error("Invalid editor media track");
		for (const segment of segments) {
			if (
				!asRecord(segment) ||
				typeof segment.path !== "string" ||
				(segment.path !== "" && !allowed.test(segment.path))
			) {
				throw new Error(`Invalid editor ${name} path`);
			}
		}
	}
}

export function mapEditorConfigPaths(
	value: unknown,
	direction: "native" | "browser",
	projectPath: string,
	wallpaperDirectory = editorWallpaperDirectory(),
) {
	if (!asRecord(value)) throw new Error("Invalid editor project configuration");
	const background = mapBackground(
		value.background,
		direction,
		projectPath,
		wallpaperDirectory,
	);
	let timeline = value.timeline;
	if (asRecord(timeline)) {
		validateSegments(timeline);
		if (Array.isArray(timeline.styleSegments)) {
			const styleSegments = timeline.styleSegments.map((segment) => {
				if (!asRecord(segment) || !asRecord(segment.overrides)) return segment;
				const overrides = segment.overrides;
				const mapped = mapBackground(
					overrides.background,
					direction,
					projectPath,
					wallpaperDirectory,
				);
				return mapped === overrides.background
					? segment
					: { ...segment, overrides: { ...overrides, background: mapped } };
			});
			timeline = { ...timeline, styleSegments };
		}
	}
	if (background === value.background && timeline === value.timeline)
		return value;
	return { ...value, background, timeline };
}

export function mapEditorInstanceConfigPaths(
	value: unknown,
	direction: "native" | "browser",
	projectPath: string,
) {
	if (!asRecord(value) || !asRecord(value.savedProjectConfig)) return value;
	return {
		...value,
		savedProjectConfig: mapEditorConfigPaths(
			value.savedProjectConfig,
			direction,
			projectPath,
		),
	};
}
