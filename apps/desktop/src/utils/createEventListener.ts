import { onCleanup } from "solid-js";
import { events } from "./tauri";

type EventListener<T> = {
	listen: (cb: (event: { payload: T }) => void) => Promise<() => void>;
};

type EventKey = keyof typeof events;

/**
 * A SolidJS utility function that creates an event listener with automatic cleanup on unmount.
 *
 * @param eventListener - An event listener object from the events proxy (e.g., events.recordingDeleted)
 * @param callback - The callback function to execute when the event is received
 *
 * @example
 * ```tsx
 * import { createEventListener } from "~/utils/createEventListener";
 * import { events } from "~/utils/tauri";
 *
 * function MyComponent() {
 *   createEventListener(events.recordingDeleted, () => {
 *     console.log("Recording was deleted!");
 *   });
 *
 *   return <div>My Component</div>;
 * }
 * ```
 */
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

/**
 * Alternative version that accepts the event key directly for more flexibility.
 *
 * @param eventKey - The key of the event from the events object (e.g., "recordingDeleted")
 * @param callback - The callback function to execute when the event is received
 *
 * @example
 * ```tsx
 * createEventListenerByKey("recordingDeleted", (payload) => {
 *   console.log("Recording deleted:", payload);
 * });
 * ```
 */
export function createEventListenerByKey<K extends EventKey>(
	eventKey: K,
	callback: (
		payload: (typeof events)[K] extends EventListener<infer T> ? T : never,
	) => void,
): void {
	const eventListener = events[eventKey] as EventListener<any>;
	createTauriEventListener(eventListener, callback);
}
