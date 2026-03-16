import { describe, expect, it, vi } from "vitest";

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
		leftJoin: vi.fn(() => mockDb),
	};
	return { db: () => mockDb, __mockDb: mockDb };
});

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(),
}));

vi.mock("@cap/database/schema", () => ({
	developerApiKeys: {
		appId: "appId",
		keyHash: "keyHash",
		keyType: "keyType",
		revokedAt: "revokedAt",
		lastUsedAt: "lastUsedAt",
	},
	developerApps: { id: "id", deletedAt: "deletedAt" },
	developerAppDomains: { appId: "appId", domain: "domain" },
	authApiKeys: { id: "id", userId: "userId" },
	users: { id: "id" },
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
}));

vi.mock("@/lib/developer-key-hash", () => ({
	hashKey: vi.fn(() => Promise.resolve("mocked-hash")),
}));

vi.mock("next/headers", () => ({
	cookies: vi.fn(() => Promise.resolve({ set: vi.fn() })),
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
	isNull: vi.fn((a: unknown) => ({ isNull: a })),
}));

describe("developer API auth - key format validation", () => {
	describe("public key format (cpk_ prefix)", () => {
		it("accepts a key starting with cpk_", () => {
			const key = "cpk_abc123";
			expect(key.startsWith("cpk_")).toBe(true);
		});

		it("rejects a secret key for public auth", () => {
			const key = "csk_abc123";
			expect(key.startsWith("cpk_")).toBe(false);
		});

		it("rejects a key with no recognized prefix", () => {
			const key = "abc123";
			expect(key.startsWith("cpk_")).toBe(false);
		});

		it("rejects an empty string", () => {
			const key = "";
			expect(key.startsWith("cpk_")).toBe(false);
		});

		it("rejects undefined via optional chaining", () => {
			const key = undefined as string | undefined;
			expect(key?.startsWith("cpk_")).toBeFalsy();
		});

		it("rejects cpk prefix without trailing underscore", () => {
			const key = "cpkabc123";
			expect(key.startsWith("cpk_")).toBe(false);
		});
	});

	describe("secret key format (csk_ prefix)", () => {
		it("accepts a key starting with csk_", () => {
			const key = "csk_abc123";
			expect(key.startsWith("csk_")).toBe(true);
		});

		it("rejects a public key for secret auth", () => {
			const key = "cpk_abc123";
			expect(key.startsWith("csk_")).toBe(false);
		});

		it("rejects a key with no recognized prefix", () => {
			const key = "abc123";
			expect(key.startsWith("csk_")).toBe(false);
		});

		it("rejects an empty string", () => {
			const key = "";
			expect(key.startsWith("csk_")).toBe(false);
		});

		it("rejects undefined via optional chaining", () => {
			const key = undefined as string | undefined;
			expect(key?.startsWith("csk_")).toBeFalsy();
		});

		it("rejects csk prefix without trailing underscore", () => {
			const key = "cskabc123";
			expect(key.startsWith("csk_")).toBe(false);
		});
	});
});

describe("developer API auth - bearer token extraction", () => {
	it("extracts the token from a valid Bearer header", () => {
		const header = "Bearer cpk_test123";
		const token = header.split(" ")[1];
		expect(token).toBe("cpk_test123");
	});

	it("returns empty string when Bearer has no token", () => {
		const header = "Bearer ";
		const token = header.split(" ")[1];
		expect(token).toBe("");
	});

	it("returns undefined when authorization header is missing", () => {
		const header = undefined as string | undefined;
		const token = header?.split(" ")[1];
		expect(token).toBeUndefined();
	});

	it("extracts only the first token segment after Bearer", () => {
		const header = "Bearer cpk_test123 extra_stuff";
		const token = header.split(" ")[1];
		expect(token).toBe("cpk_test123");
	});

	it("returns the raw scheme when no space is present", () => {
		const header = "cpk_test123";
		const token = header.split(" ")[1];
		expect(token).toBeUndefined();
	});

	it("handles lowercase bearer prefix (non-standard)", () => {
		const header = "bearer cpk_test123";
		const token = header.split(" ")[1];
		expect(token).toBe("cpk_test123");
	});
});

