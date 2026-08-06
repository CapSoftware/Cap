import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const whereMock = vi.fn();
const valuesMock = vi.fn();
const startMock = vi.fn();
const revalidatePathMock = vi.fn();
const storageGetWritableAccessForUserMock = vi.hoisted(() => vi.fn());
const checkRateLimitMock = vi.hoisted(() => vi.fn());
const headersMock = vi.hoisted(() => vi.fn());
const getOrganizationAccessMock = vi.hoisted(() => vi.fn());

const mockDb = {
	select: vi.fn(() => mockDb),
	insert: vi.fn(() => mockDb),
	update: vi.fn(() => mockDb),
	delete: vi.fn(() => mockDb),
	from: vi.fn(() => mockDb),
	innerJoin: vi.fn(() => mockDb),
	leftJoin: vi.fn(() => mockDb),
	where: whereMock,
	set: vi.fn(() => mockDb),
	values: valuesMock,
	transaction: vi.fn((callback) => callback(mockDb)),
};

vi.mock("@cap/database", () => ({
	db: vi.fn(() => mockDb),
}));

vi.mock("server-only", () => ({}));

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
		id: "memberId",
		userId: "memberUserId",
		organizationId: "memberOrganizationId",
		role: "memberRole",
		hasProSeat: "memberHasProSeat",
	},
	organizationInvites: {
		id: "inviteId",
		organizationId: "inviteOrganizationId",
		invitedEmail: "invitedEmail",
		invitedByUserId: "invitedByUserId",
		role: "inviteRole",
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
		activeOrganizationId: "activeOrganizationId",
		defaultOrgId: "defaultOrgId",
		inviteQuota: "inviteQuota",
		stripeSubscriptionId: "stripeSubscriptionId",
		thirdPartyStripeSubscriptionId: "thirdPartyStripeSubscriptionId",
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
	NODE_ENV: "production",
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
	User: {
		UserId: {
			make: vi.fn((value: string) => value),
		},
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

vi.mock("next/headers", () => ({
	headers: headersMock,
}));

vi.mock("@vercel/firewall", () => ({
	checkRateLimit: checkRateLimitMock,
}));

vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return { runPromise: Effect.runPromise };
});

