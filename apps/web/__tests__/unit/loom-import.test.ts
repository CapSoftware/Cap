import type { Organisation } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const whereMock = vi.fn();
const valuesMock = vi.fn();
const startMock = vi.fn();
const getRunMock = vi.hoisted(() => vi.fn());
const revalidatePathMock = vi.fn();
const storageGetWritableAccessForUserMock = vi.hoisted(() => vi.fn());
const storageGetAccessForVideoMock = vi.hoisted(() => vi.fn());
const startVideoProcessingWorkflowMock = vi.hoisted(() => vi.fn());
const startLoomFileProcessingWorkflowMock = vi.hoisted(() => vi.fn());
const uploadedFileHeadMock = vi.hoisted(() => vi.fn());
const checkRateLimitMock = vi.hoisted(() => vi.fn());
const headersMock = vi.hoisted(() => vi.fn());
const getOrganizationAccessMock = vi.hoisted(() => vi.fn());
const requireSpaceManagerMock = vi.hoisted(() => vi.fn());
const requireOrganizationSettingsManagerMock = vi.hoisted(() => vi.fn());
const getLoomImportRunStateMock = vi.hoisted(() => vi.fn());
const restoreLoomImportStartErrorMock = vi.hoisted(() => vi.fn());
const defaultSharing = vi.hoisted(() => ({
	getNewVideoPublic: vi.fn(),
}));
const conciergeMocks = vi.hoisted(() => ({
	requireMigrationOperator: vi.fn(),
	reserveConciergeImport: vi.fn(),
	renewConciergeImport: vi.fn(),
	releaseConciergeImport: vi.fn(),
}));

const mockDb = {
	select: vi.fn(() => mockDb),
	insert: vi.fn(() => mockDb),
	update: vi.fn(() => mockDb),
	delete: vi.fn(() => mockDb),
	from: vi.fn(() => mockDb),
	innerJoin: vi.fn(() => mockDb),
	leftJoin: vi.fn(() => mockDb),
	where: whereMock,
	set: vi.fn((_value: { updatedAt?: Date }) => mockDb),
	values: valuesMock,
	transaction: vi.fn((callback) => callback(mockDb)),
};

vi.mock("@cap/database", () => ({
	db: vi.fn(() => mockDb),
}));
vi.mock("@cap/database/video-sharing-default", () => defaultSharing);

vi.mock("server-only", () => ({}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(),
}));

vi.mock("@cap/database/helpers", () => ({
	nanoId: vi.fn(() => "video-123"),
}));

vi.mock("@cap/database/schema", () => ({
	folders: {
		id: "folderId",
		name: "folderName",
		parentId: "folderParentId",
		organizationId: "folderOrganizationId",
		createdById: "folderCreatedById",
		spaceId: "folderSpaceId",
	},
	sharedVideos: { id: "sharedVideoId" },
	importedVideos: {
		id: "id",
		orgId: "orgId",
		source: "source",
		sourceId: "sourceId",
	},
	loomMigrationImports: {
		videoId: "loomMigrationImportVideoId",
		requestId: "loomMigrationImportRequestId",
	},
	loomMigrationRequests: {
		id: "loomMigrationRequestId",
		organizationId: "loomMigrationRequestOrganizationId",
		activeOrganizationId: "loomMigrationRequestActiveOrganizationId",
		status: "loomMigrationRequestStatus",
		activeImportLeaseToken: "loomMigrationRequestLeaseToken",
		activeImportLeaseUntil: "loomMigrationRequestLeaseUntil",
		queuedVideoCount: "loomMigrationRequestQueuedVideoCount",
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
		phase: "phase",
		rawFileKey: "rawFileKey",
		updatedAt: "updatedAt",
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
		getAccessForVideo: storageGetAccessForVideoMock,
	},
}));

vi.mock("@/lib/video-processing", () => ({
	startVideoProcessingWorkflow: startVideoProcessingWorkflowMock,
}));

vi.mock("@/lib/loom-file-processing", () => ({
	LOOM_FILE_SINGLE_UPLOAD_MAX_BYTES: 5 * 1024 ** 3,
	startLoomFileProcessingWorkflow: startLoomFileProcessingWorkflowMock,
}));

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
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
	asc: vi.fn((field: unknown) => ({ field })),
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	isNull: vi.fn((field: unknown) => ({ field })),
	isNotNull: vi.fn((field: unknown) => ({ field })),
	sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
		strings,
		values,
	})),
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
	requireOrganizationSettingsManager: requireOrganizationSettingsManagerMock,
}));

vi.mock("@/actions/organization/space-authorization", () => ({
	requireSpaceManager: requireSpaceManagerMock,
}));

vi.mock("workflow/api", () => ({
	start: startMock,
	getRun: getRunMock,
}));

vi.mock("@/workflows/import-loom-video", () => ({
	importLoomVideoWorkflow: Symbol("importLoomVideoWorkflow"),
}));

