import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/database", () => {
	const mockDb = {
		select: vi.fn(() => mockDb),
		insert: vi.fn(() => mockDb),
		update: vi.fn(() => mockDb),
		delete: vi.fn(() => mockDb),
		from: vi.fn(() => mockDb),
		set: vi.fn(() => mockDb),
		where: vi.fn(() => mockDb),
		limit: vi.fn(() => Promise.resolve([])),
		values: vi.fn(() => Promise.resolve()),
		transaction: vi.fn((fn) => fn(mockDb)),
		leftJoin: vi.fn(() => mockDb),
		orderBy: vi.fn(() => mockDb),
		offset: vi.fn(() => mockDb),
	};
	return {
		db: () => mockDb,
		__mockDb: mockDb,
	};
});

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(),
}));

vi.mock("@cap/database/helpers", () => ({
	nanoId: vi.fn(() => "test-nano-id"),
	nanoIdLong: vi.fn(() => "test-nano-id-long-value"),
}));

vi.mock("@cap/database/crypto", () => ({
	encrypt: vi.fn(async (value: string) => `encrypted:${value}`),
}));

vi.mock("@cap/database/schema", () => ({
	developerApps: {
		id: "id",
		ownerId: "ownerId",
		deletedAt: "deletedAt",
	},
	developerApiKeys: {
		id: "id",
		appId: "appId",
		keyType: "keyType",
		keyPrefix: "keyPrefix",
		keyHash: "keyHash",
		encryptedKey: "encryptedKey",
		revokedAt: "revokedAt",
	},
	developerAppDomains: {
		id: "id",
		appId: "appId",
		domain: "domain",
	},
	developerVideos: {
		id: "id",
		appId: "appId",
		deletedAt: "deletedAt",
	},
	developerCreditAccounts: {
		id: "id",
		appId: "appId",
		balanceMicroCredits: "balanceMicroCredits",
		autoTopUpEnabled: "autoTopUpEnabled",
		autoTopUpThresholdMicroCredits: "autoTopUpThresholdMicroCredits",
		autoTopUpAmountCents: "autoTopUpAmountCents",
	},
	developerCreditTransactions: {},
}));

vi.mock("@/lib/developer-key-hash", () => ({
	hashKey: vi.fn(() => Promise.resolve("mocked-hash-value")),
}));

vi.mock("next/cache", () => ({
	revalidatePath: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	isNull: vi.fn((field: unknown) => ({ isNull: field })),
	sql: vi.fn(),
}));

import { __mockDb } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";

const mockGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>;
const mockDb = __mockDb as Record<string, ReturnType<typeof vi.fn>>;

const mockUser = { id: "user-123", email: "test@example.com" };
const mockApp = {
	id: "app-456",
	ownerId: "user-123",
	name: "Test App",
	environment: "development",
	deletedAt: null,
};

function resetMockDb() {
	for (const key of Object.keys(mockDb)) {
		if (typeof mockDb[key]?.mockClear === "function") {
			mockDb[key].mockClear();
		}
	}
	mockDb.select.mockReturnValue(mockDb);
	mockDb.insert.mockReturnValue(mockDb);
	mockDb.update.mockReturnValue(mockDb);
	mockDb.delete.mockReturnValue(mockDb);
	mockDb.from.mockReturnValue(mockDb);
	mockDb.set.mockReturnValue(mockDb);
	mockDb.where.mockReturnValue(mockDb);
	mockDb.limit.mockReturnValue(Promise.resolve([]));
	mockDb.values.mockReturnValue(Promise.resolve());
	mockDb.leftJoin.mockReturnValue(mockDb);
	mockDb.orderBy.mockReturnValue(mockDb);
	mockDb.offset.mockReturnValue(mockDb);
	mockDb.transaction.mockImplementation((fn) => fn(mockDb));
}

