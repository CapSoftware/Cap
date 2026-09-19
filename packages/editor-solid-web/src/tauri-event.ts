import { emitEditorEvent, listenEditorEvent } from "./tauri-bridge";

export type UnlistenFn = () => void;

export function listen<T>(
	name: string,
	callback: (event: {
		event: string;
		id: number;
		payload: T;
		windowLabel: string;
	}) => void,
) {
	return listenEditorEvent(name, (payload) =>
		callback({
			event: name,
			id: 0,
			payload: payload as T,
			windowLabel: "editor-web",
		}),
	);
}

export async function once<T>(
	name: string,
	callback: (event: {
		event: string;
		id: number;
		payload: T;
		windowLabel: string;
	}) => void,
) {
	let unlisten: UnlistenFn | null = null;
	unlisten = await listen<T>(name, (event) => {
		unlisten?.();
		callback(event);
	});
	return unlisten;
}

export function emit(name: string, payload?: unknown) {
	return emitEditorEvent(name, payload);
}

export function emitTo(_target: string, name: string, payload?: unknown) {
	return emitEditorEvent(name, payload);
}
