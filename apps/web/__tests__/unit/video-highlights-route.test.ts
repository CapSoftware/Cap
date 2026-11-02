import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getVideoHighlights: vi.fn(),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.example" }),
}));
vi.mock("@/actions/videos/highlights", () => ({
	getVideoHighlights: mocks.getVideoHighlights,
}));

import { GET } from "@/app/api/video/highlights/route";

const request = (query: string) =>
	new NextRequest(`https://cap.example/api/video/highlights${query}`);

beforeEach(() => {
	mocks.getVideoHighlights.mockReset();
	mocks.getVideoHighlights.mockResolvedValue([
		{
			id: "h1",
			videoId: "video-1",
			authorId: "u1",
			authorName: "Jacob",
			timestamp: 129.4,
			label: "Highlights feature",
			createdAt: new Date("2026-10-29T00:00:00Z"),
			updatedAt: new Date("2026-10-29T00:00:00Z"),
		},
	]);
});

describe("GET /api/video/highlights", () => {
	it("requires a videoId", async () => {
		const response = await GET(request(""));
		expect(response.status).toBe(400);
	});

	it("returns highlights with deep links", async () => {
		const response = await GET(request("?videoId=video-1"));
		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			videoId: "video-1",
			shareUrl: "https://cap.example/s/video-1",
			highlights: [
				{
					id: "h1",
					timestamp: 129.4,
					label: "Highlights feature",
					authorName: "Jacob",
					url: "https://cap.example/s/video-1?t=129",
				},
			],
		});
	});

	it("returns plain text when asked", async () => {
		const response = await GET(request("?videoId=video-1&format=text"));
		await expect(response.text()).resolves.toBe(
			"2:09 Highlights feature https://cap.example/s/video-1?t=129",
		);
	});

	it("hides videos the caller cannot view", async () => {
		mocks.getVideoHighlights.mockRejectedValue(new Error("Video not found"));
		const response = await GET(request("?videoId=private"));
		expect(response.status).toBe(404);
	});
});
