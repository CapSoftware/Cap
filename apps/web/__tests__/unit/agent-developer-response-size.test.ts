import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
	serverEnv: () => ({ WEB_URL: "https://cap.so", INFRA_PLAYBACK_URL: "" }),
}));

import { agentScopeProfiles } from "@/lib/agent-auth";
import { developerCapabilities } from "@/lib/agent-management";
import {
	type AgentDeveloperVideoRow,
	toAgentDeveloperVideo,
} from "@/lib/developer-video-api";

const capabilities = developerCapabilities(new Set(agentScopeProfiles.full));

const row = (index: number): AgentDeveloperVideoRow => ({
	id: `video0000000_${String(index).padStart(2, "0")}`,
	appId: "app000000000001",
	externalUserId: null,
	name: "talk-720p",
	status: "ready",
	errorReason: null,
	playbackId: `playback0000000000000_${String(index).padStart(2, "0")}`,
	duration: 11.7551,
	width: 1280,
	height: 720,
	fps: 30,
	maxResolutionTier: "1080p",
	renditions: [
		{
			name: "720p",
			width: 1280,
			height: 720,
			bitrate: 2_800_000,
			bytes: 4_114_285,
			codecs: "avc1.64001f,mp4a.40.2",
		},
		{
			name: "360p",
			width: 640,
			height: 360,
			bitrate: 800_000,
			bytes: 1_175_510,
			codecs: "avc1.64001e,mp4a.40.2",
		},
	],
	transcriptionStatus: null,
	processing: {
		encodeId: "encode",
		startedAt: 0,
		probe: null,
		hls: { state: "complete", output: "hls" },
		mp4: { state: "complete", output: "mp4" },
		attempts: { hls: 1, mp4: 1 },
		unavailableChecks: 0,
		poster: { output: "poster" },
		bytes: { source: 0, hls: 0, mp4: 0, poster: 0 },
	},
	createdAt: new Date("2026-11-12T14:01:12.000Z"),
	updatedAt: new Date("2026-11-12T14:01:21.000Z"),
});

const previousShape = (rows: AgentDeveloperVideoRow[]) => ({
	videos: rows.map((video) => ({
		id: video.id,
		appId: video.appId,
		externalUserId: video.externalUserId,
		name: video.name,
		durationSeconds: video.duration,
		width: video.width,
		height: video.height,
		fps: video.fps,
		transcriptionStatus: video.transcriptionStatus,
		createdAt: video.createdAt.toISOString(),
		updatedAt: video.updatedAt.toISOString(),
		capabilities,
	})),
	nextCursor: null,
	requestId: "req_0123456789abcdef",
});

const currentShape = (rows: AgentDeveloperVideoRow[]) => ({
	videos: rows.map(toAgentDeveloperVideo),
	capabilities,
	nextCursor: null,
	requestId: "req_0123456789abcdef",
});

const toolResult = (payload: unknown, repeated: boolean) =>
	JSON.stringify({
		jsonrpc: "2.0",
		id: 3,
		result: {
			content: [{ type: "text", text: JSON.stringify(payload) }],
			...(repeated ? { structuredContent: payload } : {}),
			isError: false,
		},
	}).length;

describe("size of a developer video list for an agent", () => {
	const measure = (count: number) => {
		const rows = Array.from({ length: count }, (_, index) => row(index));
		return {
			previous: toolResult(previousShape(rows), true),
			current: toolResult(currentShape(rows), false),
		};
	};

	it("is smaller than the repeated response it replaces", () => {
		const two = measure(2);
		const fifty = measure(50);
		console.info(
			`MCP developer_videos_list: 2 videos ${two.previous} -> ${two.current} bytes, 50 videos ${fifty.previous} -> ${fifty.current} bytes`,
		);
		expect(two.current).toBeLessThan(two.previous * 0.6);
		expect(fifty.current).toBeLessThan(fifty.previous * 0.35);
		expect((fifty.current - two.current) / 48).toBeLessThan(1_200);
	});

	it("still carries status and links on every video", () => {
		const [video] = currentShape([row(0)]).videos;
		expect(video).toMatchObject({
			status: "ready",
			playbackId: expect.any(String),
			shareUrl: expect.any(String),
			embedUrl: expect.any(String),
			hlsUrl: expect.any(String),
			mp4Url: expect.any(String),
		});
		expect(video).not.toHaveProperty("capabilities");
	});
});