describe("createDeveloperApp", () => {
	let createDeveloperApp: typeof import("@/actions/developers/create-app").createDeveloperApp;

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		const mod = await import("@/actions/developers/create-app");
		createDeveloperApp = mod.createDeveloperApp;
	});

	it("throws Unauthorized when no user", async () => {
		mockGetCurrentUser.mockResolvedValue(null);
		await expect(
			createDeveloperApp({ name: "Test", environment: "development" }),
		).rejects.toThrow("Unauthorized");
	});

	it("throws App name is required when empty name", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		await expect(
			createDeveloperApp({ name: "", environment: "development" }),
		).rejects.toThrow("App name is required");
	});

	it("throws App name is required when whitespace-only name", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		await expect(
			createDeveloperApp({ name: "   ", environment: "development" }),
		).rejects.toThrow("App name is required");
	});

	it("creates app with trimmed name", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		await createDeveloperApp({
			name: "  My App  ",
			environment: "production",
		});

		expect(mockDb.insert).toHaveBeenCalled();
		const firstValuesCall = mockDb.values.mock.calls[0][0];
		expect(firstValuesCall).toMatchObject({
			name: "My App",
			environment: "production",
			ownerId: "user-123",
		});
	});

	it("creates public key with cpk_ prefix", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		const result = await createDeveloperApp({
			name: "Test",
			environment: "development",
		});
		expect(result.publicKey).toMatch(/^cpk_/);
	});

	it("creates secret key with csk_ prefix", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		const result = await createDeveloperApp({
			name: "Test",
			environment: "development",
		});
		expect(result.secretKey).toMatch(/^csk_/);
	});

	it("creates credit account alongside app", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		await createDeveloperApp({
			name: "Test",
			environment: "development",
		});

		expect(mockDb.insert).toHaveBeenCalledTimes(3);
	});

	it("returns appId, publicKey, secretKey", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		const result = await createDeveloperApp({
			name: "Test",
			environment: "development",
		});

		expect(result).toHaveProperty("appId");
		expect(result).toHaveProperty("publicKey");
		expect(result).toHaveProperty("secretKey");
		expect(result.appId).toBe("test-nano-id");
	});

	it("public key prefix is first 12 chars", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		const result = await createDeveloperApp({
			name: "Test",
			environment: "development",
		});

		const expectedPrefix = result.publicKey.slice(0, 12);
		const keysValuesCall = mockDb.values.mock.calls[1][0];
		const publicKeyEntry = keysValuesCall.find(
			(entry: Record<string, unknown>) => entry.keyType === "public",
		);
		expect(publicKeyEntry.keyPrefix).toBe(expectedPrefix);
	});
});

describe("deleteDeveloperApp", () => {
	let deleteDeveloperApp: typeof import("@/actions/developers/delete-app").deleteDeveloperApp;

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		const mod = await import("@/actions/developers/delete-app");
		deleteDeveloperApp = mod.deleteDeveloperApp;
	});

	it("throws Unauthorized when no user", async () => {
		mockGetCurrentUser.mockResolvedValue(null);
		await expect(deleteDeveloperApp("app-456")).rejects.toThrow("Unauthorized");
	});

	it("throws App not found when app does not exist", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValue([]);
		await expect(deleteDeveloperApp("app-456")).rejects.toThrow(
			"App not found",
		);
	});

	it("soft deletes by setting deletedAt", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		await deleteDeveloperApp("app-456");

		expect(mockDb.update).toHaveBeenCalled();
		expect(mockDb.set).toHaveBeenCalledWith(
			expect.objectContaining({ deletedAt: expect.any(Date) }),
		);
	});

	it("returns success true", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		const result = await deleteDeveloperApp("app-456");
		expect(result).toEqual({ success: true });
	});
});

describe("updateDeveloperApp", () => {
	let updateDeveloperApp: typeof import("@/actions/developers/update-app").updateDeveloperApp;

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		const mod = await import("@/actions/developers/update-app");
		updateDeveloperApp = mod.updateDeveloperApp;
	});

	it("throws Unauthorized when no user", async () => {
		mockGetCurrentUser.mockResolvedValue(null);
		await expect(
			updateDeveloperApp({ appId: "app-456", name: "New" }),
		).rejects.toThrow("Unauthorized");
	});

	it("throws App not found when app does not exist", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValue([]);
		await expect(
			updateDeveloperApp({ appId: "app-456", name: "New" }),
		).rejects.toThrow("App not found");
	});

	it("updates name when provided", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		await updateDeveloperApp({ appId: "app-456", name: "Updated Name" });

		expect(mockDb.set).toHaveBeenCalledWith(
			expect.objectContaining({ name: "Updated Name" }),
		);
	});

	it("updates environment when provided", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		await updateDeveloperApp({
			appId: "app-456",
			environment: "production",
		});

		expect(mockDb.set).toHaveBeenCalledWith(
			expect.objectContaining({ environment: "production" }),
		);
	});

	it("trims name before saving", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		await updateDeveloperApp({ appId: "app-456", name: "  Trimmed  " });

		expect(mockDb.set).toHaveBeenCalledWith(
			expect.objectContaining({ name: "Trimmed" }),
		);
	});

	it("skips update when no fields provided", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		await updateDeveloperApp({ appId: "app-456" });

		expect(mockDb.update).not.toHaveBeenCalled();
	});

	it("returns success true", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		const result = await updateDeveloperApp({
			appId: "app-456",
			name: "New",
		});
		expect(result).toEqual({ success: true });
	});
});

