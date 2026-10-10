import { getCurrentUser } from "@cap/database/auth/session";
import {
	CurrentUser,
	Policy,
	Storage as StorageDomain,
	Video,
} from "@cap/web-domain";
import { Effect, Option } from "effect";
import { after } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deletion = vi.hoisted(() => ({
	deleteVideo: vi.fn(),
	principal: vi.fn(),
}));
const defaultSharing = vi.hoisted(() => ({
	getNewVideoPublic: vi.fn(),
}));

const schema = {
	organizations: { table: "organizations" },
	organizationMembers: { table: "organizationMembers" },
	users: { table: "users" },
	videos: { table: "videos" },
	videoUploads: { table: "videoUploads" },
	importedVideos: { table: "importedVideos" },
	authApiKeys: { table: "authApiKeys" },
};

const mockDb = {
	select: vi.fn(),
	from: vi.fn(),
	innerJoin: vi.fn(),
	leftJoin: vi.fn(),
	insert: vi.fn(),
	values: vi.fn(),
	update: vi.fn(),
	set: vi.fn(),
	where: vi.fn(),
	delete: vi.fn(),
	for: vi.fn(),
	limit: vi.fn(),
	transaction: vi.fn(),
};

vi.mock("@cap/database", () => ({
	db: () => mockDb,
}));
vi.mock("@cap/database/video-sharing-default", () => defaultSharing);

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(),
}));

vi.mock("@cap/database/auth/auth-options", () => ({
	getServerSession: vi.fn(),
}));

vi.mock("@cap/database/schema", () => schema);

vi.mock("@cap/database/emails/config", () => ({
	sendEmail: vi.fn(),
}));

vi.mock("@cap/database/emails/first-shareable-link", () => ({
	FirstShareableLink: () => null,
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		CAP_VIDEOS_DEFAULT_PUBLIC: true,
		WEB_URL: "https://cap.test",
	}),
	buildEnv: {
		NEXT_PUBLIC_IS_CAP: true,
		NEXT_PUBLIC_WEB_URL: "https://cap.test",
	},
}));

vi.mock("@cap/utils", () => ({
	userIsPro: vi.fn(() => true),
}));

vi.mock("@cap/web-backend", async () => {
	const { Effect } = await import("effect");
	const { makeCurrentUserLayer } = await import("@cap/web-backend/src/Auth");
	class Videos extends Effect.Service<Videos>()("Videos", {
		sync: () => ({ delete: deletion.deleteVideo }),
	}) {}
	return {
		makeCurrentUserLayer,
		Videos,
		Storage: {
			getOrganizationWritableAccess: vi.fn(),
			getS3WritableAccessForUser: vi.fn(),
			getWritableAccessForUser: vi.fn(),
		},
	};
});

vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	const { Videos } = await import("@cap/web-backend");
	return {
		runPromise: vi.fn(async (value: unknown) =>
			Effect.isEffect(value)
				? Effect.runPromise(
						(
							value as Effect.Effect<
								unknown,
								unknown,
								InstanceType<typeof Videos>
							>
						).pipe(Effect.provide(Videos.Default)),
					)
				: value,
		),
	};
});

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: vi.fn(() => null),
}));

vi.mock("@/lib/google-drive-storage-quota", () => ({
	invalidateGoogleDriveStorageQuotaCache: vi.fn(),
}));

// The live-transcription stack drags in the whole workflow graph
// (server-only modules included); these tests only care that create works.
vi.mock("@/lib/live-transcribe", () => ({
	maybeStartLiveTranscription: vi.fn(async () => "skipped"),
}));

vi.mock("next/server", () => ({ after: vi.fn() }));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	count: vi.fn(() => "count()"),
	lte: vi.fn(() => "lte()"),
}));

const mockGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>;
const { Storage } = await import("@cap/web-backend");
const { invalidateGoogleDriveStorageQuotaCache } = await import(
	"@/lib/google-drive-storage-quota"
);

