import { Video } from "@cap/web-domain";
import { describe, expect, it, vi } from "vitest";
import type { PublicShareVideo } from "@/lib/public-share-video";
import {
	buildSlackVideoBlock,
	parseSlackEventPayload,
	processSlackEvent,
} from "@/lib/slack/unfurl";

const video: PublicShareVideo = {
	id: Video.VideoId.make("abc123"),
	name: "Cap walkthrough",
	ownerId: "owner123",
	ownerName: "Richie",
	sourceType: "desktopMP4",
	width: 1920,
	height: 1080,
	duration: 64,
};

const payload = {
	type: "event_callback" as const,
	team_id: "T123",
	event_id: "E123",
	event: {
		type: "link_shared" as const,
		channel: "C123",
		message_ts: "123.456",
		unfurl_id: "U123",
		source: "conversations_history",
		links: [
			{
				domain: "cap.so",
				url: "https://cap.so/s/abc123",
			},
		],
	},
};

describe("Slack video unfurls", () => {
	it("parses link and uninstall events without accepting malformed payloads", () => {
		expect(parseSlackEventPayload(payload)).toEqual(payload);
		expect(
			parseSlackEventPayload({
				type: "event_callback",
				team_id: "T123",
				event: { type: "app_uninstalled" },
			}),
		).toMatchObject({
			type: "event_callback",
			team_id: "T123",
			event: { type: "app_uninstalled" },
		});
		expect(parseSlackEventPayload({ type: "event_callback" })).toBeNull();
	});

	it("builds a Slack-compliant navigation-free video block URL", () => {
		expect(
			buildSlackVideoBlock({
				video,
				shareUrl: "https://cap.so/s/abc123",
				webUrl: "https://cap.so",
			}),
		).toMatchObject({
			type: "video",
			title_url: "https://cap.so/s/abc123",
			video_url: "https://cap.so/embed/abc123?autoplay=true&slack=true",
			thumbnail_url: "https://cap.so/api/video/og?videoId=abc123",
			provider_name: "Cap",
			author_name: "Richie",
		});
	});

	it("keeps video block text within Slack's strict limits", () => {
		const block = buildSlackVideoBlock({
			video: {
				...video,
				name: "V".repeat(250),
				ownerName: "A".repeat(80),
			},
			shareUrl: "https://cap.so/s/abc123",
			webUrl: "https://cap.so",
		});

		expect(block.title.text).toHaveLength(199);
		expect(block.author_name).toHaveLength(49);
	});

	it("publishes only eligible links using the event unfurl locator", async () => {
		const sendUnfurl = vi.fn(async () => undefined);
		await processSlackEvent({
			payload,
			webUrl: "https://cap.so",
			dependencies: {
				deleteInstallation: vi.fn(async () => undefined),
				getInstallationToken: vi.fn(async () => "xoxb-token"),
				getVideo: vi.fn(async () => video),
				sendUnfurl,
			},
		});

		expect(sendUnfurl).toHaveBeenCalledWith({
			token: "xoxb-token",
			event: {
				channel: "C123",
				messageTs: "123.456",
				unfurlId: "U123",
				source: "conversations_history",
			},
			unfurls: {
				"https://cap.so/s/abc123": {
					blocks: [expect.objectContaining({ type: "video" })],
				},
			},
		});
	});

	it("uses the canonical Cap recording URL for legacy cap.link unfurls", async () => {
		const sendUnfurl = vi.fn(async () => undefined);
		await processSlackEvent({
			payload: {
				...payload,
				event: {
					...payload.event,
					links: [
						{
							domain: "cap.link",
							url: "https://cap.link/abc123",
						},
					],
				},
			},
			webUrl: "https://cap.so",
			dependencies: {
				deleteInstallation: vi.fn(async () => undefined),
				getInstallationToken: vi.fn(async () => "xoxb-token"),
				getVideo: vi.fn(async () => video),
				sendUnfurl,
			},
		});

		expect(sendUnfurl).toHaveBeenCalledWith(
			expect.objectContaining({
				unfurls: {
					"https://cap.link/abc123": {
						blocks: [
							expect.objectContaining({
								title_url: "https://cap.so/s/abc123",
							}),
						],
					},
				},
			}),
		);
	});

	it("degrades silently when a link is restricted or the app is not installed", async () => {
		const sendUnfurl = vi.fn(async () => undefined);
		await processSlackEvent({
			payload,
			webUrl: "https://cap.so",
			dependencies: {
				deleteInstallation: vi.fn(async () => undefined),
				getInstallationToken: vi.fn(async () => "xoxb-token"),
				getVideo: vi.fn(async () => null),
				sendUnfurl,
			},
		});
		await processSlackEvent({
			payload,
			webUrl: "https://cap.so",
			dependencies: {
				deleteInstallation: vi.fn(async () => undefined),
				getInstallationToken: vi.fn(async () => null),
				getVideo: vi.fn(async () => video),
				sendUnfurl,
			},
		});
		expect(sendUnfurl).not.toHaveBeenCalled();
	});

	it("removes credentials when Slack reports an uninstall", async () => {
		const deleteInstallation = vi.fn(async () => undefined);
		await processSlackEvent({
			payload: {
				type: "event_callback",
				team_id: "T123",
				event: { type: "app_uninstalled" },
			},
			webUrl: "https://cap.so",
			dependencies: {
				deleteInstallation,
				getInstallationToken: vi.fn(async () => null),
				getVideo: vi.fn(async () => null),
				sendUnfurl: vi.fn(async () => undefined),
			},
		});
		expect(deleteInstallation).toHaveBeenCalledWith("T123");
	});
});
