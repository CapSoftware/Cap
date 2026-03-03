import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = {
	select: vi.fn(),
	insert: vi.fn(),
	update: vi.fn(),
	from: vi.fn(),
	set: vi.fn(),
	where: vi.fn(),
	limit: vi.fn(),
	values: vi.fn(),
};

function resetMockDb() {
	for (const key of Object.keys(mockDb)) {
		const fn = mockDb[key as keyof typeof mockDb];
		if (typeof fn?.mockClear === "function") {
			fn.mockClear();
		}
	}
	mockDb.select.mockReturnValue(mockDb);
	mockDb.insert.mockReturnValue(mockDb);
	mockDb.update.mockReturnValue(mockDb);
	mockDb.from.mockReturnValue(mockDb);
	mockDb.set.mockReturnValue(mockDb);
	mockDb.where.mockReturnValue(mockDb);
	mockDb.limit.mockReturnValue(Promise.resolve([]));
	mockDb.values.mockReturnValue(Promise.resolve());
}

vi.mock("@cap/database", () => ({
	db: () => mockDb,
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(),
}));

vi.mock("@cap/database/schema", () => ({
	developerApps: {
		id: "id",
		ownerId: "ownerId",
		deletedAt: "deletedAt",
	},
	developerCreditAccounts: {
		id: "id",
		appId: "appId",
		stripeCustomerId: "stripeCustomerId",
	},
	users: { id: "id" },
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		WEB_URL: "https://cap.test",
	}),
}));

const mockStripe = {
	customers: {
		list: vi.fn(),
		create: vi.fn(),
		update: vi.fn(),
	},
	checkout: {
		sessions: {
			create: vi.fn(),
		},
	},
};

vi.mock("@cap/utils", () => ({
	stripe: () => mockStripe,
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((a: unknown, b: unknown) => ({ eq: [a, b] })),
	isNull: vi.fn((a: unknown) => ({ isNull: a })),
}));

import { getCurrentUser } from "@cap/database/auth/session";

const mockGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>;

const mockUser = {
	id: "user-123",
	email: "test@example.com",
	stripeCustomerId: null,
};

const mockApp = {
	id: "app-456",
	ownerId: "user-123",
	name: "Test App",
	deletedAt: null,
};

const mockAccount = {
	id: "account-001",
	appId: "app-456",
	stripeCustomerId: null,
};

function makeRequest(body: Record<string, unknown>) {
	return new Request("https://cap.test/api/developer/credits/checkout", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	}) as unknown as import("next/server").NextRequest;
}

