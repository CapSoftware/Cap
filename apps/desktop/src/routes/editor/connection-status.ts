import { createEventListener } from "@solid-primitives/event-listener";
import { createSignal } from "solid-js";

export type ConnectionLevel = "good" | "fair" | "poor" | "offline";

/// The web editor reports how its connection is doing; the desktop editor
/// never does, so the level stays null there.
const CONNECTION_EVENT = "cap-editor-connection-level";

let level: ConnectionLevel | null = null;

export function reportConnectionLevel(next: ConnectionLevel | null) {
	if (next === level) return;
	level = next;
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent(CONNECTION_EVENT, { detail: next }));
}

export function createConnectionLevel() {
	const [value, setValue] = createSignal(level);
	createEventListener(window, CONNECTION_EVENT, (event) =>
		setValue((event as CustomEvent<ConnectionLevel | null>).detail),
	);
	return value;
}