describe("addDeveloperDomain", () => {
	let addDeveloperDomain: typeof import("@/actions/developers/add-domain").addDeveloperDomain;

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		const mod = await import("@/actions/developers/add-domain");
		addDeveloperDomain = mod.addDeveloperDomain;
	});

	it("throws Unauthorized when no user", async () => {
		mockGetCurrentUser.mockResolvedValue(null);
		await expect(
			addDeveloperDomain("app-456", "https://example.com"),
		).rejects.toThrow("Unauthorized");
	});

	it("throws Domain is required when empty", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		await expect(addDeveloperDomain("app-456", "")).rejects.toThrow(
			"Domain is required",
		);
	});

	it("throws Domain is required when whitespace only", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		await expect(addDeveloperDomain("app-456", "   ")).rejects.toThrow(
			"Domain is required",
		);
	});

	it("validates domain format with regex", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		await expect(addDeveloperDomain("app-456", "not-a-url")).rejects.toThrow(
			"Domain must be a valid origin (e.g. https://myapp.com)",
		);
	});

	it("accepts https://example.com", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		const result = await addDeveloperDomain("app-456", "https://example.com");
		expect(result).toEqual({ success: true });
	});

	it("accepts http://localhost:3000", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		const result = await addDeveloperDomain("app-456", "http://localhost:3000");
		expect(result).toEqual({ success: true });
	});

	it("rejects invalid domains without protocol", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		await expect(addDeveloperDomain("app-456", "example.com")).rejects.toThrow(
			"Domain must be a valid origin (e.g. https://myapp.com)",
		);
	});

	it("rejects bare hostnames", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		await expect(
			addDeveloperDomain("app-456", "just-hostname"),
		).rejects.toThrow("Domain must be a valid origin (e.g. https://myapp.com)");
	});

	it("normalizes to lowercase", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		await addDeveloperDomain("app-456", "HTTPS://EXAMPLE.COM");

		expect(mockDb.values).toHaveBeenCalledWith(
			expect.objectContaining({ domain: "https://example.com" }),
		);
	});

	it("returns success true", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		const result = await addDeveloperDomain("app-456", "https://example.com");
		expect(result).toEqual({ success: true });
	});
});

describe("removeDeveloperDomain", () => {
	let removeDeveloperDomain: typeof import("@/actions/developers/remove-domain").removeDeveloperDomain;

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		const mod = await import("@/actions/developers/remove-domain");
		removeDeveloperDomain = mod.removeDeveloperDomain;
	});

	it("throws Unauthorized when no user", async () => {
		mockGetCurrentUser.mockResolvedValue(null);
		await expect(
			removeDeveloperDomain("app-456", "domain-789"),
		).rejects.toThrow("Unauthorized");
	});

	it("throws App not found when app does not exist", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValue([]);
		await expect(
			removeDeveloperDomain("app-456", "domain-789"),
		).rejects.toThrow("App not found");
	});

	it("deletes domain record", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		await removeDeveloperDomain("app-456", "domain-789");

		expect(mockDb.delete).toHaveBeenCalled();
	});

	it("returns success true", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		const result = await removeDeveloperDomain("app-456", "domain-789");
		expect(result).toEqual({ success: true });
	});
});