function resetMockDb() {
	for (const key of Object.keys(mockDb)) {
		const fn = mockDb[key as keyof typeof mockDb];
		if (typeof fn?.mockClear === "function") {
			fn.mockClear();
		}
	}
	mockDb.select.mockReturnValue(mockDb);
	mockDb.from.mockReturnValue(mockDb);
	mockDb.innerJoin.mockReturnValue(mockDb);
	mockDb.leftJoin.mockReturnValue(mockDb);
	mockDb.insert.mockReturnValue(mockDb);
	mockDb.values.mockResolvedValue([]);
	mockDb.update.mockReturnValue(mockDb);
	mockDb.set.mockReturnValue(mockDb);
	mockDb.where.mockResolvedValue([]);
	mockDb.for.mockResolvedValue([]);
	mockDb.limit.mockResolvedValue([]);
	mockDb.transaction.mockImplementation(
		async (fn: (tx: typeof mockDb) => unknown) => fn(mockDb),
	);
}

function insertedValues(table: unknown) {
	const index = mockDb.insert.mock.calls.findIndex(([t]) => t === table);
	if (index === -1) return undefined;
	return mockDb.values.mock.calls[index]?.[0] as
		| Record<string, unknown>
		| undefined;
}

function stubStorage() {
	const getOrganizationWritableAccess =
		Storage.getOrganizationWritableAccess as ReturnType<typeof vi.fn>;
	const getS3WritableAccessForUser =
		Storage.getS3WritableAccessForUser as ReturnType<typeof vi.fn>;
	const getWritableAccessForUser =
		Storage.getWritableAccessForUser as ReturnType<typeof vi.fn>;
	getOrganizationWritableAccess.mockReturnValue(Effect.succeed(Option.none()));
	const writable = Effect.succeed({
		access: { provider: "s3" },
		bucketId: Option.some("bucket-1"),
		storageIntegrationId: Option.none(),
	});
	getS3WritableAccessForUser.mockReturnValue(writable);
	getWritableAccessForUser.mockReturnValue(writable);
}

describe("GET /new-id", () => {
	let app: typeof import("@/app/api/desktop/[...route]/video")["app"];

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		stubStorage();
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "someone@cap.test",
			defaultOrgId: "org-1",
			activeOrganizationId: "org-1",
		});
		const mod = await import("@/app/api/desktop/[...route]/video");
		app = mod.app;
	});

	it("allocates an ID without creating a video", async () => {
		const response = await app.request("https://cap.test/new-id");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			id: expect.stringMatching(/^[0-9abcdefghjkmnpqrstvwxyz]{15}$/),
		});
		expect(mockDb.insert).not.toHaveBeenCalled();
	});
});