vi.mock("@/lib/loom-concierge", () => ({
	...conciergeMocks,
	toLoomMigrationResult: async (run: () => Promise<unknown>) => {
		const { LoomMigrationError } = await import("@/lib/loom-migration-state");
		try {
			return { ok: true, value: await run() };
		} catch (error) {
			if (error instanceof LoomMigrationError) {
				return { ok: false, error: error.message };
			}
			throw error;
		}
	},
}));

vi.mock("@/lib/org-pro", () => ({
	isOrganizationOwnerPro: vi.fn(async () => true),
}));

vi.mock("@/lib/loom-import-start", () => ({
	getLoomImportRunState: getLoomImportRunStateMock,
	LOOM_IMPORT_CONFIRMATION_MESSAGE: "Confirmation required",
	restoreLoomImportStartError: restoreLoomImportStartErrorMock,
	startLoomImportWorkflow: (payload: unknown) =>
		startMock(Symbol("workflow"), [payload]),
	LoomImportStartError: class extends Error {
		constructor(readonly canRetry: boolean) {
			super("Loom import startup failed");
		}
	},
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
		defaultSharing.getNewVideoPublic.mockResolvedValue(true);
		whereMock.mockReset();
		requireSpaceManagerMock.mockReset();
		requireOrganizationSettingsManagerMock.mockReset();
		requireSpaceManagerMock.mockResolvedValue({ organizationId: "org-1" });
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
		getLoomImportRunStateMock.mockResolvedValue("inactive");
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

	it("restarts a failed import without creating another video", async () => {
		whereMock
			.mockResolvedValueOnce([
				{
					videoId: "existing-video",
					ownerId: "user-123",
					bucketId: "bucket-1",
					phase: "error",
					rawFileKey: null,
					uploadUpdatedAt: new Date("2026-09-01T00:00:00Z"),
				},
			])
			.mockResolvedValueOnce([{ affectedRows: 1 }]);
		const { importFromLoom } = await import("@/actions/loom");
		await expect(
			importFromLoom({
				loomUrl: "https://www.loom.com/share/loom-abc1234567",
				orgId: "org-1" as Organisation.OrganisationId,
			}),
		).resolves.toEqual({ success: true, videoId: "existing-video" });
		expect(mockDb.insert).not.toHaveBeenCalled();
		expect(startMock).toHaveBeenCalledWith(expect.anything(), [
			{
				videoId: "existing-video",
				userId: "user-123",
				bucketId: "bucket-1",
				loomVideoId: "loom-abc1234567",
				rawFileKey: "user-123/existing-video/raw-upload.mp4",
				reuseExistingRawUpload: true,
			},
		]);
	});

	it.each([true, false])(
		"restores a rejected startup without reopening an uncertain dispatch: %s",
		async (canRetry) => {
			whereMock
				.mockResolvedValueOnce([
					{
						videoId: "existing-video",
						ownerId: "user-123",
						phase: "error",
						bucketId: null,
						rawFileKey: null,
						uploadUpdatedAt: new Date(),
					},
				])
				.mockResolvedValueOnce([{ affectedRows: 1 }]);
			const { LoomImportStartError } = await import("@/lib/loom-import-start");
			startMock.mockRejectedValueOnce(
				new LoomImportStartError(canRetry, new Error()),
			);
			const { importFromLoom } = await import("@/actions/loom");
			expect(
				await importFromLoom({
					loomUrl: "https://www.loom.com/share/loom-abc1234567",
					orgId: "org-1" as never,
				}),
			).toMatchObject({ success: false, error: "Loom import startup failed" });
			if (canRetry) {
				expect(restoreLoomImportStartErrorMock).toHaveBeenCalledWith(
					"existing-video",
					"processing",
					mockDb.set.mock.calls[0]?.[0].updatedAt,
					"Loom import startup failed",
				);
			} else expect(restoreLoomImportStartErrorMock).not.toHaveBeenCalled();
		},
	);

	it("holds a failed row while its recorded workflow is still active", async () => {
		const receipt = { runId: "run-active", dispatch: "accepted" };
		whereMock.mockResolvedValueOnce([
			{
				videoId: "existing-video",
				ownerId: "user-123",
				phase: "error",
				uploadUpdatedAt: new Date(),
				metadata: { loomImportRun: receipt },
			},
		]);
		getLoomImportRunStateMock.mockResolvedValueOnce("active");
		const { importFromLoom } = await import("@/actions/loom");
		expect(
			await importFromLoom({
				loomUrl: "https://www.loom.com/share/loom-abc1234567",
				orgId: "org-1" as never,
			}),
		).toMatchObject({ success: false });
		expect(getLoomImportRunStateMock).toHaveBeenCalledWith(receipt);
		expect(mockDb.update).not.toHaveBeenCalled();
		expect(startMock).not.toHaveBeenCalled();
	});

	it("reports an unconfirmed dispatch without claiming it again", async () => {
		whereMock.mockResolvedValueOnce([
			{
				videoId: "existing-video",
				ownerId: "user-123",
				phase: "error",
				uploadUpdatedAt: new Date(),
				metadata: {
					loomImportRun: { runId: "missing-run", dispatch: "uncertain" },
				},
			},
		]);
		getLoomImportRunStateMock.mockResolvedValueOnce("unconfirmed");
		const { importFromLoom } = await import("@/actions/loom");
		expect(
			await importFromLoom({
				loomUrl: "https://www.loom.com/share/loom-abc1234567",
				orgId: "org-1" as never,
			}),
		).toMatchObject({ success: false, error: "Confirmation required" });
		expect(mockDb.update).not.toHaveBeenCalled();
		expect(startMock).not.toHaveBeenCalled();
	});

	it.each([
		{ ownerId: "user-123", phase: "processing", affectedRows: 1 },
		{ ownerId: "other-user", phase: "error", affectedRows: 1 },
		{ ownerId: "user-123", phase: "error", affectedRows: 0 },
	])("does not restart an unclaimed or foreign import: %j", async (row) => {
		whereMock
			.mockResolvedValueOnce([
				{
					videoId: "existing-video",
					bucketId: "bucket-1",
					rawFileKey: null,
					uploadUpdatedAt: new Date("2026-09-01T00:00:00Z"),
					...row,
				},
			])
			.mockResolvedValueOnce([{ affectedRows: row.affectedRows }]);
		const { importFromLoom } = await import("@/actions/loom");
		await expect(
			importFromLoom({
				loomUrl: "https://www.loom.com/share/loom-abc1234567",
				orgId: "org-1" as Organisation.OrganisationId,
			}),
		).resolves.toMatchObject({ success: false });
		expect(startMock).not.toHaveBeenCalled();
		expect(mockDb.insert).not.toHaveBeenCalled();
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

	it("marks Loom throttling as a retryable download failure", async () => {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/transcoded-url") || url.includes("/raw-url")) {
				return {
					ok: false,
					status: 429,
					headers: new Headers({ "retry-after": "90" }),
					body: null,
				} as Response;
			}
			throw new Error(`Unexpected fetch: ${url}`);
		});

		const { downloadLoomVideo } = await import("@/actions/loom");

		const result = await downloadLoomVideo(
			"https://www.loom.com/share/loom-abc1234567",
		);

		expect(result).toEqual({
			success: false,
			error: "Loom is temporarily unavailable. Please retry the import later.",
			errorCode: "loom_temporarily_unavailable",
			retryAfterMs: 90_000,
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

	it.each([
		["long titles", "a".repeat(383), "a".repeat(255)],
		["Unicode titles", "🎥".repeat(260), "🎥".repeat(255)],
		["short titles", "Imported 🎥 video", "Imported 🎥 video"],
	])(
		"fits %s into the destination without changing the import",
		async (_, title, expected) => {
			valuesMock.mockImplementation(async (value: { name?: string }) => {
				if (value.name && Array.from(value.name).length > 255) {
					throw new Error("Data too long for column name");
				}
			});
			vi.mocked(fetch).mockImplementation(async (input) => {
				const url = input.toString();
				if (url.includes("/transcoded-url")) {
					return Response.json({ url: "https://cdn.loom.com/video.mp4" });
				}
				if (url === "https://www.loom.com/graphql") {
					return Response.json({ data: { getVideo: { name: title } } });
				}
				if (url.includes("/v1/oembed")) {
					return Response.json({ duration: 42, width: 1920, height: 1080 });
				}
				throw new Error(`Unexpected fetch: ${url}`);
			});
			const { importFromLoom } = await import("@/actions/loom");
			expect(
				await importFromLoom({
					loomUrl: "https://www.loom.com/share/loom-abc1234567",
					orgId: "org-1" as Organisation.OrganisationId,
				}),
			).toEqual({ success: true, videoId: "video-123" });
			expect(valuesMock).toHaveBeenCalledWith(
				expect.objectContaining({
					name: expected,
					ownerId: "user-123",
					orgId: "org-1",
				}),
			);
			expect(startMock).toHaveBeenCalledTimes(1);
		},
	);

	it("does not call the Vercel firewall from the Loom import server action", async () => {
		checkRateLimitMock.mockResolvedValueOnce({ rateLimited: true });

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
		expect(checkRateLimitMock).not.toHaveBeenCalled();
		expect(startMock).toHaveBeenCalledTimes(1);
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
				orgId: "org-1" as Organisation.OrganisationId,
				source: "loom",
				sourceId: "loom-abc1234567",
			}),
		);
		expect(startMock).toHaveBeenCalledTimes(1);
		expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard/caps");
	});

	function mockSuccessfulDownload() {
		vi.mocked(fetch).mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("/transcoded-url"))
				return {
					ok: true,
					status: 200,
					text: async () =>
						JSON.stringify({ url: "https://cdn.loom.com/video.mp4" }),
				} as Response;
			if (url === "https://www.loom.com/graphql")
				return {
					ok: true,
					json: async () => ({
						data: { getVideo: { name: "Imported video" } },
					}),
				} as Response;
			if (url.includes("/v1/oembed"))
				return { ok: true, json: async () => ({ duration: 42 }) } as Response;
			throw new Error(`Unexpected fetch: ${url}`);
		});
	}

	it.each([
		{
			spaceId: undefined,
			expectedPersonalFolder: "nested-folder",
			sharing: null,
		},
		{
			spaceId: "space-1",
			expectedPersonalFolder: undefined,
			sharing: {
				spaceId: "space-1",
				folderId: "nested-folder",
				addedById: "user-123",
			},
		},
		{
			spaceId: "org-1",
			expectedPersonalFolder: undefined,
			sharing: {
				organizationId: "org-1",
				folderId: "nested-folder",
				sharedByUserId: "user-123",
			},
		},
	])(
		"persists a nested folder before processing in $spaceId",
		async ({ spaceId, expectedPersonalFolder, sharing }) => {
			whereMock.mockReturnValueOnce(withLimit([{ id: "nested-folder" }]));
			mockSuccessfulDownload();
			const { importFromLoom } = await import("@/actions/loom");
			const result = await importFromLoom({
				loomUrl: "https://www.loom.com/share/loom-abc1234567",
				orgId: "org-1" as never,
				folderId: "nested-folder" as never,
				spaceId: spaceId as never,
			});
			expect(result.success).toBe(true);
			expect(mockDb.transaction).toHaveBeenCalledTimes(1);
			expect(valuesMock).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({
					id: "video-123",
					ownerId: "user-123",
					folderId: expectedPersonalFolder,
				}),
			);
			if (sharing)
				expect(valuesMock).toHaveBeenLastCalledWith(
					expect.objectContaining({ videoId: "video-123", ...sharing }),
				);
			expect(startMock.mock.invocationCallOrder[0]).toBeGreaterThan(
				valuesMock.mock.invocationCallOrder.at(-1) ?? Infinity,
			);
			if (spaceId === "org-1")
				expect(requireOrganizationSettingsManagerMock).toHaveBeenCalledWith(
					"user-123",
					"org-1",
				);
			else if (spaceId)
				expect(requireSpaceManagerMock).toHaveBeenCalledWith(
					"user-123",
					spaceId,
				);
			else expect(requireSpaceManagerMock).not.toHaveBeenCalled();
			expect(revalidatePathMock).toHaveBeenCalledWith(
				"/dashboard/folder/[id]",
				"page",
			);
			if (spaceId)
				expect(revalidatePathMock).toHaveBeenCalledWith(
					"/dashboard/spaces/[spaceId]/folder/[folderId]",
					"page",
				);
		},
	);

	it("rejects a missing or foreign personal folder before fetching or writing", async () => {
		whereMock.mockReturnValueOnce(withLimit([]));
		const { importFromLoom } = await import("@/actions/loom");
		const result = await importFromLoom({
			loomUrl: "https://www.loom.com/share/loom-abc1234567",
			orgId: "org-1" as never,
			folderId: "foreign-folder" as never,
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain("Destination folder not found");
		const conditions = JSON.stringify(whereMock.mock.calls[0]);
		for (const required of [
			"foreign-folder",
			"folderOrganizationId",
			"org-1",
			"folderCreatedById",
			"user-123",
			"folderSpaceId",
		])
			expect(conditions).toContain(required);
		expect(fetch).not.toHaveBeenCalled();
		expect(valuesMock).not.toHaveBeenCalled();
	});

	it.each(["space-1", "org-1"])(
		"rejects unauthorized shared destination %s",
		async (spaceId) => {
			requireSpaceManagerMock.mockRejectedValue(new Error("Forbidden"));
			requireOrganizationSettingsManagerMock.mockRejectedValue(
				new Error("Forbidden"),
			);
			const { importFromLoom } = await import("@/actions/loom");
			await expect(
				importFromLoom({
					loomUrl: "https://www.loom.com/share/loom-abc1234567",
					orgId: "org-1" as never,
					folderId: "folder-1" as never,
					spaceId: spaceId as never,
				}),
			).rejects.toThrow("Forbidden");
			expect(fetch).not.toHaveBeenCalled();
			expect(valuesMock).not.toHaveBeenCalled();
		},
	);

	it("rejects a space from a different organization even for its manager", async () => {
		requireSpaceManagerMock.mockResolvedValueOnce({
			organizationId: "foreign-org",
		});
		const { importFromLoom } = await import("@/actions/loom");
		await expect(
			importFromLoom({
				loomUrl: "https://www.loom.com/share/loom-abc1234567",
				orgId: "org-1" as never,
				spaceId: "foreign-space" as never,
			}),
		).rejects.toThrow("Space not found");
		expect(fetch).not.toHaveBeenCalled();
		expect(valuesMock).not.toHaveBeenCalled();
	});

	it("does not start processing when persisting a shared destination fails", async () => {
		mockSuccessfulDownload();
		valuesMock
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("Could not save destination"));
		const { importFromLoom } = await import("@/actions/loom");
		await expect(
			importFromLoom({
				loomUrl: "https://www.loom.com/share/loom-abc1234567",
				orgId: "org-1" as never,
				spaceId: "space-1" as never,
			}),
		).rejects.toThrow("Could not save destination");
		expect(mockDb.transaction).toHaveBeenCalledTimes(1);
		expect(startMock).not.toHaveBeenCalled();
	});

	it("lists only the current user's personal folders in the requested organization", async () => {
		const rows = [
			{ id: "parent", name: "Course", parentId: null },
			{ id: "child", name: "Live Calls", parentId: "parent" },
		];
		whereMock.mockReturnValueOnce({ orderBy: vi.fn().mockResolvedValue(rows) });
		const { getLoomImportFolders } = await import("@/actions/loom");
		expect(await getLoomImportFolders({ orgId: "org-1" as never })).toEqual(
			rows,
		);
		const conditions = JSON.stringify(whereMock.mock.calls[0]);
		for (const required of [
			"folderOrganizationId",
			"org-1",
			"folderCreatedById",
			"user-123",
			"folderSpaceId",
		])
			expect(conditions).toContain(required);
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

	it("imports a CSV row without calling the Vercel firewall", async () => {
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
		expect(checkRateLimitMock).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalled();
		expect(startMock).toHaveBeenCalledTimes(1);
	});

	it("marks CSV rows that hit a temporary Loom failure as retryable", async () => {
		whereMock.mockImplementation((conditions: unknown) => {
			if (JSON.stringify(conditions).includes("sourceId")) {
				return Promise.resolve([]);
			}

			return withLimit([{ userId: "member-123", email: "member@example.com" }]);
		});

		const fetchMock = vi.mocked(fetch);
		fetchMock.mockImplementation(async (input) => {
			const url = typeof input === "string" ? input : input.toString();

			if (url.includes("/transcoded-url")) {
				return {
					ok: false,
					status: 429,
					headers: new Headers({ "retry-after": "30" }),
					body: null,
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
					loomUrl: "https://www.loom.com/share/loom-ratelimited1",
					userEmail: "member@example.com",
				},
			],
		});

		expect(result.results).toStrictEqual([
			{
				rowNumber: 2,
				userEmail: "member@example.com",
				spaceName: undefined,
				success: false,
				videoId: undefined,
				error:
					"Loom is temporarily unavailable. Please retry the import later.",
				errorCode: "loom_temporarily_unavailable",
			},
		]);
		expect(startMock).not.toHaveBeenCalled();
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
		expect(mockDb.transaction).toHaveBeenCalledTimes(2);
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

describe("importFromLoomCsvForConcierge", () => {
	const requestId = "request12345678";
	const leaseToken = "lease-1";
	const failedImport = {
		videoId: "existing-video",
		ownerId: "user-123",
		bucketId: "bucket-1",
		phase: "error",
		rawFileKey: null,
		uploadUpdatedAt: new Date("2026-09-01T00:00:00Z"),
	};
	const forUpdateMock = vi.fn();

	function withReservation(reservation: unknown) {
		forUpdateMock.mockResolvedValueOnce([reservation]);
		return { limit: vi.fn(() => ({ for: forUpdateMock })) };
	}

	function queueConciergeRowLookups() {
		whereMock
			.mockReturnValueOnce(
				withLimit([
					{
						organizationId: "org-1",
						status: "in_progress",
						ownerId: "owner-1",
					},
				]),
			)
			.mockReturnValueOnce(
				withLimit([{ userId: "user-123", email: "member@example.com" }]),
			)
			.mockResolvedValueOnce([failedImport]);
	}

	async function importConciergeRow() {
		const { importFromLoomCsvForConcierge } = await import("@/actions/loom");
		return importFromLoomCsvForConcierge({
			requestId,
			rows: [
				{
					rowNumber: 2,
					loomUrl: "https://www.loom.com/share/loom-abc1234567",
					userEmail: "member@example.com",
				},
			],
		});
	}

	beforeEach(() => {
		vi.clearAllMocks();
		whereMock.mockReset();
		valuesMock.mockReset();
		forUpdateMock.mockReset();
		mockDb.select.mockReturnValue(mockDb);
		mockDb.insert.mockReturnValue(mockDb);
		mockDb.update.mockReturnValue(mockDb);
		mockDb.from.mockReturnValue(mockDb);
		mockDb.innerJoin.mockReturnValue(mockDb);
		mockDb.leftJoin.mockReturnValue(mockDb);
		mockDb.set.mockReturnValue(mockDb);
		mockDb.transaction.mockImplementation((callback) => callback(mockDb));
		valuesMock.mockResolvedValue(undefined);
		whereMock.mockResolvedValue([]);
		startMock.mockResolvedValue(undefined);
		getLoomImportRunStateMock.mockResolvedValue("inactive");
		conciergeMocks.requireMigrationOperator.mockResolvedValue({
			id: "operator-1",
		});
		conciergeMocks.reserveConciergeImport.mockResolvedValue(leaseToken);
		conciergeMocks.renewConciergeImport.mockResolvedValue(undefined);
		conciergeMocks.releaseConciergeImport.mockResolvedValue(undefined);
	});

	it("records a restarted failed import against the migration request under the lease", async () => {
		queueConciergeRowLookups();
		whereMock
			.mockReturnValueOnce(
				withReservation({
					activeOrganizationId: "org-1",
					leaseToken,
					leaseUntil: new Date(Date.now() + 60_000),
				}),
			)
			.mockReturnValueOnce(withLimit([]))
			.mockResolvedValueOnce([{ affectedRows: 1 }]);

		const result = await importConciergeRow();

		expect(result).toMatchObject({
			ok: true,
			value: {
				success: true,
				importedCount: 1,
				results: [{ success: true, videoId: "existing-video" }],
			},
		});
		expect(forUpdateMock).toHaveBeenCalledWith("update");
		expect(mockDb.set).toHaveBeenCalledWith(
			expect.objectContaining({ phase: "processing" }),
		);
		expect(valuesMock).toHaveBeenCalledWith({
			videoId: "existing-video",
			requestId,
		});
		expect(mockDb.set).toHaveBeenCalledWith(
			expect.objectContaining({ queuedVideoCount: expect.anything() }),
		);
		expect(startMock).toHaveBeenCalledWith(expect.anything(), [
			expect.objectContaining({
				videoId: "existing-video",
				reuseExistingRawUpload: true,
			}),
		]);
		expect(conciergeMocks.releaseConciergeImport).toHaveBeenCalledWith(
			requestId,
			leaseToken,
		);
	});

	it("does not count a failed import twice when it already belongs to the request", async () => {
		queueConciergeRowLookups();
		whereMock
			.mockReturnValueOnce(
				withReservation({
					activeOrganizationId: "org-1",
					leaseToken,
					leaseUntil: new Date(Date.now() + 60_000),
				}),
			)
			.mockReturnValueOnce(withLimit([{ requestId }]))
			.mockResolvedValueOnce([{ affectedRows: 1 }]);

		const result = await importConciergeRow();

		expect(result).toMatchObject({ ok: true, value: { importedCount: 1 } });
		expect(valuesMock).not.toHaveBeenCalled();
		expect(mockDb.set).not.toHaveBeenCalledWith(
			expect.objectContaining({ queuedVideoCount: expect.anything() }),
		);
		expect(startMock).toHaveBeenCalledTimes(1);
	});

	it("does not restart a failed import once the concierge lease has expired", async () => {
		queueConciergeRowLookups();
		whereMock.mockReturnValueOnce(
			withReservation({
				activeOrganizationId: "org-1",
				leaseToken: "newer-lease",
				leaseUntil: new Date(Date.now() + 60_000),
			}),
		);

		const result = await importConciergeRow();

		expect(result).toMatchObject({
			ok: true,
			value: { success: false, importedCount: 0, failedCount: 1 },
		});
		expect(mockDb.update).not.toHaveBeenCalled();
		expect(valuesMock).not.toHaveBeenCalled();
		expect(startMock).not.toHaveBeenCalled();
	});

	it("refuses to restart a failed import that belongs to another migration request", async () => {
		queueConciergeRowLookups();
		whereMock
			.mockReturnValueOnce(
				withReservation({
					activeOrganizationId: "org-1",
					leaseToken,
					leaseUntil: new Date(Date.now() + 60_000),
				}),
			)
			.mockReturnValueOnce(withLimit([{ requestId: "otherrequest123" }]));

		const result = await importConciergeRow();

		expect(result).toMatchObject({
			ok: true,
			value: {
				success: false,
				results: [
					{
						success: false,
						error: "This Loom import belongs to another migration request.",
					},
				],
			},
		});
		expect(mockDb.update).not.toHaveBeenCalled();
		expect(valuesMock).not.toHaveBeenCalled();
		expect(startMock).not.toHaveBeenCalled();
	});
});

describe("resuming an uploaded concierge Loom file", () => {
	const input = {
		requestId: "req000000000001",
		loomUrl: "https://www.loom.com/share/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		userEmail: "owner@example.com",
		confirmedPreviousProcessingStopped: true,
	};
	const recording = {
		videoId: "existing-video",
		ownerId: "owner-id",
		ownerEmail: "owner@example.com",
		organizationId: "org-1",
		metadata: { loomImportRun: { runId: "old-run", dispatch: "accepted" } },
	};
	const uploaded = {
		loomVideoId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		video: {
			id: "existing-video",
			ownerId: "owner-id",
			orgId: "org-1",
			bucket: null,
		},
		rawFileKey: "owner-id/existing-video/raw-upload.mp4",
		phase: "error",
		processingMessage: null,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		whereMock.mockReset();
		mockDb.select.mockReturnValue(mockDb);
		mockDb.from.mockReturnValue(mockDb);
		mockDb.innerJoin.mockReturnValue(mockDb);
		mockDb.leftJoin.mockReturnValue(mockDb);
		conciergeMocks.requireMigrationOperator.mockResolvedValue({
			id: "operator",
		});
		conciergeMocks.reserveConciergeImport.mockResolvedValue("lease");
		conciergeMocks.releaseConciergeImport.mockResolvedValue(undefined);
		storageGetAccessForVideoMock.mockReturnValue(
			Effect.succeed([{ provider: "s3", headObject: uploadedFileHeadMock }]),
		);
		uploadedFileHeadMock.mockReturnValue(
			Effect.succeed({ ContentLength: 6 * 1024 ** 3 }),
		);
		startVideoProcessingWorkflowMock.mockResolvedValue("started");
		startLoomFileProcessingWorkflowMock.mockResolvedValue("started");
		getRunMock.mockReturnValue({ status: Promise.resolve("failed") });
	});

	it("requires explicit confirmation before inspecting a recording", async () => {
		const { resumeConciergeLoomFileUpload } = await import("@/actions/loom");
		await expect(
			resumeConciergeLoomFileUpload({
				...input,
				confirmedPreviousProcessingStopped: false,
			}),
		).resolves.toMatchObject({ ok: false });
		expect(mockDb.select).not.toHaveBeenCalled();
		expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
	});

	it.each(["running", "pending"])(
		"refuses a previous workflow that is still %s",
		async (status) => {
			whereMock.mockReturnValueOnce(withLimit([recording]));
			getRunMock.mockReturnValueOnce({ status: Promise.resolve(status) });
			const { resumeConciergeLoomFileUpload } = await import("@/actions/loom");
			await expect(resumeConciergeLoomFileUpload(input)).resolves.toMatchObject(
				{
					ok: false,
					error: expect.stringContaining("active or could not be confirmed"),
				},
			);
			expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
		},
	);

	it("refuses an unconfirmed previous workflow", async () => {
		whereMock.mockReturnValueOnce(withLimit([recording]));
		getRunMock.mockImplementationOnce(() => ({
			status: Promise.reject(new Error("Unavailable")),
		}));
		const { resumeConciergeLoomFileUpload } = await import("@/actions/loom");
		await expect(resumeConciergeLoomFileUpload(input)).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining("active or could not be confirmed"),
		});
		expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
	});

	it("can resume after a confirmed queue rejection without querying its unqueued run", async () => {
		whereMock
			.mockReturnValueOnce(
				withLimit([
					{
						...recording,
						metadata: {
							loomImportRun: {
								runId: "rejected-run",
								dispatch: "rejected",
							},
						},
					},
				]),
			)
			.mockReturnValueOnce(withLimit([uploaded]));
		getRunMock.mockImplementation(() => {
			throw new Error("Unqueued run is unavailable");
		});
		const { resumeConciergeLoomFileUpload } = await import("@/actions/loom");
		await expect(resumeConciergeLoomFileUpload(input)).resolves.toEqual({
			ok: true,
			value: { status: "started" },
		});
		expect(getRunMock).not.toHaveBeenCalled();
		expect(startLoomFileProcessingWorkflowMock).toHaveBeenCalledOnce();
	});

	it("processes a large uploaded file in its existing recording", async () => {
		whereMock
			.mockReturnValueOnce(withLimit([recording]))
			.mockReturnValueOnce(withLimit([uploaded]));
		const { resumeConciergeLoomFileUpload } = await import("@/actions/loom");

		await expect(resumeConciergeLoomFileUpload(input)).resolves.toEqual({
			ok: true,
			value: { status: "started" },
		});
		expect(startLoomFileProcessingWorkflowMock).toHaveBeenCalledExactlyOnceWith(
			{
				videoId: "existing-video",
				userId: "owner-id",
				rawFileKey: uploaded.rawFileKey,
				bucketId: null,
				processingMessage: "Processing Loom video...",
				startFailureMessage: "Loom file processing could not start.",
				loomVideoId: uploaded.loomVideoId,
			},
		);
		expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
		expect(mockDb.insert).not.toHaveBeenCalled();
		expect(mockDb.update).not.toHaveBeenCalled();
		expect(storageGetWritableAccessForUserMock).not.toHaveBeenCalled();
	});

	it.each([1024, 5 * 1024 ** 3])(
		"keeps the existing file workflow for a %i-byte upload",
		async (bytes) => {
			whereMock
				.mockReturnValueOnce(withLimit([recording]))
				.mockReturnValueOnce(withLimit([uploaded]));
			uploadedFileHeadMock.mockReturnValue(
				Effect.succeed({ ContentLength: bytes }),
			);
			const { resumeConciergeLoomFileUpload } = await import("@/actions/loom");
			await expect(resumeConciergeLoomFileUpload(input)).resolves.toMatchObject(
				{
					ok: true,
				},
			);
			expect(startVideoProcessingWorkflowMock).toHaveBeenCalledOnce();
			expect(startLoomFileProcessingWorkflowMock).not.toHaveBeenCalled();
		},
	);

	it("keeps non-S3 storage on its existing processing path", async () => {
		whereMock
			.mockReturnValueOnce(withLimit([recording]))
			.mockReturnValueOnce(withLimit([uploaded]));
		storageGetAccessForVideoMock.mockReturnValue(
			Effect.succeed([
				{ provider: "google-drive", headObject: uploadedFileHeadMock },
			]),
		);
		const { resumeConciergeLoomFileUpload } = await import("@/actions/loom");
		await expect(resumeConciergeLoomFileUpload(input)).resolves.toMatchObject({
			ok: true,
		});
		expect(startVideoProcessingWorkflowMock).toHaveBeenCalledOnce();
		expect(startLoomFileProcessingWorkflowMock).not.toHaveBeenCalled();
	});

	it.each([
		{ records: [] },
		{ records: [{ ...recording, ownerEmail: "another@example.com" }] },
	])(
		"refuses missing or differently owned recordings without creating one",
		async ({ records }) => {
			whereMock.mockReturnValueOnce(withLimit(records));
			const { resumeConciergeLoomFileUpload } = await import("@/actions/loom");
			await expect(resumeConciergeLoomFileUpload(input)).resolves.toMatchObject(
				{
					ok: false,
					error: expect.stringContaining("matches this request and owner"),
				},
			);
			expect(mockDb.insert).not.toHaveBeenCalled();
			expect(mockDb.update).not.toHaveBeenCalled();
			expect(storageGetAccessForVideoMock).not.toHaveBeenCalled();
			expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
		},
	);

	it.each(["processing", "complete"])(
		"does not start another job for a recording in phase %s",
		async (phase) => {
			whereMock
				.mockReturnValueOnce(withLimit([recording]))
				.mockReturnValueOnce(withLimit([{ ...uploaded, phase }]));
			const { resumeConciergeLoomFileUpload } = await import("@/actions/loom");
			await expect(resumeConciergeLoomFileUpload(input)).resolves.toMatchObject(
				{
					ok: false,
					error: expect.stringContaining("no longer available"),
				},
			);
			expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
		},
	);

	it("rejects an empty uploaded file", async () => {
		whereMock
			.mockReturnValueOnce(withLimit([recording]))
			.mockReturnValueOnce(withLimit([uploaded]));
		uploadedFileHeadMock.mockReturnValue(Effect.succeed({ ContentLength: 0 }));
		const { resumeConciergeLoomFileUpload } = await import("@/actions/loom");
		await expect(resumeConciergeLoomFileUpload(input)).resolves.toMatchObject({
			ok: false,
			error: "The uploaded file is empty.",
		});
		expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
	});

	it("rejects an oversized upload before starting any processing", async () => {
		whereMock
			.mockReturnValueOnce(withLimit([recording]))
			.mockReturnValueOnce(withLimit([uploaded]));
		uploadedFileHeadMock.mockReturnValue(
			Effect.succeed({ ContentLength: 11 * 1024 ** 3 }),
		);
		const { resumeConciergeLoomFileUpload } = await import("@/actions/loom");
		await expect(resumeConciergeLoomFileUpload(input)).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining("exceeds 10 GB"),
		});
		expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
	});

	it("stops if ownership changes during resume preparation", async () => {
		whereMock
			.mockReturnValueOnce(withLimit([recording]))
			.mockReturnValueOnce(
				withLimit([
					{ ...uploaded, video: { ...uploaded.video, ownerId: "new-owner" } },
				]),
			);
		const { resumeConciergeLoomFileUpload } = await import("@/actions/loom");
		await expect(resumeConciergeLoomFileUpload(input)).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining("no longer available"),
		});
		expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
	});

	it("does not start when the stored upload cannot be found", async () => {
		whereMock
			.mockReturnValueOnce(withLimit([recording]))
			.mockReturnValueOnce(withLimit([uploaded]));
		uploadedFileHeadMock.mockReturnValue(Effect.fail(new Error("Not found")));
		const { resumeConciergeLoomFileUpload } = await import("@/actions/loom");
		await expect(resumeConciergeLoomFileUpload(input)).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining("not found in storage"),
		});
		expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
	});

	it("requires an operator before reading any recording", async () => {
		conciergeMocks.requireMigrationOperator.mockRejectedValueOnce(
			new Error("Unauthorized"),
		);
		const { resumeConciergeLoomFileUpload } = await import("@/actions/loom");
		await expect(resumeConciergeLoomFileUpload(input)).rejects.toThrow(
			"Unauthorized",
		);
		expect(mockDb.select).not.toHaveBeenCalled();
		expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
	});
});
