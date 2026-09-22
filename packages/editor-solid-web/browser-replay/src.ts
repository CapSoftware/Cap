import { BrowserImageDecoder } from "../src/browser-image-decoder";
import { BrowserLocalPlayback } from "../src/browser-local-playback";

declare global {
	interface Window {
		CapBrowserLocalPlayback: typeof BrowserLocalPlayback;
		CapBrowserImageDecoder: typeof BrowserImageDecoder;
	}
}

window.CapBrowserLocalPlayback = BrowserLocalPlayback;
window.CapBrowserImageDecoder = BrowserImageDecoder;
