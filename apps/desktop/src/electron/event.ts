import { bridge, toIpcValue } from "./bridge";

export type UnlistenFn = () => void;

export interface Event<T> {
	event: string;
	id: number;
	payload: T;
}

export type EventCallback<T> = (event: Event<T>) => void;

let nextEventId = 1;

export async function listen<T = unknown>(
	event: string,
	handler: EventCallback<T>,
): Promise<UnlistenFn> {
	const id = nextEventId++;
	return bridge().onEvent((message) => {
		if (message.event === event)
			handler({ event, id, payload: message.payload as T });
	});
}

export async function once<T = unknown>(
	event: string,
	handler: EventCallback<T>,
): Promise<UnlistenFn> {
	let unlisten = () => {};
	unlisten = await listen<T>(event, (payload) => {
		unlisten();
		handler(payload);
	});
	return unlisten;
}

export async function emit(event: string, payload?: unknown): Promise<void> {
	bridge().emit(event, toIpcValue(payload ?? null));
}

export async function emitTo(
	_target: string,
	event: string,
	payload?: unknown,
): Promise<void> {
	bridge().emit(event, toIpcValue(payload ?? null));
}