vi.mock("@/actions/organization/authorization", () => ({
	getOrganizationAccess: getOrganizationAccessMock,
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
		mockDb.update.mockReturnValue(mockDb);
		mockDb.delete.mockReturnValue(mockDb);
		mockDb.from.mockReturnValue(mockDb);
		mockDb.innerJoin.mockReturnValue(mockDb);
		mockDb.leftJoin.mockReturnValue(mockDb);
		mockDb.transaction.mockImplementation((callback) => callback(mockDb));
		mockDb.set.mockReturnValue(mockDb);
		valuesMock.mockResolvedValue(undefined);
		whereMock.mockResolvedValue([]);
		startMock.mockResolvedValue(undefined);
		checkRateLimitMock.mockResolvedValue({ rateLimited: false });
		getOrganizationAccessMock.mockResolvedValue({
			id: "org-1",
			ownerId: "user-123",
			memberId: null,
			role: "owner",
		});
		headersMock.mockResolvedValue(
			new Headers({
				host: "cap.test",
				"x-real-ip": "127.0.0.1",
			}),
		);
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

	it("returns direct MP4 URLs for public Loom downloads", async () => {
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
						data: { getVideo: { name: "Public download" } },
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

		const { downloadLoomVideo } = await import("@/actions/loom");

		const result = await downloadLoomVideo(
			"https://www.loom.com/share/loom-abc1234567",
		);

		expect(result).toEqual({
			success: true,
			videoId: "loom-abc1234567",
			videoName: "Public download",
			downloadUrl: "https://cdn.loom.com/video.mp4",
			downloadMode: "direct-download",
			durationSeconds: 42,
			width: 1920,
			height: 1080,
			requiresProxy: false,
		});
	});

	it("returns streaming Loom URLs for browser conversion instead of proxying", async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockImplementation(async (input) => {
			const url = typeof input === "string" ? input : input.toString();

			if (url.includes("/transcoded-url")) {
				return {
					ok: true,
					status: 200,
					text: async () =>
						JSON.stringify({ url: "https://cdn.loom.com/video.m3u8" }),
				} as Response;
			}

			if (url.includes("/raw-url")) {
				return {
					ok: false,
					status: 404,
					text: async () => "",
				} as Response;
			}

			if (url === "https://www.loom.com/graphql") {
				return {
					ok: true,
					json: async () => ({
						data: { getVideo: { name: "Streaming download" } },
					}),
				} as Response;
			}

			if (url.includes("/v1/oembed")) {
				return {
					ok: true,
					json: async () => ({ duration: 90, width: 1280, height: 720 }),
				} as Response;
			}

			throw new Error(`Unexpected fetch: ${url}`);
		});

		const { downloadLoomVideo } = await import("@/actions/loom");

		const result = await downloadLoomVideo(
			"https://www.loom.com/share/loom-abc1234567",
		);

		expect(result).toEqual({
			success: true,
			videoId: "loom-abc1234567",
			videoName: "Streaming download",
			downloadUrl: "https://cdn.loom.com/video.m3u8",
			downloadMode: "browser-conversion",
			durationSeconds: 90,
			width: 1280,
			height: 720,
			requiresProxy: false,
		});
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

	it("rate limits single Loom imports per user", async () => {
		checkRateLimitMock.mockResolvedValueOnce({ rateLimited: true });

		const fetchMock = vi.mocked(fetch);
		const { importFromLoom } = await import("@/actions/loom");

		const result = await importFromLoom({
			loomUrl: "https://www.loom.com/share/loom-abc1234567",
			orgId: "org-1" as never,
		});

		expect(result).toEqual({
			success: false,
			error:
				"Too many Loom imports started. Please wait a few minutes, then try again.",
		});
		expect(checkRateLimitMock).toHaveBeenCalledWith(
			"rl_loom_import_per_user",
			expect.objectContaining({
				rateLimitKey: "loom-import:user-123",
			}),
		);
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

	it("rejects a CSV import when the current user is not an organization admin or owner", async () => {
		getOrganizationAccessMock.mockResolvedValueOnce({
			id: "org-1",
			ownerId: "owner-456",
			memberId: "member-row",
			role: "member",
		});

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
				"Only organization admins and owners can import Loom videos from a CSV.",
		});
		expect(getOrganizationAccessMock).toHaveBeenCalledWith("user-123", "org-1");
		expect(fetchMock).not.toHaveBeenCalled();
		expect(valuesMock).not.toHaveBeenCalled();
	});

	it("provisions missing CSV users and starts imports for them", async () => {
		whereMock
			.mockReturnValueOnce(withLimit([]))
			.mockReturnValueOnce(withLimit([]))
			.mockReturnValueOnce(withLimit([]))
			.mockReturnValueOnce(withLimit([]))
			.mockReturnValueOnce(withLimit([{ ownerId: "owner-456" }]))
			.mockReturnValueOnce(
				withLimit([{ inviteQuota: 1, stripeSubscriptionId: null }]),
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
					userEmail: "not-member@example.com",
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
					userEmail: "not-member@example.com",
					spaceName: undefined,
					success: true,
					videoId: "video-123",
					error: undefined,
				},
			],
			error: undefined,
		});
		expect(fetchMock).toHaveBeenCalled();
		expect(valuesMock).toHaveBeenCalledWith(
			expect.objectContaining({
				email: "not-member@example.com",
				activeOrganizationId: "org-1",
				defaultOrgId: "org-1",
			}),
		);
		expect(valuesMock).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				invitedEmail: "not-member@example.com",
				invitedByUserId: "user-123",
				role: "member",
			}),
		);
		expect(valuesMock).toHaveBeenCalledWith(
			expect.objectContaining({
				organizationId: "org-1",
				userId: "video-123",
				role: "member",
			}),
		);
		expect(storageGetWritableAccessForUserMock).toHaveBeenCalledWith(
			"video-123",
			"org-1",
		);
	});

	it("rejects CSV imports when the current user is rate limited", async () => {
		whereMock.mockReturnValueOnce(
			withLimit([{ userId: "member-123", email: "member@example.com" }]),
		);
		checkRateLimitMock.mockResolvedValueOnce({ rateLimited: true });

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
			failedCount: 1,
			results: [
				{
					rowNumber: 2,
					userEmail: "member@example.com",
					spaceName: undefined,
					success: false,
					error:
						"Too many Loom imports started. Please wait a few minutes, then try again.",
				},
			],
			error: "No Loom videos were imported.",
		});
		expect(checkRateLimitMock).toHaveBeenCalledWith(
			"rl_loom_import_per_user",
			expect.objectContaining({
				rateLimitKey: "loom-import:user-123",
			}),
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(valuesMock).not.toHaveBeenCalled();
	});

	it("skips rate limit checks for csv rows that were already imported", async () => {
		whereMock.mockImplementation((conditions: unknown) => {
			const serializedConditions = JSON.stringify(conditions);

			if (serializedConditions.includes("sourceId")) {
				return Promise.resolve(
					serializedConditions.includes("loom-existing123")
						? [{ videoId: "existing-video" }]
						: [],
				);
			}

			return withLimit([{ userId: "member-123", email: "member@example.com" }]);
		});

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
					loomUrl: "https://www.loom.com/share/loom-existing123",
					userEmail: "member@example.com",
				},
				{
					rowNumber: 3,
					loomUrl: "https://www.loom.com/share/loom-newvideo123",
					userEmail: "member@example.com",
				},
			],
		});

		expect(result).toEqual({
			success: true,
			importedCount: 1,
			failedCount: 1,
			results: [
				{
					rowNumber: 2,
					userEmail: "member@example.com",
					spaceName: undefined,
					success: false,
					error: "This Loom video has already been imported.",
				},
				{
					rowNumber: 3,
					userEmail: "member@example.com",
					spaceName: undefined,
					success: true,
					videoId: "video-123",
					error: undefined,
				},
			],
			error: undefined,
		});
		expect(checkRateLimitMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalled();
		expect(startMock).toHaveBeenCalledTimes(1);
	});

	it("limits CSV imports to 500 rows", async () => {
		const fetchMock = vi.mocked(fetch);
		const { importFromLoomCsv } = await import("@/actions/loom");

		const result = await importFromLoomCsv({
			orgId: "org-1" as never,
			rows: Array.from({ length: 501 }, (_, index) => ({
				rowNumber: index + 2,
				loomUrl: `https://www.loom.com/share/loom-${String(index).padStart(10, "0")}`,
				userEmail: "member@example.com",
			})),
		});

		expect(result).toEqual({
			success: false,
			importedCount: 0,
			failedCount: 501,
			results: [],
			error:
				"CSV imports are limited to 500 rows at a time. Contact support to raise this limit.",
		});
		expect(checkRateLimitMock).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(valuesMock).not.toHaveBeenCalled();
	});

	it("starts CSV Loom imports for matched organization members when the current user is an organization admin", async () => {
		getOrganizationAccessMock.mockResolvedValueOnce({
			id: "org-1",
			ownerId: "owner-456",
			memberId: "member-row",
			role: "admin",
		});
		whereMock
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
			.mockReturnValueOnce(
				withLimit([{ userId: "member-123", email: "member@example.com" }]),
			)
			.mockResolvedValueOnce([])
			.mockReturnValueOnce(withLimit([]))
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
				role: "admin",
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
