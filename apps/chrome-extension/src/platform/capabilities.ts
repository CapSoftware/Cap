import { TARGET } from "./target";

// Per-target feature availability. Firefox has no chrome.offscreen or
// chrome.tabCapture, its getDisplayMedia exposes no system audio or per-tab
// surface, MV3 host permissions are user-grantable rather than granted at
// install, and getDisplayMedia requires transient user activation so capture
// cannot start without a click inside the recorder document.
export const capabilities = {
	supportsTabCapture: TARGET === "chrome",
	supportsOffscreen: TARGET === "chrome",
	supportsSystemAudioCapture: TARGET === "chrome",
	hostPermissionsGrantedAtInstall: TARGET === "chrome",
	recorderNeedsUserGesture: TARGET === "firefox",
} as const;
