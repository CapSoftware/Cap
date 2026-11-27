import { resolveEditorImportedImage } from "./editor-file-mapping";

let assetBase = "";

const WALLPAPER_PATH =
	/^cap-web-wallpaper:\/\/assets\/backgrounds\/(macOS|blue|purple|cities|dark|orange)\/([a-z0-9-]+)\.jpg$/;

export function wallpaperPath(id: string) {
	return `cap-web-wallpaper://assets/backgrounds/${id}.jpg`;
}

export function setEditorAssetBase(value: string) {
	assetBase = value.startsWith("/") && !value.startsWith("//") ? value : "";
}

export function resolveEditorAssetUrl(path: string) {
	path = resolveEditorImportedImage(path);
	if (/^https?:\/\//.test(path)) return path;
	if (path.startsWith("data:image/jpeg;base64,")) return path;
	const wallpaper = path.match(WALLPAPER_PATH);
	if (wallpaper) {
		return `${import.meta.env.BASE_URL}assets/backgrounds/${wallpaper[1]}/${wallpaper[2]}.jpg`;
	}
	if (path.startsWith("/api/")) return path;
	return assetBase
		? `${assetBase}${assetBase.includes("?") ? "&" : "?"}path=${encodeURIComponent(path)}`
		: "";
}