describe("DELETE /delete", () => {
	let app: typeof import("@/app/api/desktop/[...route]/video")["app"];
	const ownedVideo = {
		id: "video-1",
		ownerId: "user-1",
		storageIntegrationId: "drive-1",
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "owner@cap.test",
			activeOrganizationId: "org-1",
			image: null,
		});
		mockDb.where.mockResolvedValue([{ video: ownedVideo }]);
		deletion.deleteVideo
			.mockReset()
			.mockImplementation(() =>
				Effect.flatMap(CurrentUser, (principal) =>
					Effect.sync(() => deletion.principal(principal)),
				),
			);
		app = (await import("@/app/api/desktop/[...route]/video")).app;
	});

	it("delegates deletion under the authenticated principal and then invalidates quota", async () => {
		const response = await app.request(
			"https://cap.test/delete?videoId=video-1",
			{ method: "DELETE" },
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toBe(true);
		expect(deletion.deleteVideo).toHaveBeenCalledExactlyOnceWith("video-1");
		expect(deletion.principal).toHaveBeenCalledWith({
			id: "user-1",
			email: "owner@cap.test",
			activeOrganizationId: "org-1",
			iconUrlOrKey: Option.none(),
		});
		expect(mockDb.delete).not.toHaveBeenCalled();
		expect(
			invalidateGoogleDriveStorageQuotaCache,
		).toHaveBeenCalledExactlyOnceWith("drive-1");
	});

	it("uses the desktop bearer principal without replacing it with a cookie session", async () => {
		mockGetCurrentUser.mockResolvedValue({ id: "cookie-user" });
		mockDb.where
			.mockResolvedValueOnce([
				{
					users: {
						id: "token-user",
						email: "token-owner@cap.test",
						activeOrganizationId: "token-org",
						image: null,
					},
				},
			])
			.mockResolvedValueOnce([
				{ video: { ...ownedVideo, ownerId: "token-user" } },
			]);
		const response = await app.request(
			"https://cap.test/delete?videoId=video-1",
			{
				method: "DELETE",
				headers: {
					Authorization: "Bearer 00000000-0000-4000-8000-000000000000",
				},
			},
		);
		expect(response.status).toBe(200);
		expect(mockGetCurrentUser).not.toHaveBeenCalled();
		expect(deletion.principal).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "token-user",
				activeOrganizationId: "token-org",
			}),
		);
		expect(mockDb.delete).not.toHaveBeenCalled();
	});

	it("does not invalidate quota or return success before central deletion finishes", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		deletion.deleteVideo.mockReturnValue(Effect.promise(() => gate));
		const pending = app.request("https://cap.test/delete?videoId=video-1", {
			method: "DELETE",
		});
		await vi.waitFor(() =>
			expect(deletion.deleteVideo).toHaveBeenCalledTimes(1),
		);
		expect(invalidateGoogleDriveStorageQuotaCache).not.toHaveBeenCalled();
		if (!release) throw new Error("Missing central deletion resolver");
		release();
		const response = await pending;
		expect(response.status).toBe(200);
		expect(
			invalidateGoogleDriveStorageQuotaCache,
		).toHaveBeenCalledExactlyOnceWith("drive-1");
	});

	it("keeps the not-found response when no owned recording matches", async () => {
		mockDb.where.mockResolvedValue([]);
		const response = await app.request(
			"https://cap.test/delete?videoId=video-1",
			{ method: "DELETE" },
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: true,
			message: "Video not found",
		});
		expect(deletion.deleteVideo).not.toHaveBeenCalled();
		expect(invalidateGoogleDriveStorageQuotaCache).not.toHaveBeenCalled();
	});

	it.each([
		{ reason: "missing", error: new Video.NotFoundError() },
		{ reason: "forbidden", error: new Policy.PolicyDeniedError() },
	])(
		"preserves 404 if the central service reports $reason after the preflight",
		async ({ error }) => {
			deletion.deleteVideo.mockReturnValue(Effect.fail(error));
			const response = await app.request(
				"https://cap.test/delete?videoId=video-1",
				{ method: "DELETE" },
			);
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({
				error: true,
				message: "Video not found",
			});
			expect(mockDb.delete).not.toHaveBeenCalled();
			expect(invalidateGoogleDriveStorageQuotaCache).not.toHaveBeenCalled();
		},
	);

	it("returns 500 without invalidating quota when central storage cleanup fails", async () => {
		deletion.deleteVideo.mockReturnValue(
			Effect.fail(
				new StorageDomain.StorageError({
					cause: new Error("Provider deletion failed"),
				}),
			),
		);
		const response = await app.request(
			"https://cap.test/delete?videoId=video-1",
			{ method: "DELETE" },
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: "Internal server error" });
		expect(mockDb.delete).not.toHaveBeenCalled();
		expect(invalidateGoogleDriveStorageQuotaCache).not.toHaveBeenCalled();
	});

	it("does not delegate an unauthenticated request", async () => {
		mockGetCurrentUser.mockResolvedValue(null);
		const response = await app.request(
			"https://cap.test/delete?videoId=video-1",
			{ method: "DELETE" },
		);
		expect(response.status).toBe(401);
		expect(deletion.deleteVideo).not.toHaveBeenCalled();
		expect(mockDb.select).not.toHaveBeenCalled();
	});

	it("rejects a missing recording id before deletion", async () => {
		const response = await app.request("https://cap.test/delete", {
			method: "DELETE",
		});
		expect(response.status).toBe(400);
		expect(deletion.deleteVideo).not.toHaveBeenCalled();
		expect(mockDb.delete).not.toHaveBeenCalled();
	});
});