describe("regenerateDeveloperKeys", () => {
	let regenerateDeveloperKeys: typeof import("@/actions/developers/regenerate-keys").regenerateDeveloperKeys;

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		const mod = await import("@/actions/developers/regenerate-keys");
		regenerateDeveloperKeys = mod.regenerateDeveloperKeys;
	});

	it("throws Unauthorized when no user", async () => {
		mockGetCurrentUser.mockResolvedValue(null);
		await expect(regenerateDeveloperKeys("app-456")).rejects.toThrow(
			"Unauthorized",
		);
	});

	it("throws App not found when app does not exist", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValue([]);
		await expect(regenerateDeveloperKeys("app-456")).rejects.toThrow(
			"App not found",
		);
	});

	it("revokes all existing active keys", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		await regenerateDeveloperKeys("app-456");

		expect(mockDb.update).toHaveBeenCalled();
		expect(mockDb.set).toHaveBeenCalledWith(
			expect.objectContaining({ revokedAt: expect.any(Date) }),
		);
	});

	it("creates new public and secret keys", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		const result = await regenerateDeveloperKeys("app-456");

		expect(result.publicKey).toMatch(/^cpk_/);
		expect(result.secretKey).toMatch(/^csk_/);
	});

	it("returns new publicKey and secretKey", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		const result = await regenerateDeveloperKeys("app-456");

		expect(result).toHaveProperty("publicKey");
		expect(result).toHaveProperty("secretKey");
		expect(typeof result.publicKey).toBe("string");
		expect(typeof result.secretKey).toBe("string");
	});
});

describe("addCreditsToAccount", () => {
	let addCreditsToAccount: typeof import("@/lib/developer-credits").addCreditsToAccount;

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		const mod = await import("@/lib/developer-credits");
		addCreditsToAccount = mod.addCreditsToAccount;
	});

	it("correctly calculates micro-credits from cents", async () => {
		mockDb.transaction.mockImplementation(async (fn) => {
			const txDb = { ...mockDb };
			txDb.select = vi.fn(() => txDb) as unknown as ReturnType<typeof vi.fn>;
			txDb.from = vi.fn(() => txDb) as unknown as ReturnType<typeof vi.fn>;
			txDb.where = vi.fn(() => txDb) as unknown as ReturnType<typeof vi.fn>;
			txDb.update = vi.fn(() => txDb) as unknown as ReturnType<typeof vi.fn>;
			txDb.set = vi.fn(() => txDb) as unknown as ReturnType<typeof vi.fn>;
			txDb.insert = vi.fn(() => txDb) as unknown as ReturnType<typeof vi.fn>;
			txDb.values = vi.fn(() => Promise.resolve()) as unknown as ReturnType<
				typeof vi.fn
			>;
			txDb.limit = vi.fn(() =>
				Promise.resolve([{ balanceMicroCredits: 1000000 }]),
			) as unknown as ReturnType<typeof vi.fn>;
			return fn(txDb);
		});

		const result = await addCreditsToAccount({
			accountId: "account-001",
			amountCents: 1000,
		});
		expect(result).toBe(1000000);
	});

	it("creates topup transaction record with referenceType", async () => {
		let capturedValues: Record<string, unknown> | null = null;
		mockDb.transaction.mockImplementation(async (fn) => {
			const txDb = { ...mockDb };
			txDb.select = vi.fn(() => txDb) as unknown as ReturnType<typeof vi.fn>;
			txDb.from = vi.fn(() => txDb) as unknown as ReturnType<typeof vi.fn>;
			txDb.where = vi.fn(() => txDb) as unknown as ReturnType<typeof vi.fn>;
			txDb.update = vi.fn(() => txDb) as unknown as ReturnType<typeof vi.fn>;
			txDb.set = vi.fn(() => txDb) as unknown as ReturnType<typeof vi.fn>;
			txDb.insert = vi.fn(() => txDb) as unknown as ReturnType<typeof vi.fn>;
			txDb.values = vi.fn((vals: Record<string, unknown>) => {
				capturedValues = vals;
				return Promise.resolve();
			}) as unknown as ReturnType<typeof vi.fn>;
			txDb.limit = vi.fn(() =>
				Promise.resolve([{ balanceMicroCredits: 500000 }]),
			) as unknown as ReturnType<typeof vi.fn>;
			return fn(txDb);
		});

		await addCreditsToAccount({
			accountId: "account-001",
			amountCents: 500,
			referenceId: "pi_test123",
			referenceType: "stripe_payment_intent",
		});
		expect(capturedValues).toMatchObject({
			type: "topup",
			referenceId: "pi_test123",
			referenceType: "stripe_payment_intent",
		});
	});

	it("returns the new balance", async () => {
		mockDb.transaction.mockImplementation(async (fn) => {
			const txDb = { ...mockDb };
			txDb.select = vi.fn(() => txDb) as unknown as ReturnType<typeof vi.fn>;
			txDb.from = vi.fn(() => txDb) as unknown as ReturnType<typeof vi.fn>;
			txDb.where = vi.fn(() => txDb) as unknown as ReturnType<typeof vi.fn>;
			txDb.update = vi.fn(() => txDb) as unknown as ReturnType<typeof vi.fn>;
			txDb.set = vi.fn(() => txDb) as unknown as ReturnType<typeof vi.fn>;
			txDb.insert = vi.fn(() => txDb) as unknown as ReturnType<typeof vi.fn>;
			txDb.values = vi.fn(() => Promise.resolve()) as unknown as ReturnType<
				typeof vi.fn
			>;
			txDb.limit = vi.fn(() =>
				Promise.resolve([{ balanceMicroCredits: 750000 }]),
			) as unknown as ReturnType<typeof vi.fn>;
			return fn(txDb);
		});

		const result = await addCreditsToAccount({
			accountId: "account-001",
			amountCents: 750,
		});
		expect(result).toBe(750000);
	});
});

