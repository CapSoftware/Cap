import type { EmbedOptions } from "../types";

const DEFAULT_API_BASE = "https://cap.so";

export function createEmbedUrl(options: EmbedOptions): string {
	const base = options.apiBase ?? DEFAULT_API_BASE;
	const params = new URLSearchParams();
	params.set("sdk", "1");
	params.set("pk", options.publicKey);
	if (options.autoplay) params.set("autoplay", "1");
	if (options.branding?.logoUrl) params.set("logo", options.branding.logoUrl);
	if (options.branding?.accentColor)
		params.set("accent", options.branding.accentColor);
	return `${base}/embed/${options.videoId}?${params.toString()}`;
}

export function createEmbedIframe(
	container: HTMLElement | string,
	options: EmbedOptions,
): HTMLIFrameElement {
	const target =
		typeof container === "string"
			? document.querySelector(container)
			: container;

	if (!target) {
		throw new Error(`Container not found: ${container}`);
	}

	const iframe = document.createElement("iframe");
	iframe.src = createEmbedUrl(options);
	iframe.style.width = "100%";
	iframe.style.height = "100%";
	iframe.style.border = "none";
	iframe.style.borderRadius = "8px";
	iframe.allow = "autoplay; fullscreen; picture-in-picture";
	iframe.setAttribute("loading", "lazy");

	target.appendChild(iframe);
	return iframe;
}
