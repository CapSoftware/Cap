import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const whereMock = vi.fn();
const valuesMock = vi.fn();
const startMock = vi.fn();
const revalidatePathMock = vi.fn();
const storageGetWritableAccessForUserMock = vi.hoisted(() => vi.fn());

const mockDb = {
	select: vi.fn(() => mockDb),
	insert: vi.fn(() => mockDb),
	delete: vi.fn(() => mockDb),
	from: vi.fn(() => mockDb),
	innerJoin: vi.fn(() => mockDb),
	leftJoin: vi.fn(() => mockDb),
	where: whereMock,
	values: valuesMock,
	transaction: vi.fn((callback) => callback(mockDb)),
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
	organizationMembers: {
		userId: "memberUserId",
		organizationId: "memberOrganizationId",
	},
	organizations: {
		id: "organizationId",
		ownerId: "organizationOwnerId",
		tombstoneAt: "organizationTombstoneAt",
	},
	s3Buckets: {
		id: "id",
		ownerId: "ownerId",
	},
	spaceMembers: {
		id: "spaceMemberId",
		spaceId: "spaceMemberSpaceId",
		userId: "spaceMemberUserId",
		role: "spaceMemberRole",
	},
	spaces: {
		id: "spaceId",
		name: "spaceName",
		organizationId: "spaceOrganizationId",
		createdById: "spaceCreatedById",
	},
	spaceVideos: {
		id: "spaceVideoId",
		spaceId: "spaceVideoSpaceId",
		videoId: "spaceVideoVideoId",
	},
	users: {
		id: "userId",
		email: "email",
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

vi.mock("@cap/web-backend", () => ({
	Storage: {
		getWritableAccessForUser: storageGetWritableAccessForUserMock,
	},
}));

vi.mock("@cap/web-domain", () => ({
	Space: {
		SpaceId: {
			make: vi.fn((value: string) => value),
		},
	},
	SpaceMemberId: {
		make: vi.fn((value: string) => value),
	},
	Video: {
		VideoId: {
			make: vi.fn((value: string) => value),
		},
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	isNull: vi.fn((field: unknown) => ({ field })),
}));

vi.mock("next/cache", () => ({
	revalidatePath: revalidatePathMock,
}));

vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return { runPromise: Effect.runPromise };
});

vi.mock("@/actions/organization/authorization", () => ({
	requireOrganizationAccess: vi.fn(),
}));

vi.mock("workflow/api", () => ({
	start: startMock,
}));

vi.mock("@/workflows/import-loom-video", () => ({
	importLoomVideoWorkflow: Symbol("importLoomVideoWorkflow"),
}));

import { getCurrentUser } from "@cap/database/auth/session";

const mockGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>;

function withLimit(value: unknown) {
	return {
		limit: vi.fn().mockResolvedValue(value),
	};
}

describe("importFromLoom", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		whereMock.mockReset();
		valuesMock.mockReset();
		mockDb.select.mockReturnValue(mockDb);
		mockDb.insert.mockReturnValue(mockDb);
		mockDb.delete.mockReturnValue(mockDb);
		mockDb.from.mockReturnValue(mockDb);
		mockDb.innerJoin.mockReturnValue(mockDb);
		mockDb.leftJoin.mockReturnValue(mockDb);
		mockDb.transaction.mockImplementation((callback) => callback(mockDb));
		valuesMock.mockResolvedValue(undefined);
		whereMock.mockResolvedValue([]);
		startMock.mockResolvedValue(undefined);
		storageGetWritableAccessForUserMock.mockReturnValue(
			Effect.succeed({
				bucketId: Option.some("bucket-1"),
				storageIntegrationId: Option.none(),
			}),
		);
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

	it("rejects a CSV import when the current user is not the organization owner", async () => {
		whereMock.mockReturnValueOnce(withLimit([{ ownerId: "owner-456" }]));

		const fetchMock = vi.mocked(fetch);
		const { importFromLoomCsv } = await import("@/actions/loom");

		const result = await importFromLoomCsv({
			orgId: "org-1" as never,
			rows: [
				{
					rowNumber: 2,
					loomUrl: "https://www.loom.com/share/loom-abc1234567",
					userEmail: "member@example.com",
				},
			],
		});

		expect(result).toEqual({
			success: false,
			importedCount: 0,
			failedCount: 0,
			results: [],
			error:
				"Only the organization owner can import Loom videos from a CSV. Ask the owner to do it.",
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(valuesMock).not.toHaveBeenCalled();
	});

	it("rejects CSV rows for emails outside the organization", async () => {
		whereMock
			.mockReturnValueOnce(withLimit([{ ownerId: "user-123" }]))
			.mockReturnValueOnce(withLimit([]));

		const fetchMock = vi.mocked(fetch);
		const { importFromLoomCsv } = await import("@/actions/loom");

		const result = await importFromLoomCsv({
			orgId: "org-1" as never,
			rows: [
				{
					rowNumber: 2,
					loomUrl: "https://www.loom.com/share/loom-abc1234567",
					userEmail: "not-member@example.com",
				},
			],
		});

		expect(result).toEqual({
			success: false,
			importedCount: 0,
			failedCount: 1,
			results: [
				{
					rowNumber: 2,
					userEmail: "not-member@example.com",
					spaceName: undefined,
					success: false,
					error: "This email is not a member of the organization.",
				},
			],
			error: "No Loom videos were imported.",
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(valuesMock).not.toHaveBeenCalled();
	});

	it("starts CSV Loom imports for matched organization members", async () => {
		whereMock
			.mockReturnValueOnce(withLimit([{ ownerId: "user-123" }]))
			.mockReturnValueOnce(
				withLimit([{ userId: "member-123", email: "member@example.com" }]),
			)
			.mockResolvedValueOnce([]);

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

		const { importFromLoomCsv } = await import("@/actions/loom");

		const result = await importFromLoomCsv({
			orgId: "org-1" as never,
			rows: [
				{
					rowNumber: 2,
					loomUrl: "https://www.loom.com/share/loom-abc1234567",
					userEmail: "MEMBER@example.com",
				},
			],
		});

		expect(result).toEqual({
			success: true,
			importedCount: 1,
			failedCount: 0,
			results: [
				{
					rowNumber: 2,
					userEmail: "member@example.com",
					spaceName: undefined,
					success: true,
					videoId: "video-123",
					error: undefined,
				},
			],
			error: undefined,
		});
		expect(storageGetWritableAccessForUserMock).toHaveBeenCalledWith(
			"member-123",
			"org-1",
		);
		expect(valuesMock).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				ownerId: "member-123",
			}),
		);
		expect(startMock).toHaveBeenCalledWith(
			expect.anything(),
			expect.arrayContaining([
				expect.objectContaining({
					userId: "member-123",
					rawFileKey: "member-123/video-123/raw-upload.mp4",
				}),
			]),
		);
	});

	it("creates missing spaces and adds CSV Loom imports to them", async () => {
		whereMock
			.mockReturnValueOnce(withLimit([{ ownerId: "user-123" }]))
			.mockReturnValueOnce(
				withLimit([{ userId: "member-123", email: "member@example.com" }]),
			)
			.mockResolvedValueOnce([])
			.mockReturnValueOnce(withLimit([]))
			.mockReturnValueOnce(withLimit([]));

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

		const { importFromLoomCsv } = await import("@/actions/loom");

		const result = await importFromLoomCsv({
			orgId: "org-1" as never,
			rows: [
				{
					rowNumber: 2,
					loomUrl: "https://www.loom.com/share/loom-abc1234567",
					userEmail: "member@example.com",
					spaceName: " Sales Team ",
				},
			],
		});

		expect(result).toEqual({
			success: true,
			importedCount: 1,
			failedCount: 0,
			results: [
				{
					rowNumber: 2,
					userEmail: "member@example.com",
					spaceName: "Sales Team",
					success: true,
					videoId: "video-123",
					error: undefined,
				},
			],
			error: undefined,
		});
		expect(mockDb.transaction).toHaveBeenCalledTimes(1);
		expect(valuesMock).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "Sales Team",
				organizationId: "org-1",
				createdById: "user-123",
			}),
		);
		expect(valuesMock).toHaveBeenCalledWith(
			expect.objectContaining({
				spaceId: "video-123",
				userId: "user-123",
				role: "Admin",
			}),
		);
		expect(valuesMock).toHaveBeenCalledWith(
			expect.objectContaining({
				spaceId: "video-123",
				videoId: "video-123",
				addedById: "user-123",
			}),
		);
		expect(revalidatePathMock).toHaveBeenCalledWith(
			"/dashboard/spaces/video-123",
		);
		expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");
	});
});
