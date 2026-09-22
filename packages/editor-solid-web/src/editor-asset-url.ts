import { resolveEditorImportedImage } from "./editor-file-mapping";

let assetBase = "";

export function setEditorAssetBase(value: string) {
	assetBase = value.startsWith("/") && !value.startsWith("//") ? value : "";
}

export function resolveEditorAssetUrl(path: string) {
	path = resolveEditorImportedImage(path);
	if (/^https?:\/\//.test(path)) return path;
	if (path.startsWith("data:image/jpeg;base64,")) return path;
	const wallpaper = path.match(
		/^cap-web-wallpaper:\/\/assets\/backgrounds\/(macOS|blue|purple|cities|dark|orange)\/([a-z0-9-]+)\.jpg$/,
	);
	if (wallpaper) {
		return `/editor-solid/assets/backgrounds/${wallpaper[1]}/${wallpaper[2]}.jpg`;
	}
	if (path.startsWith("/api/")) return path;
	return assetBase
		? `${assetBase}${assetBase.includes("?") ? "&" : "?"}path=${encodeURIComponent(path)}`
		: "";
}
