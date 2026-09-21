import { BrowserLocalPlayback } from "../src/browser-local-playback";

declare global {
	interface Window {
		CapBrowserLocalPlayback: typeof BrowserLocalPlayback;
	}
}

window.CapBrowserLocalPlayback = BrowserLocalPlayback;
