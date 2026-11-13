import { PLAYBACK_ID_PATTERN } from "./developer-video-playback";

export const DEVELOPER_VIDEO_OEMBED_PATH = "/api/developer/oembed";

// How long a shared cache may answer for a video. The same bound as the
// playback files: a video deleted or taken down stops answering new link
// previews within it.
export const DEVELOPER_VIDEO_OEMBED_CACHE_SECONDS = 60;

const DEFAULT_MAX_WIDTH = 1280;
const DEFAULT_MAX_HEIGHT = 720;
const PAGE_PATH = /^\/dev\/([^/]+)(?:\/embed)?\/?$/;

const hostOf = (url: URL) => url.host.toLowerCase().replace(/^www\./, "");

// Only the hosted pages of this site: /dev/<playbackId> and its /embed.
export function developerVideoPlaybackIdFromUrl(
	value: string,
	webUrl: string,
): string | null {
	let url: URL;
	let site: URL;
	try {
		url = new URL(value);
		site = new URL(webUrl);
	} catch {
		return null;
	}
	if (url.protocol !== site.protocol || hostOf(url) !== hostOf(site)) {
		return null;
	}
	const playbackId = PAGE_PATH.exec(url.pathname)?.[1];
	return playbackId && PLAYBACK_ID_PATTERN.test(playbackId) ? playbackId : null;
}

export function developerVideoOEmbedHref(shareUrl: string, webUrl: string) {
	const query = new URLSearchParams({ url: shareUrl, format: "json" });
	return `${webUrl.replace(/\/+$/, "")}${DEVELOPER_VIDEO_OEMBED_PATH}?${query}`;
}

const dimension = (value: string | null) => {
	if (value === null || !/^\d{1,5}$/.test(value)) return null;
	const number = Number(value);
	return number > 0 ? number : null;
};

const escapeAttribute = (value: string) =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");

export interface DeveloperVideoOEmbed {
	version: "1.0";
	type: "video";
	provider_name: "Cap";
	provider_url: string;
	title: string;
	html: string;
	width: number;
	height: number;
	cache_age: number;
}

export function developerVideoOEmbed({
	name,
	width,
	height,
	embedUrl,
	webUrl,
	maxWidth,
	maxHeight,
}: {
	name: string;
	width: number;
	height: number;
	embedUrl: string;
	webUrl: string;
	maxWidth: string | null;
	maxHeight: string | null;
}): DeveloperVideoOEmbed {
	const boxWidth = Math.min(
		dimension(maxWidth) ?? DEFAULT_MAX_WIDTH,
		DEFAULT_MAX_WIDTH,
	);
	const boxHeight = Math.min(
		dimension(maxHeight) ?? DEFAULT_MAX_HEIGHT,
		DEFAULT_MAX_HEIGHT,
	);
	const scale = Math.min(1, boxWidth / width, boxHeight / height);
	const frameWidth = Math.max(1, Math.round(width * scale));
	const frameHeight = Math.max(1, Math.round(height * scale));
	return {
		version: "1.0",
		type: "video",
		provider_name: "Cap",
		provider_url: webUrl.replace(/\/+$/, ""),
		title: name,
		html: `<iframe src="${escapeAttribute(embedUrl)}" width="${frameWidth}" height="${frameHeight}" title="${escapeAttribute(name)}" style="border: 0" allowfullscreen loading="lazy"></iframe>`,
		width: frameWidth,
		height: frameHeight,
		cache_age: DEVELOPER_VIDEO_OEMBED_CACHE_SECONDS,
	};
}
