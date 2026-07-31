import { Video } from "@cap/web-domain";
import { parseCapShareUrl } from "@/lib/oembed";
import {
	getPublicShareVideo,
	type PublicShareVideo,
} from "@/lib/public-share-video";
import { sendSlackUnfurl } from "./client";
import {
	deleteSlackInstallationByTeamId,
	getSlackInstallationToken,
} from "./installations";

type SlackLink = {
	domain: string;
	url: string;
};

export type SlackLinkSharedEvent = {
	type: "link_shared";
	channel: string;
	message_ts: string;
	unfurl_id?: string;
	source?: string;
	links: SlackLink[];
};

export type SlackEventPayload =
	| {
			type: "event_callback";
			team_id: string;
			event_id?: string;
			event: SlackLinkSharedEvent | { type: "app_uninstalled" };
	  }
	| {
			type: "url_verification";
			challenge: string;
	  };

const truncate = (value: string, maxLength: number) =>
	Array.from(value).slice(0, maxLength).join("");

const formatDuration = (duration: number | null) => {
	if (!duration || duration <= 0) return "Watch this recording on Cap";
	const seconds = Math.round(duration);
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return `Watch this ${minutes}:${remainder.toString().padStart(2, "0")} recording on Cap`;
};

export const buildSlackVideoBlock = ({
	video,
	shareUrl,
	webUrl,
}: {
	video: PublicShareVideo;
	shareUrl: string;
	webUrl: string;
}) => {
	const title = truncate(video.name.trim() || "Cap recording", 199);
	const embedUrl = new URL(`/embed/${video.id}`, webUrl);
	embedUrl.searchParams.set("autoplay", "true");
	embedUrl.searchParams.set("slack", "true");
	const thumbnailUrl = new URL("/api/video/og", webUrl);
	thumbnailUrl.searchParams.set("videoId", video.id);

	return {
		type: "video",
		title: {
			type: "plain_text",
			text: title,
			emoji: true,
		},
		title_url: shareUrl,
		description: {
			type: "plain_text",
			text: formatDuration(video.duration),
			emoji: true,
		},
		video_url: embedUrl.toString(),
		alt_text: truncate(`Watch ${video.name}`, 200),
		thumbnail_url: thumbnailUrl.toString(),
		provider_name: "Cap",
		...(video.ownerName ? { author_name: truncate(video.ownerName, 49) } : {}),
	};
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const parseSlackEventPayload = (
	value: unknown,
): SlackEventPayload | null => {
	if (!isRecord(value) || typeof value.type !== "string") return null;
	if (
		value.type === "url_verification" &&
		typeof value.challenge === "string"
	) {
		return { type: "url_verification", challenge: value.challenge };
	}
	if (
		value.type !== "event_callback" ||
		typeof value.team_id !== "string" ||
		!isRecord(value.event) ||
		typeof value.event.type !== "string"
	) {
		return null;
	}
	if (value.event.type === "app_uninstalled") {
		return {
			type: "event_callback",
			team_id: value.team_id,
			event_id: typeof value.event_id === "string" ? value.event_id : undefined,
			event: { type: "app_uninstalled" },
		};
	}
	if (
		value.event.type !== "link_shared" ||
		typeof value.event.channel !== "string" ||
		typeof value.event.message_ts !== "string" ||
		!Array.isArray(value.event.links)
	) {
		return null;
	}

	const links = value.event.links
		.filter(isRecord)
		.filter(
			(link): link is SlackLink =>
				typeof link.domain === "string" && typeof link.url === "string",
		);
	if (links.length === 0) return null;

	return {
		type: "event_callback",
		team_id: value.team_id,
		event_id: typeof value.event_id === "string" ? value.event_id : undefined,
		event: {
			type: "link_shared",
			channel: value.event.channel,
			message_ts: value.event.message_ts,
			unfurl_id:
				typeof value.event.unfurl_id === "string"
					? value.event.unfurl_id
					: undefined,
			source:
				typeof value.event.source === "string" ? value.event.source : undefined,
			links,
		},
	};
};

type ProcessSlackEventDependencies = {
	deleteInstallation: typeof deleteSlackInstallationByTeamId;
	getInstallationToken: typeof getSlackInstallationToken;
	getVideo: typeof getPublicShareVideo;
	sendUnfurl: typeof sendSlackUnfurl;
};

const defaultDependencies: ProcessSlackEventDependencies = {
	deleteInstallation: deleteSlackInstallationByTeamId,
	getInstallationToken: getSlackInstallationToken,
	getVideo: getPublicShareVideo,
	sendUnfurl: sendSlackUnfurl,
};

export const processSlackEvent = async ({
	payload,
	webUrl,
	dependencies = defaultDependencies,
}: {
	payload: Exclude<SlackEventPayload, { type: "url_verification" }>;
	webUrl: string;
	dependencies?: ProcessSlackEventDependencies;
}) => {
	if (payload.event.type === "app_uninstalled") {
		await dependencies.deleteInstallation(payload.team_id);
		return;
	}

	const token = await dependencies.getInstallationToken(payload.team_id);
	if (!token) return;

	const uniqueLinks = [
		...new Map(payload.event.links.map((link) => [link.url, link])).values(),
	].slice(0, 5);
	const resolved = await Promise.all(
		uniqueLinks.map(async (link) => {
			const videoId = parseCapShareUrl(link.url);
			if (!videoId) return null;
			const video = await dependencies.getVideo(Video.VideoId.make(videoId));
			if (!video) return null;
			const shareUrl = new URL(`/s/${video.id}`, webUrl).toString();
			const blocks: unknown[] = [
				buildSlackVideoBlock({ video, shareUrl, webUrl }),
			];
			return [
				link.url,
				{
					blocks,
				},
			] as const;
		}),
	);
	const unfurls = Object.fromEntries(
		resolved.filter(
			(entry): entry is NonNullable<typeof entry> => entry !== null,
		),
	);
	if (Object.keys(unfurls).length === 0) return;

	await dependencies.sendUnfurl({
		token,
		event: {
			channel: payload.event.channel,
			messageTs: payload.event.message_ts,
			unfurlId: payload.event.unfurl_id,
			source: payload.event.source,
		},
		unfurls,
	});
};
