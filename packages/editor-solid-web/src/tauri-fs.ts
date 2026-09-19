import {
	registerEditorImportedImage,
	resolveEditorImportedImage,
} from "./editor-file-mapping";
import { importEditorBrowserImage } from "./tauri-bridge";
import { BaseDirectory } from "./tauri-path";

export { BaseDirectory };

const imageTypes: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
	tif: "image/tiff",
	tiff: "image/tiff",
};

export async function writeFile(
	path: string,
	bytes: Uint8Array,
	options?: { baseDir?: number },
) {
	if (
		options?.baseDir !== BaseDirectory.AppData ||
		path.includes("/") ||
		path.includes("\\")
	) {
		throw new Error("This editor file cannot be saved in the browser");
	}
	const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
	const contentType = imageTypes[extension];
	if (
		!contentType ||
		bytes.byteLength < 1 ||
		bytes.byteLength > 64 * 1024 * 1024
	) {
		throw new Error("Unsupported editor background image");
	}
	const fileName = `background-${crypto.randomUUID()}.${extension}`;
	if (!(bytes.buffer instanceof ArrayBuffer)) {
		throw new Error("Invalid editor image buffer");
	}
	const file = new File(
		[bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)],
		fileName,
		{ type: contentType },
	);
	const imported = await importEditorBrowserImage(file);
	registerEditorImportedImage(
		`cap-web-editor://app-data/${path}`,
		imported.path,
	);
}

export async function exists(path: string) {
	return resolveEditorImportedImage(path) !== path;
}

export async function readDir(_path: string) {
	return [] as Array<{ name: string; isFile: boolean; isDirectory: boolean }>;
}

export async function remove(_path: string) {}

export async function writeTextFile(path: string, contents: string) {
	const prefix = "cap-web-editor://download/";
	if (!path.startsWith(prefix)) {
		throw new Error("The caption file destination is unavailable");
	}
	const fileName = decodeURIComponent(path.slice(prefix.length));
	if (
		!/^[^/\\]{1,140}\.(srt|vtt)$/.test(fileName) ||
		fileName.split("").some((character) => {
			const code = character.charCodeAt(0);
			return code < 32 || code === 127;
		})
	) {
		throw new Error("Invalid caption download name");
	}
	const url = URL.createObjectURL(
		new Blob([contents], { type: "text/plain;charset=utf-8" }),
	);
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	link.hidden = true;
	document.body.append(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
