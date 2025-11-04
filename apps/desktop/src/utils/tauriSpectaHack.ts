// Workaround for: https://github.com/specta-rs/tauri-specta/issues/187

import type * as TAURI_API_EVENT from "@tauri-apps/api/event";
import type { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { events } from "./tauri";

type __EventObj__<T> = {
	listen: (
		cb: TAURI_API_EVENT.EventCallback<T>,
	) => ReturnType<typeof TAURI_API_EVENT.listen<T>>;
	once: (
		cb: TAURI_API_EVENT.EventCallback<T>,
	) => ReturnType<typeof TAURI_API_EVENT.once<T>>;
	emit: null extends T
		? (payload?: T) => ReturnType<typeof TAURI_API_EVENT.emit>
		: (payload: T) => ReturnType<typeof TAURI_API_EVENT.emit>;
};

const mappings = {
	setCaptureAreaPending: "set-capture-area-pending",
};

export const emitTo = <K extends keyof typeof mappings>(
	webview: WebviewWindow,
	event: K,
	target: string,
	value: (typeof events)[K] extends __EventObj__<infer U> ? U : never,
) => webview.emitTo(target, mappings[event], value);
