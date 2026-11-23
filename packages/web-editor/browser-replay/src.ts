import { BrowserDecodedVideoPool } from "../src/engine/browser-decoded-video-pool";
import { BrowserImageDecoder } from "../src/engine/browser-image-decoder";
import { BrowserLocalPlayback } from "../src/engine/browser-local-playback";

declare global {
	interface Window {
		CapBrowserLocalPlayback: typeof BrowserLocalPlayback;
		CapBrowserImageDecoder: typeof BrowserImageDecoder;
		CapBrowserDecodedVideoPool: typeof BrowserDecodedVideoPool;
	}
}

window.CapBrowserLocalPlayback = BrowserLocalPlayback;
window.CapBrowserImageDecoder = BrowserImageDecoder;
window.CapBrowserDecodedVideoPool = BrowserDecodedVideoPool;
