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
	buildEnv: {
		NEXT_PUBLIC_IS_CAP: "",
		NEXT_PUBLIC_WEB_URL: "https://cap.test",
	},
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
	promotionCodes: {
		list: vi.fn(),
	},
};

vi.mock("@cap/utils", () => ({
	STRIPE_DEVELOPER_CREDITS_PRODUCT_ID: {
		development: "prod_dev_test",
		production: "prod_live_test",
	},
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
		expect(await res.text()).toBe("User not authenticated");
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

	it("refuses a purchase from an account outside the preview list", async () => {
		const { buildEnv } = await import("@cap/env");
		const env = buildEnv as { NEXT_PUBLIC_IS_CAP?: string };
		env.NEXT_PUBLIC_IS_CAP = "true";
		try {
			mockGetCurrentUser.mockResolvedValue(mockUser);
			const res = await POST(
				makeRequest({ appId: "app-456", amountCents: 1000 }),
			);
			expect(res.status).toBe(403);
			expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();

			mockGetCurrentUser.mockResolvedValue({
				...mockUser,
				email: "richie@cap.so",
			});
			mockDb.limit.mockResolvedValueOnce([]);
			const allowed = await POST(
				makeRequest({ appId: "app-456", amountCents: 1000 }),
			);
			expect(allowed.status).toBe(404);
		} finally {
			env.NEXT_PUBLIC_IS_CAP = "";
		}
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

	it("returns the buyer to the app's Cap Infra billing page", async () => {
		mockGetCurrentUser.mockResolvedValue({
			...mockUser,
			stripeCustomerId: "cus_exist",
		});
		mockDb.limit
			.mockResolvedValueOnce([mockApp])
			.mockResolvedValueOnce([
				{ ...mockAccount, stripeCustomerId: "cus_exist" },
			]);
		mockStripe.checkout.sessions.create.mockResolvedValue({
			url: "https://checkout.stripe.com/test",
		});

		await POST(makeRequest({ appId: "app-456", amountCents: 2500 }));

		const [params] = mockStripe.checkout.sessions.create.mock.calls[0] ?? [];
		const successUrl = new URL(params.success_url);
		const cancelUrl = new URL(params.cancel_url);
		expect(successUrl.pathname).toBe("/dashboard/infra/app-456/billing");
		expect(successUrl.searchParams.get("purchase")).toBe("success");
		expect(cancelUrl.pathname).toBe("/dashboard/infra/app-456/billing");
		expect(cancelUrl.search).toBe("");
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

	let buyers = 0;
	const readyToBuy = () => {
		const id = `user-buyer-${++buyers}`;
		mockGetCurrentUser.mockResolvedValue({
			...mockUser,
			id,
			stripeCustomerId: "cus_exist",
		});
		mockDb.limit
			.mockResolvedValueOnce([{ ...mockApp, ownerId: id }])
			.mockResolvedValueOnce([
				{ ...mockAccount, stripeCustomerId: "cus_exist" },
			]);
		mockStripe.checkout.sessions.create.mockResolvedValue({
			url: "https://checkout.stripe.com/test",
		});
	};

	const promotion = (coupon: Record<string, unknown>) => ({
		data: [
			{
				id: "promo_123",
				coupon: {
					valid: true,
					amount_off: 500,
					currency: "usd",
					percent_off: null,
					...coupon,
				},
			},
		],
	});

	it("sends no discount when no code is given", async () => {
		readyToBuy();

		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1000 }),
		);

		expect(res.status).toBe(200);
		expect(mockStripe.promotionCodes.list).not.toHaveBeenCalled();
		const [params] = mockStripe.checkout.sessions.create.mock.calls[0] ?? [];
		expect(params).not.toHaveProperty("discounts");
		expect(params).not.toHaveProperty("allow_promotion_codes");
	});

	it("applies a code that is limited to the credits product", async () => {
		readyToBuy();
		mockStripe.promotionCodes.list.mockResolvedValue(
			promotion({ applies_to: { products: ["prod_dev_test"] } }),
		);

		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1000, code: " launch5 " }),
		);

		expect(res.status).toBe(200);
		expect(mockStripe.promotionCodes.list).toHaveBeenCalledWith({
			code: "launch5",
			active: true,
			limit: 1,
			expand: ["data.coupon.applies_to"],
		});
		expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
			expect.objectContaining({
				discounts: [{ promotion_code: "promo_123" }],
				metadata: expect.objectContaining({ amountCents: "1000" }),
			}),
		);
	});

	it.each([
		["is not limited to any product", promotion({})],
		[
			"is limited to another product",
			promotion({ applies_to: { products: ["prod_pro_plan"] } }),
		],
		[
			"has a coupon that is no longer valid",
			promotion({ valid: false, applies_to: { products: ["prod_dev_test"] } }),
		],
		[
			"takes a percentage off",
			promotion({
				amount_off: null,
				currency: null,
				percent_off: 100,
				applies_to: { products: ["prod_dev_test"] },
			}),
		],
		[
			"takes half off",
			promotion({
				amount_off: null,
				currency: null,
				percent_off: 50,
				applies_to: { products: ["prod_dev_test"] },
			}),
		],
		[
			"is priced in another currency",
			promotion({
				currency: "eur",
				applies_to: { products: ["prod_dev_test"] },
			}),
		],
		[
			"takes nothing off",
			promotion({
				amount_off: 0,
				applies_to: { products: ["prod_dev_test"] },
			}),
		],
		["does not exist", { data: [] }],
	])("refuses a code that %s", async (_label, found) => {
		readyToBuy();
		mockStripe.promotionCodes.list.mockResolvedValue(found);

		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1000, code: "SOMECODE" }),
		);

		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe(
			"That code cannot be used for this purchase",
		);
		expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
	});

	it("returns 400 when Stripe will not apply the code to this purchase", async () => {
		readyToBuy();
		mockStripe.promotionCodes.list.mockResolvedValue(
			promotion({ applies_to: { products: ["prod_dev_test"] } }),
		);
		mockStripe.checkout.sessions.create.mockRejectedValue(
			Object.assign(new Error("total must be at least $0.50"), {
				type: "StripeInvalidRequestError",
			}),
		);

		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 520, code: "FIVEOFF" }),
		);

		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe(
			"That code cannot be used for this purchase",
		);
	});

	it("returns 500 when the code lookup fails", async () => {
		readyToBuy();
		mockStripe.promotionCodes.list.mockRejectedValue(new Error("Stripe down"));

		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1000, code: "FIVEOFF" }),
		);

		expect(res.status).toBe(500);
		expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
	});

	it("stops looking codes up after ten attempts by one user", async () => {
		mockStripe.promotionCodes.list.mockResolvedValue({ data: [] });
		const attempt = async (userId: string) => {
			mockGetCurrentUser.mockResolvedValue({
				...mockUser,
				id: userId,
				stripeCustomerId: "cus_exist",
			});
			mockDb.limit
				.mockResolvedValueOnce([{ ...mockApp, ownerId: userId }])
				.mockResolvedValueOnce([
					{ ...mockAccount, stripeCustomerId: "cus_exist" },
				]);
			return POST(
				makeRequest({ appId: "app-456", amountCents: 1000, code: "GUESS" }),
			);
		};

		for (let i = 0; i < 10; i++) {
			expect((await attempt("user-guesser")).status).toBe(400);
		}
		const blocked = await attempt("user-guesser");

		expect(blocked.status).toBe(429);
		expect(mockStripe.promotionCodes.list).toHaveBeenCalledTimes(10);
		expect((await attempt("user-other")).status).toBe(400);
	});

	it("does not count purchases without a code against the code limit", async () => {
		for (let i = 0; i < 12; i++) {
			readyToBuy();
			const res = await POST(
				makeRequest({ appId: "app-456", amountCents: 1000 }),
			);
			expect(res.status).toBe(200);
		}
	});

	it("stops opening checkouts after twenty attempts by one user", async () => {
		const attempt = async (userId: string) => {
			mockGetCurrentUser.mockResolvedValue({
				...mockUser,
				id: userId,
				stripeCustomerId: "cus_exist",
			});
			mockDb.limit
				.mockResolvedValueOnce([{ ...mockApp, ownerId: userId }])
				.mockResolvedValueOnce([
					{ ...mockAccount, stripeCustomerId: "cus_exist" },
				]);
			mockStripe.checkout.sessions.create.mockResolvedValue({
				url: "https://checkout.stripe.com/test",
			});
			return POST(makeRequest({ appId: "app-456", amountCents: 1000 }));
		};

		for (let i = 0; i < 20; i++) {
			expect((await attempt("user-repeat-buyer")).status).toBe(200);
		}
		const reads = mockDb.limit.mock.calls.length;
		const blocked = await attempt("user-repeat-buyer");

		expect(blocked.status).toBe(429);
		expect(await blocked.json()).toEqual({
			error: "Too many checkout attempts. Try again in a few minutes",
		});
		expect(mockStripe.checkout.sessions.create).toHaveBeenCalledTimes(20);
		expect(mockDb.limit.mock.calls.length).toBe(reads);
		resetMockDb();
		expect((await attempt("user-another-buyer")).status).toBe(200);
	});

	it("returns 400 for an empty or oversized code", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);

		const empty = await POST(
			makeRequest({ appId: "app-456", amountCents: 1000, code: "   " }),
		);
		const long = await POST(
			makeRequest({
				appId: "app-456",
				amountCents: 1000,
				code: "A".repeat(65),
			}),
		);

		expect(empty.status).toBe(400);
		expect(long.status).toBe(400);
		expect(mockStripe.promotionCodes.list).not.toHaveBeenCalled();
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
