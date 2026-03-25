import { onCleanup } from "solid-js";
import { events } from "./tauri";

type EventListener<T> = {
	listen: (cb: (event: { payload: T }) => void) => Promise<() => void>;
};

type EventKey = keyof typeof events;
type EventPayload<T> = T extends {
	listen: (
		cb: (event: { payload: infer Payload }) => void,
	) => Promise<() => void>;
}
	? Payload
	: never;

export function createTauriEventListener<T>(
	eventListener: EventListener<T>,
	callback: (payload: T) => void,
): void {
	let aborted = false;
	const unlisten = eventListener.listen((event) => {
		if (aborted) return;
		callback(event.payload);
	});

	onCleanup(() => {
		aborted = true;
		unlisten.then((cleanup) => cleanup());
	});
}
export function createEventListenerByKey<K extends EventKey>(
	eventKey: K,
	callback: (payload: EventPayload<(typeof events)[K]>) => void,
): void {
	createTauriEventListener(
		events[eventKey] as unknown as EventListener<
			EventPayload<(typeof events)[K]>
		>,
		callback,
	);
}