describe("GET /create", () => {
	let app: typeof import("@/app/api/desktop/[...route]/video")["app"];

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		stubStorage();
		defaultSharing.getNewVideoPublic.mockResolvedValue(true);
		const mod = await import("@/app/api/desktop/[...route]/video");
		app = mod.app;
	});

	it("provisions a personal org and creates the video there when the user has none", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "grant@cap.test",
			defaultOrgId: null,
			activeOrganizationId: "",
		});
		mockDb.where
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ count: 5 }]);

		const response = await app.request("https://cap.test/create");

		expect(response.status).toBe(200);
		expect(mockDb.transaction).toHaveBeenCalledTimes(1);

		const orgValues = insertedValues(schema.organizations) as
			| { id: string; ownerId: string; name: string }
			| undefined;
		expect(orgValues).toMatchObject({
			ownerId: "user-1",
			name: "My Organization",
		});

		expect(insertedValues(schema.organizationMembers)).toMatchObject({
			userId: "user-1",
			role: "owner",
			organizationId: orgValues?.id,
		});

		expect(mockDb.set).toHaveBeenCalledWith(
			expect.objectContaining({
				activeOrganizationId: orgValues?.id,
				defaultOrgId: orgValues?.id,
			}),
		);

		expect(insertedValues(schema.videos)).toMatchObject({
			orgId: orgValues?.id,
			ownerId: "user-1",
		});

		const body = await response.json();
		expect(body.id).toBeTruthy();
	});

	it("does not provision when the user already belongs to an org", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "someone@cap.test",
			defaultOrgId: "org-1",
			activeOrganizationId: "org-1",
		});
		mockDb.where
			.mockResolvedValueOnce([
				{ id: "org-1", name: "Acme", createdAt: new Date() },
			])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ count: 5 }]);

		const response = await app.request("https://cap.test/create");

		expect(response.status).toBe(200);
		expect(mockDb.transaction).not.toHaveBeenCalled();

		expect(insertedValues(schema.videos)).toMatchObject({
			orgId: "org-1",
			ownerId: "user-1",
		});
	});

	it("creates a private recording when the organization default resolves to private", async () => {
		defaultSharing.getNewVideoPublic.mockResolvedValue(false);
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "someone@cap.test",
			defaultOrgId: "org-1",
			activeOrganizationId: "org-1",
		});
		mockDb.where
			.mockResolvedValueOnce([
				{ id: "org-1", name: "Acme", createdAt: new Date() },
			])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ count: 5 }]);

		const response = await app.request("https://cap.test/create");

		expect(response.status).toBe(200);
		expect(defaultSharing.getNewVideoPublic).toHaveBeenCalledWith("org-1");
		expect(insertedValues(schema.videos)).toMatchObject({
			orgId: "org-1",
			public: false,
		});
	});

	it("heals a dangling defaultOrgId when the user has no remaining orgs", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "grant@cap.test",
			defaultOrgId: "org-stale",
			activeOrganizationId: "",
		});
		mockDb.where
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ count: 5 }]);

		const response = await app.request("https://cap.test/create");

		expect(response.status).toBe(200);
		expect(mockDb.transaction).toHaveBeenCalledTimes(1);

		const orgValues = insertedValues(schema.organizations) as
			| { id: string }
			| undefined;

		expect(insertedValues(schema.videos)).toMatchObject({
			orgId: orgValues?.id,
		});
	});

	it("routes a stale explicit orgId to the provisioned org when the user has none", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "grant@cap.test",
			defaultOrgId: "org-stale",
			activeOrganizationId: "",
		});
		mockDb.where
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ count: 5 }]);

		const response = await app.request(
			"https://cap.test/create?orgId=org-stale",
		);

		expect(response.status).toBe(200);
		expect(mockDb.transaction).toHaveBeenCalledTimes(1);

		const orgValues = insertedValues(schema.organizations) as
			| { id: string }
			| undefined;

		expect(insertedValues(schema.videos)).toMatchObject({
			orgId: orgValues?.id,
		});

		expect(mockDb.set).toHaveBeenCalledWith(
			expect.objectContaining({ defaultOrgId: orgValues?.id }),
		);
	});

	it("falls back to the default org when a stale explicit orgId is sent and the user still has orgs", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "someone@cap.test",
			defaultOrgId: "org-1",
			activeOrganizationId: "org-1",
		});
		mockDb.where
			.mockResolvedValueOnce([
				{ id: "org-1", name: "Acme", createdAt: new Date() },
			])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ count: 5 }]);

		const response = await app.request(
			"https://cap.test/create?orgId=org-stale",
		);

		expect(response.status).toBe(200);
		expect(mockDb.transaction).not.toHaveBeenCalled();

		expect(insertedValues(schema.videos)).toMatchObject({
			orgId: "org-1",
			ownerId: "user-1",
		});
	});

	it("honours an explicit orgId the user belongs to", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "someone@cap.test",
			defaultOrgId: "org-1",
			activeOrganizationId: "org-1",
		});
		mockDb.where
			.mockResolvedValueOnce([
				{ id: "org-1", name: "Acme", createdAt: new Date() },
			])
			.mockResolvedValueOnce([
				{ id: "org-2", name: "Team", createdAt: new Date() },
			])
			.mockResolvedValueOnce([{ count: 5 }]);

		const response = await app.request("https://cap.test/create?orgId=org-2");

		expect(response.status).toBe(200);
		expect(mockDb.transaction).not.toHaveBeenCalled();

		expect(insertedValues(schema.videos)).toMatchObject({
			orgId: "org-2",
			ownerId: "user-1",
		});
	});

	it("creates a missing video with an explicitly reserved ID", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "someone@cap.test",
			defaultOrgId: "org-1",
			activeOrganizationId: "org-1",
		});
		mockDb.where
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{ id: "org-1", name: "Acme", createdAt: new Date() },
			])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ count: 5 }]);

		const response = await app.request(
			"https://cap.test/create?videoId=0123456789abcde&createWithId=true",
		);

		expect(response.status).toBe(200);
		expect(insertedValues(schema.videos)).toMatchObject({
			id: "0123456789abcde",
			ownerId: "user-1",
		});
		expect(await response.json()).toMatchObject({ id: "0123456789abcde" });
	});

	it("rejects an invalid client-selected video ID", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "someone@cap.test",
			defaultOrgId: "org-1",
			activeOrganizationId: "org-1",
		});

		const response = await app.request(
			"https://cap.test/create?videoId=not-valid&createWithId=true",
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_video_id" });
		expect(mockDb.insert).not.toHaveBeenCalled();
	});
});

