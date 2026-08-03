import { getCurrentUser } from "@cap/database/auth/session";
import { Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const schema = {
	organizations: { table: "organizations" },
	organizationMembers: { table: "organizationMembers" },
	users: { table: "users" },
	videos: { table: "videos" },
	videoUploads: { table: "videoUploads" },
	importedVideos: { table: "importedVideos" },
};

const mockDb = {
	select: vi.fn(),
	from: vi.fn(),
	innerJoin: vi.fn(),
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

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(),
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

vi.mock("@cap/web-backend", () => ({
	Storage: {
		getOrganizationWritableAccess: vi.fn(),
		getS3WritableAccessForUser: vi.fn(),
	},
}));

vi.mock("@/lib/server", () => ({
	runPromise: vi.fn(async (value: unknown) => value),
}));

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

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	count: vi.fn(() => "count()"),
	lte: vi.fn(() => "lte()"),
}));

const mockGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>;
const { Storage } = await import("@cap/web-backend");

const effectLike = <T>(value: T) => ({
	pipe: (fn: (value: T) => unknown) => fn(value),
});

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
	getOrganizationWritableAccess.mockReturnValue(effectLike(Option.none()));
	getS3WritableAccessForUser.mockReturnValue(
		effectLike({
			bucketId: Option.some("bucket-1"),
			storageIntegrationId: Option.none(),
		}),
	);
}

describe("GET /create", () => {
	let app: typeof import("@/app/api/desktop/[...route]/video")["app"];

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		stubStorage();
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
});
