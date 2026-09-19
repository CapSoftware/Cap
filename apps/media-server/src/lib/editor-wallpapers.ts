import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const logicalPrefix = "cap-web-wallpaper://assets/backgrounds/";
const wallpaperFile =
	/^(macOS|blue|purple|cities|dark|orange)\/[a-z0-9-]+\.jpg$/;
const nativePaths = new Map<string, string>();

function asRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function editorWallpaperDirectory() {
	return (
		process.env.CAP_WEB_EDITOR_WALLPAPER_DIR ??
		resolve(import.meta.dir, "../../../desktop/src-tauri/assets/backgrounds")
	);
}

function nativeWallpaperPath(logical: string, directory: string) {
	const file = logical.slice(logicalPrefix.length);
	if (!wallpaperFile.test(file)) {
		throw new Error("Invalid editor wallpaper path");
	}
	const key = `${directory}\0${file}`;
	const cached = nativePaths.get(key);
	if (cached) return cached;
	const root = realpathSync(directory);
	const native = realpathSync(resolve(root, file));
	const within = relative(root, native);
	if (
		within.startsWith("..") ||
		isAbsolute(within) ||
		!wallpaperFile.test(within) ||
		!lstatSync(native).isFile()
	) {
		throw new Error("Invalid editor wallpaper path");
	}
	nativePaths.set(key, native);
	return native;
}

export function mapEditorWallpaperConfig(
	value: unknown,
	direction: "native" | "browser",
	directory = editorWallpaperDirectory(),
) {
	if (!asRecord(value) || !asRecord(value.background)) return value;
	const background = value.background;
	if (!asRecord(background.source)) return value;
	const source = background.source;
	if (source.type !== "wallpaper" || typeof source.path !== "string") {
		return value;
	}
	let path = source.path;
	if (direction === "native" && path.startsWith(logicalPrefix)) {
		path = nativeWallpaperPath(path, directory);
	} else if (direction === "browser" && isAbsolute(path)) {
		const file = relative(realpathSync(directory), path);
		if (wallpaperFile.test(file)) path = `${logicalPrefix}${file}`;
	}
	if (path === source.path) return value;
	return {
		...value,
		background: {
			...background,
			source: { ...source, path },
		},
	};
}

export function mapEditorInstanceWallpaper(
	value: unknown,
	direction: "native" | "browser",
	directory = editorWallpaperDirectory(),
) {
	if (!asRecord(value) || !asRecord(value.savedProjectConfig)) return value;
	return {
		...value,
		savedProjectConfig: mapEditorWallpaperConfig(
			value.savedProjectConfig,
			direction,
			directory,
		),
	};
}