describe("GET /create storage destination", () => {
	let app: typeof import("@/app/api/desktop/[...route]/video")["app"];
	const getWritableAccessForUser =
		Storage.getWritableAccessForUser as ReturnType<typeof vi.fn>;
	const getS3WritableAccessForUser =
		Storage.getS3WritableAccessForUser as ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		stubStorage();
		defaultSharing.getNewVideoPublic.mockResolvedValue(true);
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "someone@cap.test",
			defaultOrgId: "org-1",
			activeOrganizationId: "org-1",
		});
		app = (await import("@/app/api/desktop/[...route]/video")).app;
	});

	function stubOrganizations() {
		mockDb.where
			.mockResolvedValueOnce([
				{ id: "org-1", name: "Personal", createdAt: new Date(0) },
			])
			.mockResolvedValueOnce([
				{ id: "org-2", name: "Team", createdAt: new Date(1) },
			])
			.mockResolvedValueOnce([{ count: 5 }]);
	}

	it.each([
		{
			name: "managed default S3",
			provider: "s3",
			bucketId: Option.none(),
			storageIntegrationId: Option.none(),
			usesDefaultStorage: true,
		},
		{
			name: "custom S3",
			provider: "s3",
			bucketId: Option.some("custom-bucket"),
			storageIntegrationId: Option.none(),
			usesDefaultStorage: false,
		},
		{
			name: "Google Drive",
			provider: "googleDrive",
			bucketId: Option.none(),
			storageIntegrationId: Option.some("drive-1"),
			usesDefaultStorage: false,
		},
		{
			name: "an unknown provider without custom identifiers",
			provider: "future-storage",
			bucketId: Option.none(),
			storageIntegrationId: Option.none(),
			usesDefaultStorage: false,
		},
		{
			name: "missing provider metadata",
			provider: undefined,
			bucketId: Option.none(),
			storageIntegrationId: Option.none(),
			usesDefaultStorage: false,
		},
		{
			name: "contradictory S3 and Drive identifiers",
			provider: "s3",
			bucketId: Option.none(),
			storageIntegrationId: Option.some("drive-1"),
			usesDefaultStorage: false,
		},
	])(
		"reports the selected $name destination without exposing access details",
		async ({
			provider,
			bucketId,
			storageIntegrationId,
			usesDefaultStorage,
		}) => {
			stubOrganizations();
			getWritableAccessForUser.mockReturnValue(
				Effect.succeed({
					access: { provider, credential: "fixture-only-secret" },
					bucketId,
					storageIntegrationId,
				}),
			);

			const response = await app.request(
				"https://cap.test/create?orgId=org-2&recordingMode=desktopSegments",
				{
					headers: { "X-Cap-Desktop-Features": "googleDriveUpload" },
				},
			);

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				id: expect.any(String),
				usesDefaultStorage,
				user_id: "user-1",
				aws_region: "n/a",
				aws_bucket: "n/a",
			});
			expect(getWritableAccessForUser).toHaveBeenCalledExactlyOnceWith(
				"user-1",
				"org-2",
			);
			expect(getS3WritableAccessForUser).not.toHaveBeenCalled();
			expect(insertedValues(schema.videos)).toMatchObject({
				orgId: "org-2",
				bucket: Option.getOrNull(bucketId),
				storageIntegrationId: Option.getOrNull(storageIntegrationId),
			});
			expect(after).toHaveBeenCalledOnce();
		},
	);

	it("uses the resolved default organization when the requested organization is stale", async () => {
		stubOrganizations();
		getWritableAccessForUser.mockImplementation((_userId, organizationId) =>
			Effect.succeed({
				access: { provider: "s3" },
				bucketId:
					organizationId === "org-1"
						? Option.none()
						: Option.some("other-org-bucket"),
				storageIntegrationId: Option.none(),
			}),
		);

		const response = await app.request(
			"https://cap.test/create?orgId=removed",
			{
				headers: { "X-Cap-Desktop-Features": "googleDriveUpload" },
			},
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ usesDefaultStorage: true });
		expect(getWritableAccessForUser).toHaveBeenCalledExactlyOnceWith(
			"user-1",
			"org-1",
		);
		expect(insertedValues(schema.videos)).toMatchObject({
			orgId: "org-1",
			bucket: null,
			storageIntegrationId: null,
		});
	});

	it("uses the actual S3 fallback selected for a client without Drive support", async () => {
		stubOrganizations();
		getWritableAccessForUser.mockReturnValue(
			Effect.succeed({
				access: { provider: "googleDrive" },
				bucketId: Option.none(),
				storageIntegrationId: Option.some("personal-drive"),
			}),
		);
		getS3WritableAccessForUser.mockReturnValue(
			Effect.succeed({
				access: { provider: "s3" },
				bucketId: Option.none(),
				storageIntegrationId: Option.none(),
			}),
		);

		const response = await app.request("https://cap.test/create");

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ usesDefaultStorage: true });
		expect(getS3WritableAccessForUser).toHaveBeenCalledExactlyOnceWith(
			"user-1",
			"org-1",
		);
		expect(getWritableAccessForUser).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "managed default",
			bucket: null,
			storageIntegrationId: null,
			expected: true,
		},
		{
			name: "custom S3",
			bucket: "bucket-1",
			storageIntegrationId: null,
			expected: false,
		},
		{
			name: "Drive",
			bucket: null,
			storageIntegrationId: "drive-1",
			expected: false,
		},
		{
			name: "missing bucket metadata",
			bucket: undefined,
			storageIntegrationId: null,
			expected: false,
		},
		{
			name: "missing integration metadata",
			bucket: null,
			storageIntegrationId: undefined,
			expected: false,
		},
		{
			name: "empty bucket metadata",
			bucket: "",
			storageIntegrationId: null,
			expected: false,
		},
	])(
		"resumes $name from the persisted video destination",
		async ({ bucket, storageIntegrationId, expected }) => {
			mockDb.where.mockResolvedValueOnce([
				{
					id: "existing-video",
					ownerId: "user-1",
					orgId: "old-org",
					bucket,
					storageIntegrationId,
					isScreenshot: false,
					source: { type: "desktopSegments" },
				},
			]);

			const response = await app.request(
				"https://cap.test/create?videoId=existing-video&orgId=org-2",
			);

			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({
				id: "existing-video",
				usesDefaultStorage: expected,
			});
			expect(getWritableAccessForUser).not.toHaveBeenCalled();
			expect(getS3WritableAccessForUser).not.toHaveBeenCalled();
			expect(mockDb.insert).not.toHaveBeenCalled();
			expect(after).toHaveBeenCalledOnce();
		},
	);

	it("does not reveal another user's existing destination", async () => {
		mockDb.where.mockResolvedValueOnce([
			{
				id: "existing-video",
				ownerId: "someone-else",
				bucket: null,
				storageIntegrationId: null,
			},
		]);

		const response = await app.request(
			"https://cap.test/create?videoId=existing-video",
		);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "forbidden" });
		expect(getWritableAccessForUser).not.toHaveBeenCalled();
	});
});