describe("updateDeveloperAutoTopUp", () => {
	let updateDeveloperAutoTopUp: typeof import("@/actions/developers/update-auto-topup").updateDeveloperAutoTopUp;

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		const mod = await import("@/actions/developers/update-auto-topup");
		updateDeveloperAutoTopUp = mod.updateDeveloperAutoTopUp;
	});

	it("throws Unauthorized when no user", async () => {
		mockGetCurrentUser.mockResolvedValue(null);
		await expect(
			updateDeveloperAutoTopUp({ appId: "app-456", enabled: true }),
		).rejects.toThrow("Unauthorized");
	});

	it("throws App not found when app does not exist", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValue([]);
		await expect(
			updateDeveloperAutoTopUp({ appId: "app-456", enabled: true }),
		).rejects.toThrow("App not found");
	});

	it("throws Threshold must be non-negative for negative threshold", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		await expect(
			updateDeveloperAutoTopUp({
				appId: "app-456",
				enabled: true,
				thresholdMicroCredits: -100,
			}),
		).rejects.toThrow("Threshold must be non-negative");
	});

	it("throws Top-up amount must be positive for zero amount", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		await expect(
			updateDeveloperAutoTopUp({
				appId: "app-456",
				enabled: true,
				amountCents: 0,
			}),
		).rejects.toThrow("Top-up amount must be positive");
	});

	it("throws Top-up amount must be positive for negative amount", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		await expect(
			updateDeveloperAutoTopUp({
				appId: "app-456",
				enabled: true,
				amountCents: -50,
			}),
		).rejects.toThrow("Top-up amount must be positive");
	});

	it("updates enabled flag", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		await updateDeveloperAutoTopUp({ appId: "app-456", enabled: false });

		expect(mockDb.set).toHaveBeenCalledWith(
			expect.objectContaining({ autoTopUpEnabled: false }),
		);
	});

	it("conditionally updates threshold and amount", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		await updateDeveloperAutoTopUp({
			appId: "app-456",
			enabled: true,
			thresholdMicroCredits: 50000,
			amountCents: 1000,
		});

		expect(mockDb.set).toHaveBeenCalledWith(
			expect.objectContaining({
				autoTopUpEnabled: true,
				autoTopUpThresholdMicroCredits: 50000,
				autoTopUpAmountCents: 1000,
			}),
		);
	});

	it("returns success true", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		const result = await updateDeveloperAutoTopUp({
			appId: "app-456",
			enabled: true,
		});
		expect(result).toEqual({ success: true });
	});
});

describe("deleteDeveloperVideo", () => {
	let deleteDeveloperVideo: typeof import("@/actions/developers/delete-video").deleteDeveloperVideo;

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		const mod = await import("@/actions/developers/delete-video");
		deleteDeveloperVideo = mod.deleteDeveloperVideo;
	});

	it("throws Unauthorized when no user", async () => {
		mockGetCurrentUser.mockResolvedValue(null);
		await expect(deleteDeveloperVideo("app-456", "video-001")).rejects.toThrow(
			"Unauthorized",
		);
	});

	it("throws App not found when app does not exist", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValue([]);
		await expect(deleteDeveloperVideo("app-456", "video-001")).rejects.toThrow(
			"App not found",
		);
	});

	it("soft deletes video", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		await deleteDeveloperVideo("app-456", "video-001");

		expect(mockDb.update).toHaveBeenCalled();
		expect(mockDb.set).toHaveBeenCalledWith(
			expect.objectContaining({ deletedAt: expect.any(Date) }),
		);
	});

	it("returns success true", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]);
		const result = await deleteDeveloperVideo("app-456", "video-001");
		expect(result).toEqual({ success: true });
	});
});
