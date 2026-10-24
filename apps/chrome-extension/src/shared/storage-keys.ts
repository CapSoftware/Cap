// Storage keys shared with the content bootstrap script. The bootstrap is
// injected into every page and must stay a few KB of dependency-free code,
// so it imports the keys it needs from here instead of pulling in the full
// storage module. Everything else keeps importing them via ./storage, which
// re-exports these constants, so both sides always agree on the key names.
export const RECORDING_STATE_KEY = "cap-extension-recording-state";
export const SHARED_UI_STATE_KEY = "cap-extension-shared-ui-state";