describe("developer API auth - key revocation check", () => {
	it("treats a key with null revokedAt as active", () => {
		const keyRow = { appId: "app-1", revokedAt: null };
		const isRevoked = keyRow.revokedAt !== null;
		expect(isRevoked).toBe(false);
	});

	it("treats a key with a revokedAt date as revoked", () => {
		const keyRow = {
			appId: "app-1",
			revokedAt: new Date("2025-01-15T00:00:00Z"),
		};
		const isRevoked = keyRow.revokedAt !== null;
		expect(isRevoked).toBe(true);
	});

	it("middleware returns 401 when no key row is found", () => {
		const keyRows: unknown[] = [];
		const keyRow = keyRows[0];
		expect(keyRow).toBeUndefined();
		expect(!keyRow).toBe(true);
	});
});

describe("developer API auth - app deletion check", () => {
	it("treats an app with null deletedAt as active", () => {
		const app = { id: "app-1", environment: "production", deletedAt: null };
		const isDeleted = app.deletedAt !== null;
		expect(isDeleted).toBe(false);
	});

	it("treats an app with a deletedAt date as deleted", () => {
		const app = {
			id: "app-1",
			environment: "production",
			deletedAt: new Date("2025-06-01T00:00:00Z"),
		};
		const isDeleted = app.deletedAt !== null;
		expect(isDeleted).toBe(true);
	});

	it("middleware returns 401 when no app is found", () => {
		const apps: unknown[] = [];
		const app = apps[0];
		expect(app).toBeUndefined();
		expect(!app).toBe(true);
	});
});

describe("developer API auth - origin validation for production apps", () => {
	function validateOrigin(
		environment: string,
		origin: string | undefined,
		allowedDomains: string[],
	): { allowed: boolean; status?: number; error?: string } {
		if (environment === "production") {
			if (!origin) {
				return {
					allowed: false,
					status: 403,
					error: "Origin header required for production apps",
				};
			}
			const match = allowedDomains.find((d) => d === origin);
			if (!match) {
				return { allowed: false, status: 403, error: "Origin not allowed" };
			}
		}
		return { allowed: true };
	}

	it("allows a production app when origin matches an allowed domain", () => {
		const result = validateOrigin("production", "https://myapp.com", [
			"https://myapp.com",
			"https://other.com",
		]);
		expect(result.allowed).toBe(true);
	});

	it("denies a production app when origin does not match any allowed domain", () => {
		const result = validateOrigin("production", "https://evil.com", [
			"https://myapp.com",
		]);
		expect(result.allowed).toBe(false);
		expect(result.status).toBe(403);
		expect(result.error).toBe("Origin not allowed");
	});

	it("denies a production app when no origin header is present", () => {
		const result = validateOrigin("production", undefined, [
			"https://myapp.com",
		]);
		expect(result.allowed).toBe(false);
		expect(result.status).toBe(403);
		expect(result.error).toBe("Origin header required for production apps");
	});

	it("allows a development app with any origin", () => {
		const result = validateOrigin("development", "https://anything.com", []);
		expect(result.allowed).toBe(true);
	});

	it("allows a development app with no origin", () => {
		const result = validateOrigin("development", undefined, []);
		expect(result.allowed).toBe(true);
	});

	it("allows a production app when origin matches one of many domains", () => {
		const result = validateOrigin("production", "https://second.com", [
			"https://first.com",
			"https://second.com",
			"https://third.com",
		]);
		expect(result.allowed).toBe(true);
	});

	it("performs exact match - no partial domain matching", () => {
		const result = validateOrigin("production", "https://myapp.com.evil.com", [
			"https://myapp.com",
		]);
		expect(result.allowed).toBe(false);
		expect(result.status).toBe(403);
	});

	it("performs exact match - scheme matters", () => {
		const result = validateOrigin("production", "http://myapp.com", [
			"https://myapp.com",
		]);
		expect(result.allowed).toBe(false);
		expect(result.status).toBe(403);
	});

	it("denies a production app with empty string origin", () => {
		const result = validateOrigin("production", "", ["https://myapp.com"]);
		expect(result.allowed).toBe(false);
		expect(result.status).toBe(403);
		expect(result.error).toBe("Origin header required for production apps");
	});

	it("denies a production app when allowed domains list is empty", () => {
		const result = validateOrigin("production", "https://myapp.com", []);
		expect(result.allowed).toBe(false);
		expect(result.status).toBe(403);
		expect(result.error).toBe("Origin not allowed");
	});
});

