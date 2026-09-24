import { extname } from "node:path";
import { runEditorFile as runFile } from "./editor-process";
import {
	type SignedEditorAsset,
	stageSignedEditorAsset,
} from "./editor-signed-assets";

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_777_216;
const ASSET_PATH =
	/^content\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp|gif|bmp|tiff)$/;
const CONTENT_TYPES: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
	tiff: "image/tiff",
};
export type EditorImageAsset = SignedEditorAsset;

export function validateEditorImageAsset(asset: EditorImageAsset) {
	const url = new URL(asset.url);
	const match = ASSET_PATH.exec(asset.path);
	if (
		!match ||
		CONTENT_TYPES[match[1] ?? ""] !== asset.contentType ||
		asset.name.length < 1 ||
		asset.name.length > 100 ||
		asset.name.split("").some((character) => {
			const code = character.charCodeAt(0);
			return (
				code < 32 || code === 127 || character === "/" || character === "\\"
			);
		}) ||
		!Number.isSafeInteger(asset.size) ||
		asset.size < 1 ||
		asset.size > MAX_IMAGE_BYTES ||
		(url.protocol !== "https:" &&
			!(
				url.protocol === "http:" &&
				process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA === "1"
			)) ||
		url.username ||
		url.password ||
		(asset.objectIdentity != null &&
			(asset.objectIdentity.length < 1 || asset.objectIdentity.length > 256))
	) {
		throw new Error("Invalid editor image asset");
	}
}

async function probeImage(path: string) {
	const binary = process.env.CAP_WEB_EDITOR_PREPARE_BIN;
	if (!binary) throw new Error("Native image inspector is unavailable");
	const { stdout } = await runFile(binary, ["inspect-image", path], {
		timeout: 30_000,
		maxBuffer: 64 * 1024,
	}).catch(() => {
		throw new Error("Imported file has no decodable image");
	});
	const data: unknown = JSON.parse(stdout);
	const extension = extname(path).slice(1);
	if (
		typeof data !== "object" ||
		data === null ||
		!("extension" in data) ||
		data.extension !== extension
	) {
		throw new Error("Imported image format does not match its file name");
	}
	const width = "width" in data ? data.width : null;
	const height = "height" in data ? data.height : null;
	if (
		typeof width !== "number" ||
		typeof height !== "number" ||
		!Number.isInteger(width) ||
		!Number.isInteger(height) ||
		width < 1 ||
		height < 1
	) {
		throw new Error("Imported file has no decodable image");
	}
	if (width > 32_768 || height > 32_768 || width * height > MAX_IMAGE_PIXELS) {
		throw new Error("Imported image dimensions are too large");
	}
	return { width, height };
}

export async function stageSignedEditorImageAsset(
	projectPath: string,
	asset: EditorImageAsset,
	abortSignal?: AbortSignal,
) {
	validateEditorImageAsset(asset);
	return stageSignedEditorAsset(projectPath, asset, probeImage, abortSignal);
}
