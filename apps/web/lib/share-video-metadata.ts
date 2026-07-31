import type { Metadata } from "next";

const PLAYER_WIDTH = 1280;
const PLAYER_HEIGHT = 720;

export type ShareVideoSourceType =
	| "MediaConvert"
	| "local"
	| "desktopMP4"
	| "desktopSegments"
	| "webMP4";

export type ShareVideoMetadataInput = {
	videoId: string;
	name: string;
	sourceType: ShareVideoSourceType;
	webUrl: string;
	advertiseIframelyPlayer?: boolean;
};

export const getShareVideoUrls = ({
	videoId,
	sourceType,
	webUrl,
}: Pick<ShareVideoMetadataInput, "videoId" | "sourceType" | "webUrl">) => {
	const shareUrl = new URL(`/s/${videoId}`, webUrl).toString();
	const playerUrl = new URL(`/embed/${videoId}`, webUrl).toString();
	const streamUrl = new URL("/api/playlist", webUrl);
	streamUrl.searchParams.set("videoId", videoId);
	let streamContentType = "application/vnd.apple.mpegurl";
	if (sourceType === "desktopMP4" || sourceType === "webMP4") {
		streamUrl.searchParams.set("videoType", "mp4");
		streamContentType = "video/mp4";
	} else if (sourceType === "desktopSegments") {
		streamUrl.searchParams.set("videoType", "segments-master");
		streamUrl.searchParams.set("requireComplete", "1");
	} else {
		streamUrl.searchParams.set("videoType", "master");
	}
	const previewImageUrl = new URL("/api/video/preview", webUrl);
	previewImageUrl.searchParams.set("videoId", videoId);
	previewImageUrl.searchParams.set("fallback", "og");
	const ogImageUrl = new URL("/api/video/og", webUrl);
	ogImageUrl.searchParams.set("videoId", videoId);
	const oEmbedUrl = new URL("/api/oembed", webUrl);
	oEmbedUrl.searchParams.set("url", shareUrl);
	oEmbedUrl.searchParams.set("format", "json");

	return {
		shareUrl,
		playerUrl,
		streamUrl: streamUrl.toString(),
		streamContentType,
		previewImageUrl: previewImageUrl.toString(),
		ogImageUrl: ogImageUrl.toString(),
		oEmbedUrl: oEmbedUrl.toString(),
	};
};

export const buildShareVideoMetadata = ({
	videoId,
	name,
	sourceType,
	webUrl,
	advertiseIframelyPlayer = false,
}: ShareVideoMetadataInput): Metadata => {
	const urls = getShareVideoUrls({ videoId, sourceType, webUrl });
	const title = `${name} | Cap Recording`;
	const description = "Watch this video on Cap";

	return {
		title,
		description,
		...(advertiseIframelyPlayer
			? {
					icons: {
						other: [
							{
								rel: "iframely player",
								url: urls.playerUrl,
								type: "text/html",
								media: "(aspect-ratio: 16/9)",
							},
						],
					},
				}
			: {}),
		alternates: {
			canonical: urls.shareUrl,
			types: {
				"application/json+oembed": [
					{
						title,
						url: urls.oEmbedUrl,
					},
				],
			},
		},
		openGraph: {
			type: "video.other",
			url: urls.shareUrl,
			siteName: "Cap",
			title,
			description,
			ttl: 300,
			images: [
				{
					url: urls.previewImageUrl,
					width: 480,
					height: 270,
					type: "image/gif",
				},
				{
					url: urls.ogImageUrl,
					width: 1200,
					height: 630,
					type: "image/png",
				},
			],
			videos: [
				{
					url: urls.streamUrl,
					secureUrl: urls.streamUrl,
					width: PLAYER_WIDTH,
					height: PLAYER_HEIGHT,
					type: urls.streamContentType,
				},
			],
		},
		twitter: {
			card: "player",
			title,
			description,
			images: [urls.previewImageUrl, urls.ogImageUrl],
			players: {
				playerUrl: urls.playerUrl,
				streamUrl: urls.streamUrl,
				width: PLAYER_WIDTH,
				height: PLAYER_HEIGHT,
			},
		},
		other: {
			"twitter:player:stream:content_type": urls.streamContentType,
		},
	};
};