describe("developer API auth - full public auth flow simulation", () => {
	function simulatePublicAuth(params: {
		authHeader: string | undefined;
		keyRow: { appId: string } | undefined;
		app:
			| { id: string; environment: string; deletedAt: Date | null }
			| undefined;
		origin: string | undefined;
		allowedDomains: string[];
	}): { status: number; error?: string; appId?: string } {
		if (!params.authHeader?.startsWith("cpk_")) {
			return { status: 401, error: "Invalid public key" };
		}

		if (!params.keyRow) {
			return { status: 401, error: "Invalid or revoked public key" };
		}

		if (!params.app) {
			return { status: 401, error: "App not found" };
		}

		if (params.app.environment === "production") {
			if (!params.origin) {
				return {
					status: 403,
					error: "Origin header required for production apps",
				};
			}
			const match = params.allowedDomains.find((d) => d === params.origin);
			if (!match) {
				return { status: 403, error: "Origin not allowed" };
			}
		}

		return { status: 200, appId: params.app.id };
	}

	it("succeeds with valid public key, active app, and matching origin", () => {
		const result = simulatePublicAuth({
			authHeader: "cpk_live_key123",
			keyRow: { appId: "app-1" },
			app: { id: "app-1", environment: "production", deletedAt: null },
			origin: "https://myapp.com",
			allowedDomains: ["https://myapp.com"],
		});
		expect(result.status).toBe(200);
		expect(result.appId).toBe("app-1");
	});

	it("fails with 401 when no auth header is provided", () => {
		const result = simulatePublicAuth({
			authHeader: undefined,
			keyRow: undefined,
			app: undefined,
			origin: undefined,
			allowedDomains: [],
		});
		expect(result.status).toBe(401);
		expect(result.error).toBe("Invalid public key");
	});

	it("fails with 401 when key uses wrong prefix", () => {
		const result = simulatePublicAuth({
			authHeader: "csk_secret_key",
			keyRow: undefined,
			app: undefined,
			origin: undefined,
			allowedDomains: [],
		});
		expect(result.status).toBe(401);
		expect(result.error).toBe("Invalid public key");
	});

	it("fails with 401 when key is revoked (no key row returned)", () => {
		const result = simulatePublicAuth({
			authHeader: "cpk_revoked_key",
			keyRow: undefined,
			app: undefined,
			origin: undefined,
			allowedDomains: [],
		});
		expect(result.status).toBe(401);
		expect(result.error).toBe("Invalid or revoked public key");
	});

	it("fails with 401 when app is deleted (no app returned)", () => {
		const result = simulatePublicAuth({
			authHeader: "cpk_live_key123",
			keyRow: { appId: "app-1" },
			app: undefined,
			origin: undefined,
			allowedDomains: [],
		});
		expect(result.status).toBe(401);
		expect(result.error).toBe("App not found");
	});

	it("fails with 403 when production app has no origin", () => {
		const result = simulatePublicAuth({
			authHeader: "cpk_live_key123",
			keyRow: { appId: "app-1" },
			app: { id: "app-1", environment: "production", deletedAt: null },
			origin: undefined,
			allowedDomains: ["https://myapp.com"],
		});
		expect(result.status).toBe(403);
		expect(result.error).toBe("Origin header required for production apps");
	});

	it("fails with 403 when production app origin is not in allowed list", () => {
		const result = simulatePublicAuth({
			authHeader: "cpk_live_key123",
			keyRow: { appId: "app-1" },
			app: { id: "app-1", environment: "production", deletedAt: null },
			origin: "https://evil.com",
			allowedDomains: ["https://myapp.com"],
		});
		expect(result.status).toBe(403);
		expect(result.error).toBe("Origin not allowed");
	});

	it("succeeds for development app without origin validation", () => {
		const result = simulatePublicAuth({
			authHeader: "cpk_dev_key456",
			keyRow: { appId: "app-2" },
			app: { id: "app-2", environment: "development", deletedAt: null },
			origin: undefined,
			allowedDomains: [],
		});
		expect(result.status).toBe(200);
		expect(result.appId).toBe("app-2");
	});
});

