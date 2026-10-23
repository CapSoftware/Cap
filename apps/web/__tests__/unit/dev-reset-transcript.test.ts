import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	and: vi.fn((...conditions: unknown[]) => ({ conditions })),
	db: vi.fn(),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	getAccessForVideo: vi.fn(),
	getCurrentUser: vi.fn(),
	where: vi.fn(),
}));

const schema = vi.hoisted(() => ({
	videos: {
		id: "videos.id",
		ownerId: "videos.ownerId",
	},
	videoEdits: {
		videoId: "videoEdits.videoId",
	},
	videoUploads: {
		videoId: "videoUploads.videoId",
	},
}));

vi.mock("@cap/database", () => ({
	db: mocks.db,
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));

vi.mock("@cap/database/schema", () => schema);

vi.mock("@cap/web-backend", () => ({
	Storage: {
		getAccessForVideo: mocks.getAccessForVideo,
	},
}));

vi.mock("drizzle-orm", () => ({
	and: mocks.and,
	eq: mocks.eq,
}));

vi.mock("@/lib/server", () => ({
	runPromise: vi.fn(),
}));

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: vi.fn(),
}));

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("NODE_ENV", "development");
	mocks.db.mockReturnValue({
		select: () => ({
			from: () => ({
				where: mocks.where,
			}),
		}),
	});
	mocks.where.mockResolvedValue([]);
});

describe("development transcript reset", () => {
	it("rejects cross-origin requests before authentication", async () => {
		mocks.getCurrentUser.mockResolvedValue({ id: "owner-1" });
		const { POST } = await import("@/app/api/dev-reset-transcript/route");
		const request = new NextRequest(
			"http://localhost:3000/api/dev-reset-transcript?videoId=video-1",
			{
				method: "POST",
				headers: { origin: "https://attacker.example" },
			},
		);

		const response = await POST(request);

		expect(response.status).toBe(403);
		expect(mocks.getCurrentUser).not.toHaveBeenCalled();
		expect(mocks.db).not.toHaveBeenCalled();
	});

	it("requires a signed-in user", async () => {
		mocks.getCurrentUser.mockResolvedValue(null);
		const { POST } = await import("@/app/api/dev-reset-transcript/route");
		const request = new NextRequest(
			"http://localhost:3000/api/dev-reset-transcript?videoId=video-1",
			{
				method: "POST",
				headers: { origin: "http://localhost:3000" },
			},
		);

		const response = await POST(request);

		expect(response.status).toBe(401);
		expect(mocks.db).not.toHaveBeenCalled();
	});

	it("scopes the target video to the signed-in owner", async () => {
		mocks.getCurrentUser.mockResolvedValue({ id: "owner-1" });
		const { POST } = await import("@/app/api/dev-reset-transcript/route");
		const request = new NextRequest(
			"http://localhost:3000/api/dev-reset-transcript?videoId=video-1",
			{
				method: "POST",
				headers: { origin: "http://localhost:3000" },
			},
		);

		const response = await POST(request);

		expect(response.status).toBe(404);
		expect(mocks.and).toHaveBeenCalledWith(
			{ field: schema.videos.id, value: "video-1" },
			{ field: schema.videos.ownerId, value: "owner-1" },
		);
		expect(mocks.getAccessForVideo).not.toHaveBeenCalled();
	});
});
