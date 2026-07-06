import { TARGET } from "../platform/target";

// Storage keys shared with the content bootstrap script. The bootstrap is
// injected into every page and must stay a few KB of dependency-free code,
// so it imports the keys it needs from here instead of pulling in the full
// storage module. Everything else keeps importing them via ./storage, which
// re-exports these constants, so both sides always agree on the key names.
export const RECORDING_STATE_KEY = "cap-extension-recording-state";
export const SHARED_UI_STATE_KEY = "cap-extension-shared-ui-state";

// Which storage area carries the cross-context shared state. Chrome uses
// storage.session (widened to content scripts via setAccessLevel). Firefox
// exposes neither storage.session nor setAccessLevel to content scripts, so
// the same keys live in storage.local there and the background clears them
// on browser startup to restore session semantics.
export const SHARED_STATE_AREA: "session" | "local" =
	TARGET === "firefox" ? "local" : "session";
