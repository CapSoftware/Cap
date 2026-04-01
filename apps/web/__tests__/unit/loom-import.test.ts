import { beforeEach, describe, expect, it, vi } from "vitest";

const whereMock = vi.fn();
const valuesMock = vi.fn();
const startMock = vi.fn();
const revalidatePathMock = vi.fn();

const mockDb = {
	select: vi.fn(() => mockDb),
	insert: vi.fn(() => mockDb),
	delete: vi.fn(() => mockDb),
	from: vi.fn(() => mockDb),
	leftJoin: vi.fn(() => mockDb),
	where: whereMock,
	values: valuesMock,
};

vi.mock("@cap/database", () => ({
	db: vi.fn(() => mockDb),
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(),
}));

vi.mock("@cap/database/helpers", () => ({
	nanoId: vi.fn(() => "video-123"),
}));

vi.mock("@cap/database/schema", () => ({
	importedVideos: {
		id: "id",
		orgId: "orgId",
		source: "source",
		sourceId: "sourceId",
	},
	s3Buckets: {
		id: "id",
		ownerId: "ownerId",
	},
	videos: {
		id: "id",
		orgId: "orgId",
	},
	videoUploads: {
		videoId: "videoId",
	},
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: false },
	NODE_ENV: "test",
	serverEnv: vi.fn(() => ({
		CAP_VIDEOS_DEFAULT_PUBLIC: true,
		WEB_URL: "https://cap.test",
	})),
}));

vi.mock("@cap/utils", () => ({
	dub: vi.fn(() => ({
		links: {
			create: vi.fn(),
		},
	})),
	userIsPro: vi.fn(() => true),
}));

vi.mock("@cap/web-domain", () => ({
	Video: {
		VideoId: {
			make: vi.fn((value: string) => value),
		},
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
}));

vi.mock("next/cache", () => ({
	revalidatePath: revalidatePathMock,
}));

vi.mock("workflow/api", () => ({
	start: startMock,
}));

vi.mock("@/workflows/import-loom-video", () => ({
	importLoomVideoWorkflow: Symbol("importLoomVideoWorkflow"),
}));

import { getCurrentUser } from "@cap/database/auth/session";

const mockGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>;

describe("importFromLoom", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		whereMock.mockReset();
		valuesMock.mockReset();
		mockDb.select.mockReturnValue(mockDb);
		mockDb.insert.mockReturnValue(mockDb);
		mockDb.delete.mockReturnValue(mockDb);
		mockDb.from.mockReturnValue(mockDb);
		mockDb.leftJoin.mockReturnValue(mockDb);
		valuesMock.mockResolvedValue(undefined);
		whereMock.mockResolvedValue([]);
		startMock.mockResolvedValue(undefined);
		mockGetCurrentUser.mockResolvedValue({
			id: "user-123",
		});
		vi.stubGlobal("fetch", vi.fn());
	});

	it("rejects a Loom import when the linked Cap still exists", async () => {
		whereMock.mockResolvedValueOnce([
			{ importedVideoId: "video-123", videoId: "video-123" },
		]);

		const fetchMock = vi.mocked(fetch);
		const { importFromLoom } = await import("@/actions/loom");

		const result = await importFromLoom({
			loomUrl: "https://www.loom.com/share/loom-abc1234567",
			orgId: "org-1" as never,
		});

		expect(result).toEqual({
			success: false,
			error: "This Loom video has already been imported.",
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(valuesMock).not.toHaveBeenCalled();
	});

	it("removes a stale Loom row and recreates it with the Cap video id", async () => {
		whereMock
			.mockResolvedValueOnce([{ importedVideoId: "stale-row", videoId: null }])
			.mockResolvedValueOnce([{ id: "bucket-1" }])
			.mockResolvedValueOnce(undefined);

		const fetchMock = vi.mocked(fetch);
		fetchMock.mockImplementation(async (input) => {
			const url = typeof input === "string" ? input : input.toString();

			if (url.includes("/transcoded-url")) {
				return {
					ok: true,
					status: 200,
					text: async () =>
						JSON.stringify({ url: "https://cdn.loom.com/video.mp4" }),
				} as Response;
			}

			if (url === "https://www.loom.com/graphql") {
				return {
					ok: true,
					json: async () => ({
						data: { getVideo: { name: "Imported video" } },
					}),
				} as Response;
			}

			if (url.includes("/v1/oembed")) {
				return {
					ok: true,
					json: async () => ({ duration: 42, width: 1920, height: 1080 }),
				} as Response;
			}

			throw new Error(`Unexpected fetch: ${url}`);
		});

		const { importFromLoom } = await import("@/actions/loom");

		const result = await importFromLoom({
			loomUrl: "https://www.loom.com/share/loom-abc1234567",
			orgId: "org-1" as never,
		});

		expect(result).toEqual({
			success: true,
			videoId: "video-123",
		});
		expect(mockDb.delete).toHaveBeenCalledTimes(1);
		expect(valuesMock).toHaveBeenCalledTimes(3);
		expect(valuesMock).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({
				id: "video-123",
				orgId: "org-1",
				source: "loom",
				sourceId: "loom-abc1234567",
			}),
		);
		expect(startMock).toHaveBeenCalledTimes(1);
		expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/caps");
	});
});
