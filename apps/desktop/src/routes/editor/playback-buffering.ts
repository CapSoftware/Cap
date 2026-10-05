import { createEventListener } from "@solid-primitives/event-listener";
import { createSignal } from "solid-js";

/// The web editor's playback reports when playing is waiting on media; the
/// desktop editor never does, so its indicator stays off.
const BUFFERING_EVENT = "cap-editor-buffering";
const PLAY_REQUEST_EVENT = "cap-editor-play-requested";

let buffering = false;
let playRequest: boolean | null = null;
let lastPlayRequest = false;

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
	lastPlayRequest = playing;
	window.dispatchEvent(new Event(PLAY_REQUEST_EVENT));
}

/// For when an editor attempt ends before taking the press, so a retry in
/// the same page doesn't start playing without a press of its own.
export function clearPlayRequest() {
	if (playRequest === null && !lastPlayRequest) return;
	playRequest = null;
	lastPlayRequest = false;
	if (typeof window === "undefined") return;
	window.dispatchEvent(new Event(PLAY_REQUEST_EVENT));
}

/// Outlives the request being taken, so every loading screen, including one
/// still covering the mounted editor, shows the same press.
export function createPlayRequested() {
	const [value, setValue] = createSignal(lastPlayRequest);
	createEventListener(window, PLAY_REQUEST_EVENT, () =>
		setValue(lastPlayRequest),
	);
	return value;
}

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