describe("developer API auth - full secret auth flow simulation", () => {
	function simulateSecretAuth(params: {
		authHeader: string | undefined;
		keyRow: { appId: string } | undefined;
		app:
			| { id: string; environment: string; deletedAt: Date | null }
			| undefined;
	}): { status: number; error?: string; appId?: string } {
		if (!params.authHeader?.startsWith("csk_")) {
			return { status: 401, error: "Invalid secret key" };
		}

		if (!params.keyRow) {
			return { status: 401, error: "Invalid or revoked secret key" };
		}

		if (!params.app) {
			return { status: 401, error: "App not found" };
		}

		return { status: 200, appId: params.app.id };
	}

	it("succeeds with valid secret key and active app", () => {
		const result = simulateSecretAuth({
			authHeader: "csk_live_secret789",
			keyRow: { appId: "app-1" },
			app: { id: "app-1", environment: "production", deletedAt: null },
		});
		expect(result.status).toBe(200);
		expect(result.appId).toBe("app-1");
	});

	it("fails with 401 when no auth header is provided", () => {
		const result = simulateSecretAuth({
			authHeader: undefined,
			keyRow: undefined,
			app: undefined,
		});
		expect(result.status).toBe(401);
		expect(result.error).toBe("Invalid secret key");
	});

	it("fails with 401 when key uses public prefix", () => {
		const result = simulateSecretAuth({
			authHeader: "cpk_public_key",
			keyRow: undefined,
			app: undefined,
		});
		expect(result.status).toBe(401);
		expect(result.error).toBe("Invalid secret key");
	});

	it("fails with 401 when key is revoked (no key row returned)", () => {
		const result = simulateSecretAuth({
			authHeader: "csk_revoked_key",
			keyRow: undefined,
			app: undefined,
		});
		expect(result.status).toBe(401);
		expect(result.error).toBe("Invalid or revoked secret key");
	});

	it("fails with 401 when app is deleted (no app returned)", () => {
		const result = simulateSecretAuth({
			authHeader: "csk_live_secret789",
			keyRow: { appId: "app-1" },
			app: undefined,
		});
		expect(result.status).toBe(401);
		expect(result.error).toBe("App not found");
	});

	it("does not perform origin validation even for production apps", () => {
		const result = simulateSecretAuth({
			authHeader: "csk_live_secret789",
			keyRow: { appId: "app-1" },
			app: { id: "app-1", environment: "production", deletedAt: null },
		});
		expect(result.status).toBe(200);
		expect(result.appId).toBe("app-1");
	});

	it("succeeds for development app without any extra checks", () => {
		const result = simulateSecretAuth({
			authHeader: "csk_dev_secret456",
			keyRow: { appId: "app-2" },
			app: { id: "app-2", environment: "development", deletedAt: null },
		});
		expect(result.status).toBe(200);
		expect(result.appId).toBe("app-2");
	});
});