describe("POST /api/developer/credits/checkout", () => {
	let POST: typeof import("@/app/api/developer/credits/checkout/route").POST;

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		const mod = await import("@/app/api/developer/credits/checkout/route");
		POST = mod.POST;
	});

	it("returns 401 when user is not authenticated", async () => {
		mockGetCurrentUser.mockResolvedValue(null);
		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1000 }),
		);
		expect(res.status).toBe(401);
		const body = await res.json();
		expect(body.error).toBe("Unauthorized");
	});

	it("returns 400 when appId is missing", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		const res = await POST(makeRequest({ amountCents: 1000 }));
		expect(res.status).toBe(400);
	});

	it("returns 400 when amountCents is below minimum", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		const res = await POST(makeRequest({ appId: "app-456", amountCents: 499 }));
		expect(res.status).toBe(400);
	});

	it("returns 400 when amountCents is not an integer", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 500.5 }),
		);
		expect(res.status).toBe(400);
	});

	it("returns 400 when amountCents is not a number", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: "1000" }),
		);
		expect(res.status).toBe(400);
	});

	it("returns 404 when app is not found", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([]);
		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1000 }),
		);
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe("App not found");
	});

	it("returns 404 when credit account is not found", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit.mockResolvedValueOnce([mockApp]).mockResolvedValueOnce([]);
		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1000 }),
		);
		expect(res.status).toBe(404);
		const body = await res.json();
		expect(body.error).toBe("Credit account not found");
	});

	it("creates a new Stripe customer when none exists", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit
			.mockResolvedValueOnce([mockApp])
			.mockResolvedValueOnce([mockAccount]);

		const newCustomer = { id: "cus_new123", metadata: {} };
		mockStripe.customers.list.mockResolvedValue({ data: [] });
		mockStripe.customers.create.mockResolvedValue(newCustomer);
		mockStripe.checkout.sessions.create.mockResolvedValue({
			url: "https://checkout.stripe.com/test",
		});

		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1000 }),
		);
		expect(res.status).toBe(200);
		expect(mockStripe.customers.create).toHaveBeenCalledWith({
			email: "test@example.com",
			metadata: { userId: "user-123" },
		});
	});

	it("reuses existing Stripe customer found by email", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit
			.mockResolvedValueOnce([mockApp])
			.mockResolvedValueOnce([mockAccount]);

		const existingCustomer = {
			id: "cus_existing",
			metadata: { otherKey: "val" },
		};
		mockStripe.customers.list.mockResolvedValue({
			data: [existingCustomer],
		});
		mockStripe.customers.update.mockResolvedValue(existingCustomer);
		mockStripe.checkout.sessions.create.mockResolvedValue({
			url: "https://checkout.stripe.com/test",
		});

		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1000 }),
		);
		expect(res.status).toBe(200);
		expect(mockStripe.customers.update).toHaveBeenCalledWith(
			"cus_existing",
			expect.objectContaining({
				metadata: expect.objectContaining({ userId: "user-123" }),
			}),
		);
		expect(mockStripe.customers.create).not.toHaveBeenCalled();
	});

	it("skips customer creation when account already has stripeCustomerId", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		const accountWithStripe = { ...mockAccount, stripeCustomerId: "cus_acct" };
		mockDb.limit
			.mockResolvedValueOnce([mockApp])
			.mockResolvedValueOnce([accountWithStripe]);

		mockStripe.checkout.sessions.create.mockResolvedValue({
			url: "https://checkout.stripe.com/test",
		});

		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 2500 }),
		);
		expect(res.status).toBe(200);
		expect(mockStripe.customers.list).not.toHaveBeenCalled();
		expect(mockStripe.customers.create).not.toHaveBeenCalled();
	});

	it("creates checkout session with correct metadata", async () => {
		mockGetCurrentUser.mockResolvedValue({
			...mockUser,
			stripeCustomerId: "cus_exist",
		});
		const accountWithStripe = { ...mockAccount, stripeCustomerId: "cus_exist" };
		mockDb.limit
			.mockResolvedValueOnce([mockApp])
			.mockResolvedValueOnce([accountWithStripe]);

		mockStripe.checkout.sessions.create.mockResolvedValue({
			url: "https://checkout.stripe.com/test",
		});

		await POST(makeRequest({ appId: "app-456", amountCents: 2500 }));

		expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
			expect.objectContaining({
				mode: "payment",
				metadata: {
					type: "developer_credits",
					appId: "app-456",
					accountId: "account-001",
					amountCents: "2500",
					userId: "user-123",
				},
			}),
		);
	});

	it("returns checkout URL on success", async () => {
		mockGetCurrentUser.mockResolvedValue({
			...mockUser,
			stripeCustomerId: "cus_exist",
		});
		const accountWithStripe = { ...mockAccount, stripeCustomerId: "cus_exist" };
		mockDb.limit
			.mockResolvedValueOnce([mockApp])
			.mockResolvedValueOnce([accountWithStripe]);

		mockStripe.checkout.sessions.create.mockResolvedValue({
			url: "https://checkout.stripe.com/session_abc",
		});

		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1000 }),
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.url).toBe("https://checkout.stripe.com/session_abc");
	});

	it("returns 500 when checkout session has no URL", async () => {
		mockGetCurrentUser.mockResolvedValue({
			...mockUser,
			stripeCustomerId: "cus_exist",
		});
		const accountWithStripe = { ...mockAccount, stripeCustomerId: "cus_exist" };
		mockDb.limit
			.mockResolvedValueOnce([mockApp])
			.mockResolvedValueOnce([accountWithStripe]);

		mockStripe.checkout.sessions.create.mockResolvedValue({ url: null });

		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1000 }),
		);
		expect(res.status).toBe(500);
	});

	it("returns 500 when Stripe throws", async () => {
		mockGetCurrentUser.mockResolvedValue({
			...mockUser,
			stripeCustomerId: "cus_exist",
		});
		const accountWithStripe = { ...mockAccount, stripeCustomerId: "cus_exist" };
		mockDb.limit
			.mockResolvedValueOnce([mockApp])
			.mockResolvedValueOnce([accountWithStripe]);

		mockStripe.checkout.sessions.create.mockRejectedValue(
			new Error("Stripe error"),
		);

		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1000 }),
		);
		expect(res.status).toBe(500);
	});

	it("sets line_items with correct unit_amount", async () => {
		mockGetCurrentUser.mockResolvedValue({
			...mockUser,
			stripeCustomerId: "cus_exist",
		});
		const accountWithStripe = { ...mockAccount, stripeCustomerId: "cus_exist" };
		mockDb.limit
			.mockResolvedValueOnce([mockApp])
			.mockResolvedValueOnce([accountWithStripe]);

		mockStripe.checkout.sessions.create.mockResolvedValue({
			url: "https://checkout.stripe.com/test",
		});

		await POST(makeRequest({ appId: "app-456", amountCents: 5000 }));

		const call = mockStripe.checkout.sessions.create.mock.calls[0]?.[0];
		expect(call.line_items[0].price_data.unit_amount).toBe(5000);
		expect(call.line_items[0].price_data.currency).toBe("usd");
		expect(call.line_items[0].quantity).toBe(1);
	});
});
