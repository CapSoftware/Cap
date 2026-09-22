import { registerEditorChannel } from "./channels";
import { resolveEditorAssetUrl, setEditorAssetBase } from "./editor-asset-url";
import {
	importEditorBrowserImage,
	invokeEditorTauriCommand,
} from "./tauri-bridge";
import { takeEditorSelectedFile } from "./tauri-dialog";

let nextChannelId = 1;

export { setEditorAssetBase };

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
	return resolveEditorAssetUrl(path);
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
