import { BrowserDecodedVideoPool } from "../src/browser-decoded-video-pool";
import { BrowserImageDecoder } from "../src/browser-image-decoder";
import { BrowserLocalPlayback } from "../src/browser-local-playback";

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
