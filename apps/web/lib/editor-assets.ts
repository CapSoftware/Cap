export type EditorAssetKind = "audio" | "image";

export const MAX_EDITOR_AUDIO_BYTES = 32 * 1024 * 1024;
export const MAX_EDITOR_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_EDITOR_IMAGE_PIXELS = 16_777_216;

export const EDITOR_AUDIO_CONTENT_TYPES: Record<string, string> = {
	ogg: "audio/ogg",
	m4a: "audio/mp4",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	aac: "audio/aac",
	flac: "audio/flac",
};

export const EDITOR_IMAGE_CONTENT_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
	tiff: "image/tiff",
};

export function canonicalEditorAssetExtension(
	kind: EditorAssetKind,
	fileName: string,
) {
	const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? "";
	if (kind === "image" && extension === "jpeg") return "jpg";
	if (kind === "image" && extension === "tif") return "tiff";
	return extension;
}

export function editorAssetExtension(
	kind: EditorAssetKind,
	fileName: string,
	size: number,
	contentType: string,
) {
	if (
		fileName.length < 1 ||
		fileName.length > 100 ||
		fileName.split("").some((character) => {
			const code = character.charCodeAt(0);
			return (
				code < 32 || code === 127 || character === "/" || character === "\\"
			);
		}) ||
		!Number.isSafeInteger(size) ||
		size < 1 ||
		size > (kind === "audio" ? MAX_EDITOR_AUDIO_BYTES : MAX_EDITOR_IMAGE_BYTES)
	) {
		return null;
	}
	const extension = canonicalEditorAssetExtension(kind, fileName);
	const types =
		kind === "audio" ? EDITOR_AUDIO_CONTENT_TYPES : EDITOR_IMAGE_CONTENT_TYPES;
	return types[extension] === contentType ? extension : null;
}

export function editorAssetKey(
	ownerId: string,
	videoId: string,
	kind: EditorAssetKind,
	path: string,
) {
	return kind === "audio"
		? `${ownerId}/${videoId}/editor-assets/${path.slice("assets/audio/".length)}`
		: `${ownerId}/${videoId}/editor-assets/images/${path.slice("content/images/".length)}`;
}

export function validEditorAssetMeasurement(
	kind: EditorAssetKind,
	value: { duration?: number; width?: number; height?: number },
): { duration: number } | { width: number; height: number } | null {
	if (kind === "audio") {
		const { duration } = value;
		return typeof duration === "number" &&
			Number.isFinite(duration) &&
			duration > 0 &&
			duration <= 86_400
			? { duration }
			: null;
	}
	const { width, height } = value;
	return typeof width === "number" &&
		typeof height === "number" &&
		Number.isSafeInteger(width) &&
		Number.isSafeInteger(height) &&
		width > 0 &&
		height > 0 &&
		width <= 32_768 &&
		height <= 32_768 &&
		width * height <= MAX_EDITOR_IMAGE_PIXELS
		? { width, height }
		: null;
}
