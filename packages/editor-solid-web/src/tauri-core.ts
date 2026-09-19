import { registerEditorChannel } from "./channels";
import { resolveEditorImportedImage } from "./editor-file-mapping";
import {
	importEditorBrowserImage,
	invokeEditorTauriCommand,
} from "./tauri-bridge";
import { takeEditorSelectedFile } from "./tauri-dialog";

let assetBase = "";
let nextChannelId = 1;

export function setEditorAssetBase(value: string) {
	assetBase = value.startsWith("/") && !value.startsWith("//") ? value : "";
}

export function invoke<T>(command: string, args?: unknown) {
	if (command === "webEditorImportImage") {
		if (
			typeof args !== "object" ||
			args === null ||
			!("source" in args) ||
			typeof args.source !== "string"
		) {
			return Promise.reject(new Error("Selected editor image is invalid"));
		}
		const file = takeEditorSelectedFile(args.source);
		if (!file) {
			return Promise.reject(new Error("Selected editor image is unavailable"));
		}
		return importEditorBrowserImage(file) as Promise<T>;
	}
	return invokeEditorTauriCommand<T>(command, args);
}

export function convertFileSrc(path: string) {
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

export class Channel<T> {
	readonly id = nextChannelId++;
	onmessage: (message: T) => void;

	constructor(onmessage?: (message: T) => void) {
		this.onmessage = onmessage ?? (() => {});
		registerEditorChannel(this.id, (message: T) => this.onmessage(message));
	}

	toJSON() {
		return `__CHANNEL__:${this.id}`;
	}
}

export class Resource {
	constructor(readonly rid: number) {}

	close() {
		return invoke<void>("plugin:resources|close", { rid: this.rid });
	}
}
