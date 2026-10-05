import { createEventListener } from "@solid-primitives/event-listener";
import { createSignal } from "solid-js";

/// The web editor's playback reports when playing is waiting on media; the
/// desktop editor never does, so its indicator stays off.
const BUFFERING_EVENT = "cap-editor-buffering";
const PLAY_REQUEST_EVENT = "cap-editor-play-requested";

let buffering = false;
let playRequest: boolean | null = null;

export function reportPlaybackBuffering(next: boolean) {
	if (next === buffering) return;
	buffering = next;
	if (typeof window === "undefined") return;
	window.dispatchEvent(new CustomEvent(BUFFERING_EVENT, { detail: next }));
}

export function createPlaybackBuffering() {
	const [value, setValue] = createSignal(buffering);
	createEventListener(window, BUFFERING_EVENT, (event) =>
		setValue((event as CustomEvent<boolean>).detail === true),
	);
	return value;
}

/// Play (or pause) pressed while the editor is still loading, for the editor
/// to act on once it has mounted.
export function requestPlayWhenReady(playing: boolean) {
	playRequest = playing;
	window.dispatchEvent(new Event(PLAY_REQUEST_EVENT));
}

/// Hands `apply` each request made before or after this runs, once.
export function onPlayRequest(apply: (playing: boolean) => void) {
	const take = () => {
		if (playRequest === null) return;
		const playing = playRequest;
		playRequest = null;
		apply(playing);
	};
	createEventListener(window, PLAY_REQUEST_EVENT, take);
	take();
}
