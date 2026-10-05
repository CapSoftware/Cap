import type { Metadata } from "next";
import {
	DEFAULT_LINK_PREVIEW_DESCRIPTION,
	defaultLinkPreviewTitle,
} from "./share-link-preview";

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
	/**
	 * Two surfaces only answer on the default Cap origin: `proxy.ts` redirects
	 * `/embed/` away from a custom domain, and `parseCapShareUrl` accepts share
	 * URLs on `cap.so` and `cap.link` alone, so `/api/oembed` rejects a custom
	 * domain `url`. Defaults to `webUrl`.
	 */
	canonicalWebUrl?: string;
	advertiseIframelyPlayer?: boolean;
	/** The owner's link preview overrides; blank parts keep the defaults. */
	linkPreview?: ShareVideoLinkPreview | null;
	/**
	 * Where search engines should index the Cap: its organization's verified
	 * custom domain when it has one. `og:url` keeps the visited host, since
	 * Slack drops the image when that differs from the link it unfurls.
	 */
	canonicalShareUrl?: string | null;
};

export type ShareVideoLinkPreview = {
	title: string | null;
	description: string | null;
	image: {
		url: string;
		width: number;
		height: number;
		type: string;
	} | null;
};

export const getShareVideoUrls = ({
	videoId,
	sourceType,
	webUrl,
	canonicalWebUrl = webUrl,
}: Pick<
	ShareVideoMetadataInput,
	"videoId" | "sourceType" | "webUrl" | "canonicalWebUrl"
>) => {
	const shareUrl = new URL(`/s/${videoId}`, webUrl).toString();
	const canonicalShareUrl = new URL(
		`/s/${videoId}`,
		canonicalWebUrl,
	).toString();
	const playerUrl = new URL(`/embed/${videoId}`, canonicalWebUrl).toString();
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
	const oEmbedUrl = new URL("/api/oembed", canonicalWebUrl);
	oEmbedUrl.searchParams.set("url", canonicalShareUrl);
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
	canonicalWebUrl,
	advertiseIframelyPlayer = false,
	linkPreview,
	canonicalShareUrl,
}: ShareVideoMetadataInput): Metadata => {
	const urls = getShareVideoUrls({
		videoId,
		sourceType,
		webUrl,
		canonicalWebUrl,
	});
	const title = linkPreview?.title ?? defaultLinkPreviewTitle(name);
	const description =
		linkPreview?.description ?? DEFAULT_LINK_PREVIEW_DESCRIPTION;
	const customImage = linkPreview?.image ?? null;

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
			canonical: canonicalShareUrl ?? urls.shareUrl,
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
			// Apps take the first image they can use, so a chosen image is the
			// only one offered.
			images: customImage
				? [customImage]
				: [
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
			images: customImage
				? [customImage.url]
				: [urls.previewImageUrl, urls.ogImageUrl],
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
