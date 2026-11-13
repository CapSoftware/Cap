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

const mockCheckoutStripe = {
	customers: {
		listTaxIds: vi.fn(),
		createTaxId: vi.fn(),
		deleteTaxId: vi.fn(),
	},
};

vi.mock("@/lib/checkout/stripe", () => ({
	checkoutStripe: () => mockCheckoutStripe,
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

	it("refuses a purchase over $10,000", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1_000_001 }),
		);
		expect(res.status).toBe(400);
		expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
	});

	it("opens a $10,000 purchase", async () => {
		mockGetCurrentUser.mockResolvedValue(mockUser);
		mockDb.limit
			.mockResolvedValueOnce([mockApp])
			.mockResolvedValueOnce([
				{ ...mockAccount, stripeCustomerId: "cus_acct" },
			]);
		mockStripe.checkout.sessions.create.mockResolvedValue({
			url: "https://checkout.stripe.com/test",
		});

		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1_000_000 }),
		);

		expect(res.status).toBe(200);
		expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
			expect.objectContaining({
				line_items: [
					expect.objectContaining({
						price_data: expect.objectContaining({ unit_amount: 1_000_000 }),
					}),
				],
				metadata: expect.objectContaining({ amountCents: "1000000" }),
				payment_method_types: ["card"],
				payment_method_options: { card: { request_three_d_secure: "any" } },
			}),
		);
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

	it("emails a paid invoice to the account email and collects tax details like Cap Pro", async () => {
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
		expect(params).toMatchObject({
			customer: "cus_exist",
			mode: "payment",
			invoice_creation: {
				enabled: true,
				invoice_data: { description: "Cap Infra credits for Test App" },
			},
			payment_intent_data: {
				description: "Cap Infra credits for Test App",
				receipt_email: "test@example.com",
				metadata: { type: "developer_credits", accountId: "account-001" },
			},
			tax_id_collection: { enabled: true },
			billing_address_collection: "auto",
			customer_update: { name: "auto", address: "auto" },
		});
		expect(params).not.toHaveProperty("automatic_tax");
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

describe("credit checkout for a named app and a US business", () => {
	const fundedAccount = { ...mockAccount, stripeCustomerId: "cus_exist" };
	let POST: typeof import("@/app/api/developer/credits/checkout/route").POST;
	let buyer = 0;

	beforeEach(async () => {
		vi.clearAllMocks();
		resetMockDb();
		POST = (await import("@/app/api/developer/credits/checkout/route")).POST;
		buyer += 1;
		mockGetCurrentUser.mockResolvedValue({
			...mockUser,
			id: `user-business-${buyer}`,
			stripeCustomerId: "cus_exist",
		});
		mockStripe.checkout.sessions.create.mockResolvedValue({
			url: "https://checkout.stripe.com/test",
		});
		mockCheckoutStripe.customers.listTaxIds.mockResolvedValue({ data: [] });
		mockCheckoutStripe.customers.createTaxId.mockResolvedValue({});
		mockCheckoutStripe.customers.deleteTaxId.mockResolvedValue({});
	});

	const lastParams = () =>
		mockStripe.checkout.sessions.create.mock.calls[0]?.[0] as Record<
			string,
			unknown
		>;

	it("names the app on the Stripe page, the invoice and the payment, and offers card and Link only", async () => {
		mockDb.limit
			.mockResolvedValueOnce([{ ...mockApp, name: "  Course   site  " }])
			.mockResolvedValueOnce([fundedAccount]);

		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1000 }),
		);

		expect(res.status).toBe(200);
		expect(lastParams()).toMatchObject({
			payment_method_types: ["card", "link"],
			custom_text: {
				submit: {
					message:
						"Cap Infra credits for Course site. Credit stays with this app and cannot be moved to another app.",
				},
			},
			invoice_creation: {
				invoice_data: { description: "Cap Infra credits for Course site" },
			},
			payment_intent_data: {
				description: "Cap Infra credits for Course site",
			},
		});
		expect(lastParams()).not.toHaveProperty("payment_method_configuration");
	});

	it("saves a US EIN on the customer before the session is created", async () => {
		mockDb.limit
			.mockResolvedValueOnce([mockApp])
			.mockResolvedValueOnce([fundedAccount]);

		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1000, usEin: "123456789" }),
		);

		expect(res.status).toBe(200);
		expect(mockCheckoutStripe.customers.createTaxId).toHaveBeenCalledWith(
			"cus_exist",
			{ type: "us_ein", value: "12-3456789" },
		);
		expect(
			mockCheckoutStripe.customers.createTaxId.mock.invocationCallOrder[0],
		).toBeLessThan(
			mockStripe.checkout.sessions.create.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mockCheckoutStripe.customers.deleteTaxId).not.toHaveBeenCalled();
	});

	it("keeps an EIN the customer already has and adds nothing twice", async () => {
		mockDb.limit
			.mockResolvedValueOnce([mockApp])
			.mockResolvedValueOnce([fundedAccount]);
		mockCheckoutStripe.customers.listTaxIds.mockResolvedValue({
			data: [{ id: "txi_1", type: "us_ein", value: "12-3456789" }],
		});

		await POST(
			makeRequest({ appId: "app-456", amountCents: 1000, usEin: "12-3456789" }),
		);

		expect(mockCheckoutStripe.customers.createTaxId).not.toHaveBeenCalled();
		expect(mockCheckoutStripe.customers.deleteTaxId).not.toHaveBeenCalled();
		expect(mockStripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
	});

	it("replaces a different saved EIN and leaves other tax IDs alone", async () => {
		mockDb.limit
			.mockResolvedValueOnce([mockApp])
			.mockResolvedValueOnce([fundedAccount]);
		mockCheckoutStripe.customers.listTaxIds.mockResolvedValue({
			data: [
				{ id: "txi_vat", type: "eu_vat", value: "DE123456789" },
				{ id: "txi_old", type: "us_ein", value: "98-7654321" },
			],
		});

		await POST(
			makeRequest({ appId: "app-456", amountCents: 1000, usEin: "12-3456789" }),
		);

		expect(mockCheckoutStripe.customers.deleteTaxId).toHaveBeenCalledTimes(1);
		expect(mockCheckoutStripe.customers.deleteTaxId).toHaveBeenCalledWith(
			"cus_exist",
			"txi_old",
		);
		expect(mockCheckoutStripe.customers.createTaxId).toHaveBeenCalledWith(
			"cus_exist",
			{ type: "us_ein", value: "12-3456789" },
		);
	});

	it("keeps the saved EIN when Stripe will not take its replacement", async () => {
		mockDb.limit
			.mockResolvedValueOnce([mockApp])
			.mockResolvedValueOnce([fundedAccount]);
		mockCheckoutStripe.customers.listTaxIds.mockResolvedValue({
			data: [{ id: "txi_old", type: "us_ein", value: "98-7654321" }],
		});
		mockCheckoutStripe.customers.createTaxId.mockRejectedValue(
			new Error("tax id rejected"),
		);

		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1000, usEin: "12-3456789" }),
		);

		expect(res.status).toBe(500);
		expect(mockCheckoutStripe.customers.deleteTaxId).not.toHaveBeenCalled();
		expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
	});

	it("adds the new EIN before removing the old one", async () => {
		mockDb.limit
			.mockResolvedValueOnce([mockApp])
			.mockResolvedValueOnce([fundedAccount]);
		mockCheckoutStripe.customers.listTaxIds
			.mockResolvedValueOnce({
				data: [{ id: "txi_old", type: "us_ein", value: "98-7654321" }],
			})
			.mockResolvedValueOnce({
				data: [{ id: "txi_old", type: "us_ein", value: "98-7654321" }],
			})
			.mockResolvedValue({
				data: [
					{ id: "txi_old", type: "us_ein", value: "98-7654321" },
					{ id: "txi_new", type: "us_ein", value: "12-3456789" },
				],
			});

		await POST(
			makeRequest({ appId: "app-456", amountCents: 1000, usEin: "12-3456789" }),
		);

		expect(
			mockCheckoutStripe.customers.createTaxId.mock.invocationCallOrder[0],
		).toBeLessThan(
			mockCheckoutStripe.customers.deleteTaxId.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mockCheckoutStripe.customers.deleteTaxId).toHaveBeenCalledWith(
			"cus_exist",
			"txi_old",
		);
		expect(mockCheckoutStripe.customers.createTaxId).toHaveBeenCalledTimes(1);
	});

	it("touches no tax IDs when the EIN is left blank", async () => {
		mockDb.limit
			.mockResolvedValueOnce([mockApp])
			.mockResolvedValueOnce([fundedAccount]);

		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1000, usEin: "   " }),
		);

		expect(res.status).toBe(200);
		expect(mockCheckoutStripe.customers.listTaxIds).not.toHaveBeenCalled();
		expect(mockCheckoutStripe.customers.createTaxId).not.toHaveBeenCalled();
	});

	it("refuses an EIN that is not 9 digits before opening a checkout", async () => {
		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1000, usEin: "12-345" }),
		);

		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: "Enter the EIN as 9 digits, for example 12-3456789",
		});
		expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
		expect(mockCheckoutStripe.customers.listTaxIds).not.toHaveBeenCalled();
	});

	it("opens no checkout when Stripe will not save the EIN", async () => {
		mockDb.limit
			.mockResolvedValueOnce([mockApp])
			.mockResolvedValueOnce([fundedAccount]);
		mockCheckoutStripe.customers.createTaxId.mockRejectedValue(
			new Error("tax id rejected"),
		);

		const res = await POST(
			makeRequest({ appId: "app-456", amountCents: 1000, usEin: "123456789" }),
		);

		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({
			error: "Could not save the EIN. Try again or leave it blank",
		});
		expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
	});
});
