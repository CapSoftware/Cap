import { loadBrowserRenderer } from "./browser-renderer";

// The web export worker renders text with Debian's fonts-dejavu-core, so the
// browser preview registers exactly those faces for identical shaping.
const FONT_URLS = [
	new URL("../fonts/dejavu/DejaVuSans.ttf", import.meta.url),
	new URL("../fonts/dejavu/DejaVuSans-Bold.ttf", import.meta.url),
	new URL("../fonts/dejavu/DejaVuSerif.ttf", import.meta.url),
	new URL("../fonts/dejavu/DejaVuSerif-Bold.ttf", import.meta.url),
	new URL("../fonts/dejavu/DejaVuSansMono.ttf", import.meta.url),
	new URL("../fonts/dejavu/DejaVuSansMono-Bold.ttf", import.meta.url),
];

export const BROWSER_RENDERER_FONT_FAMILIES = [
	"DejaVu Sans",
	"DejaVu Sans Mono",
	"DejaVu Serif",
];

let pending: Promise<void> | null = null;

export function ensureBrowserRendererFonts() {
	if (!pending) {
		pending = Promise.all([
			loadBrowserRenderer(),
			...FONT_URLS.map(async (url) => {
				const response = await fetch(url);
				if (!response.ok) throw new Error("Editor fonts could not load");
				return new Uint8Array(await response.arrayBuffer());
			}),
		])
			.then(([module, ...fonts]) => {
				for (const font of fonts) module.register_font(font);
			})
			.catch((error: unknown) => {
				pending = null;
				throw error;
			});
	}
	return pending;
}
