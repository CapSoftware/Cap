import { onCleanup } from "solid-js";
import { events } from "./tauri";
import {
  listen,
  type UnlistenFn,
  type EventCallback as TauriEventCallback,
  type EventName as TauriEventName,
} from "@tauri-apps/api/event";

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
 *   createTauriEventListener(events.recordingDeleted, () => {
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
	const unlisten = eventListener.listen((event) => {
		callback(event.payload);
	});

	onCleanup(() => {
		unlisten.then((cleanup) => cleanup());
	});
}

/**
 * A SolidJS utility function that creates an custom event listener with automatic cleanup on unmount.
 *
 * @param event Event name. Must include only alphanumeric characters, `-`, `/`, `:` and `_`.
 * @param handler Event handler callback.
 *
 * @example
 * ```tsx
 * import { createEventListener } from "~/utils/createEventListener";
 * import { events } from "~/utils/tauri";
 *
 * function MyComponent() {
 *   createCustomTauriEventListener<{ pending: boolean }>("customWindowPending", (e) => {
 *     console.log(`Window pending: ${e.payload}`);
 *   });
 *
 *   return <div>My Component</div>;
 * }
 * ```
 */
export function createCustomTauriEventListener<T>(
  name: TauriEventName,
  callback: TauriEventCallback<T>
): void {
  const unlisten = listen(name, callback);
  onCleanup(() => unlisten.then((cleanup) => cleanup()));
}

/**
 * Registers a Tauri event unlisten function for automatic cleanup on component unmount.
 *
 * This utility is useful when you have a Tauri event listener that returns a Promise resolving to an unlisten function,
 * and you want to ensure the listener is properly removed when the component is destroyed.
 *
 * @param promise - A Promise that resolves to a Tauri unlisten function.
 *
 * @example
 * ```tsx
 * import { getCurrentWindow } from "@tauri-apps/api/window";
 * import { withTauriUnlisten } from "~/utils/createEventListener";
 *
 *
 * withTauriUnlisten(getCurrentWindow().onCloseRequested((event) => {
 *   // handle event
 * });
 *
 * ```
 */
export function createTauriEventUnlisten(promise: Promise<UnlistenFn>) {
  onCleanup(() => promise.then((unlisten) => unlisten()));
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
