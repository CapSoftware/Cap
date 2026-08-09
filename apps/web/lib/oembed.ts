import type { PublicShareVideo } from "@/lib/public-share-video";

const DEFAULT_WIDTH = 800;
const DEFAULT_HEIGHT = 450;
const MAX_DIMENSION = 1920;

export type OEmbedVideo = {
	version: "1.0";
	type: "video";
	provider_name: "Cap";
	provider_url: string;
	title: string;
	author_name?: string;
	cache_age: number;
	html: string;
	width: number;
	height: number;
	thumbnail_url?: string;
	thumbnail_width?: number;
	thumbnail_height?: number;
	duration?: number;
};

const parsePositiveDimension = (value: string | undefined) => {
	if (value === undefined) return undefined;
	const number = Number(value);
	if (!Number.isFinite(number) || number <= 0) return undefined;
	return Math.min(Math.floor(number), MAX_DIMENSION);
};

const scaleDimensions = ({
	sourceWidth,
	sourceHeight,
	maxWidth,
	maxHeight,
}: {
	sourceWidth: number;
	sourceHeight: number;
	maxWidth?: number;
	maxHeight?: number;
}) => {
	const widthScale = maxWidth ? maxWidth / sourceWidth : 1;
	const heightScale = maxHeight ? maxHeight / sourceHeight : 1;
	const scale = Math.min(1, widthScale, heightScale);

	return {
		width: Math.max(1, Math.round(sourceWidth * scale)),
		height: Math.max(1, Math.round(sourceHeight * scale)),
	};
};

export const parseCapShareUrl = (value: string) => {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}

	if (url.protocol !== "https:") return null;
	const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
	const segments = url.pathname.split("/").filter(Boolean);
	let videoId: string | undefined;

	if (hostname === "cap.so" && segments.length === 2 && segments[0] === "s") {
		videoId = segments[1];
	}
	if (
		hostname === "cap.link" &&
		segments.length === 1 &&
		segments[0] !== "video"
	) {
		videoId = segments[0];
	}

	if (!videoId || !/^[A-Za-z0-9_-]{1,128}$/.test(videoId)) return null;
	return videoId;
};

export const buildOEmbedVideo = ({
	video,
	webUrl,
	maxWidth,
	maxHeight,
}: {
	video: PublicShareVideo;
	webUrl: string;
	maxWidth?: string;
	maxHeight?: string;
}): OEmbedVideo => {
	const parsedMaxWidth = parsePositiveDimension(maxWidth);
	const parsedMaxHeight = parsePositiveDimension(maxHeight);
	const sourceWidth =
		video.width && video.width > 0 ? video.width : DEFAULT_WIDTH;
	const sourceHeight =
		video.height && video.height > 0 ? video.height : DEFAULT_HEIGHT;
	const dimensions = scaleDimensions({
		sourceWidth,
		sourceHeight,
		maxWidth: parsedMaxWidth,
		maxHeight: parsedMaxHeight,
	});
	const embedUrl = new URL(`/embed/${video.id}`, webUrl).toString();
	const thumbnailUrl = new URL("/api/video/og", webUrl);
	thumbnailUrl.searchParams.set("videoId", video.id);
	const html = `<iframe src="${embedUrl}" width="${dimensions.width}" height="${dimensions.height}" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen title="Cap video player" style="border:0;width:100%;aspect-ratio:${dimensions.width}/${dimensions.height}" loading="lazy"></iframe>`;

	return {
		version: "1.0",
		type: "video",
		provider_name: "Cap",
		provider_url: new URL("/", webUrl).toString(),
		title: video.name,
		...(video.ownerName ? { author_name: video.ownerName } : {}),
		cache_age: 300,
		html,
		width: dimensions.width,
		height: dimensions.height,
		...((parsedMaxWidth === undefined || parsedMaxWidth >= 1200) &&
		(parsedMaxHeight === undefined || parsedMaxHeight >= 630)
			? {
					thumbnail_url: thumbnailUrl.toString(),
					thumbnail_width: 1200,
					thumbnail_height: 630,
				}
			: {}),
		...(video.duration && video.duration > 0
			? { duration: Math.round(video.duration) }
			: {}),
	};
};
