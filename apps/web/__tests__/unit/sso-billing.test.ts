import { AsyncLocalStorage } from "node:async_hooks";
import type { organizationSso } from "@cap/database/schema";
import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	stripe: {
		customers: { create: vi.fn() },
		subscriptions: { retrieve: vi.fn(), list: vi.fn() },
		invoices: { retrieve: vi.fn(), list: vi.fn(), listLineItems: vi.fn() },
		prices: { retrieve: vi.fn() },
		checkout: {
			sessions: { create: vi.fn(), retrieve: vi.fn(), expire: vi.fn() },
		},
		billingPortal: { sessions: { create: vi.fn() } },
	},
	listSubscriptions: vi.fn(),
	environment: {
		NODE_ENV: "production",
		WEB_URL: "https://cap.test",
		STRIPE_SAML_SSO_PRICE_ID: undefined as string | undefined,
	},
}));

vi.mock("@cap/env", () => ({
	buildEnv: {},
	serverEnv: () => mocks.environment,
}));
vi.mock("@cap/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@cap/utils")>();
	return { ...actual, stripe: () => mocks.stripe };
});
vi.mock("@cap/database", () => ({ db: () => database }));
vi.mock("@cap/database/schema", () => {
	const table = (name: string, columns: string[]) => ({
		_table: name,
		...Object.fromEntries(
			columns.map((column) => [column, `${name}.${column}`]),
		),
	});
	return {
		organizations: table("organizations", ["id", "ownerId", "tombstoneAt"]),
		users: table("users", ["id", "stripeCustomerId"]),
		organizationSso: table("organizationSso", [
			"organizationId",
			"stripeCustomerId",
			"stripeSubscriptionId",
			"checkoutAttemptId",
			"checkoutSessionId",
		]),
	};
});
vi.mock("drizzle-orm", () => ({
	eq: (column: string, value: unknown) => ({ column, value }),
	and: (...conditions: Condition[]) => ({ conditions }),
	isNull: (column: string) => ({ column, value: null }),
}));

import {
	hasSsoAccess,
	STRIPE_SAML_SSO_LEGACY_PRICE_ID,
	STRIPE_SAML_SSO_PRICE_ID,
	STRIPE_SAML_SSO_PRODUCT_ID,
} from "@cap/utils";
import { Organisation, User } from "@cap/web-domain";
import {
	attachSsoCheckout,
	createSsoBillingPortal,
	createSsoCheckout,
	getSsoPrices,
	syncSsoSubscription,
} from "@/lib/sso/billing";

type BillingRow = typeof organizationSso.$inferSelect;
type Row = Record<string, unknown>;
type Table = { _table: string };
type Condition =
	| { column: string; value: unknown }
	| { conditions: Condition[] };

const organizationId = Organisation.OrganisationId.make("org_owner");
const userId = User.UserId.make("user_owner");
const periodEnd = Math.floor(new Date("2026-10-02T00:00:00Z").getTime() / 1000);
const state = {
	billing: new Map<string, Row>(),
	organizations: new Map<string, Row>(),
	users: new Map<string, Row>(),
	sessions: new Map<string, Stripe.Checkout.Session>(),
	transactionTail: Promise.resolve(),
};
const transactionContext = new AsyncLocalStorage<boolean>();

function rowsFor(table: Table) {
	if (table._table === "organizationSso") return state.billing;
	if (table._table === "organizations") return state.organizations;
	if (table._table === "users") return state.users;
	throw new Error(`Unexpected table ${table._table}`);
}

function fieldValue(row: Row, table: Table, column: string) {
	const [source, key = ""] = column.split(".");
	if (table._table === "organizations" && source === "users") {
		return state.users.get(String(row.ownerId))?.[key];
	}
	return row[key];
}

function matches(row: Row, table: Table, condition?: Condition): boolean {
	if (!condition) return true;
	if ("conditions" in condition) {
		return condition.conditions.every((item) => matches(row, table, item));
	}
	return fieldValue(row, table, condition.column) === condition.value;
}

class Query {
	private table: Table = { _table: "unset" };
	private condition?: Condition;

	constructor(private projection?: Record<string, string>) {}

	from(table: Table) {
		this.table = table;
		return this;
	}
	innerJoin() {
		return this;
	}
	where(condition: Condition) {
		this.condition = condition;
		return this;
	}
	limit(count: number) {
		const result = Promise.resolve().then(() =>
			[...rowsFor(this.table).values()]
				.filter((row) => matches(row, this.table, this.condition))
				.slice(0, count)
				.map((row) =>
					structuredClone(
						this.projection
							? Object.fromEntries(
									Object.entries(this.projection).map(([key, column]) => [
										key,
										fieldValue(row, this.table, column),
									]),
								)
							: row,
					),
				),
		);
		return Object.assign(result, { for: () => result });
	}
}

const database = {
	select: (projection?: Record<string, string>) => new Query(projection),
	insert: (table: Table) => ({
		values: async (row: Row) => {
			if (table._table !== "organizationSso")
				throw new Error("Unexpected non-SSO write");
			const id = String(row.organizationId);
			if (state.billing.has(id))
				throw new Error("Duplicate organization billing");
			state.billing.set(id, { ...billingRow(), ...row });
		},
	}),
	update: (table: Table) => ({
		set: (fields: Row) => ({
			where: async (condition: Condition) => {
				if (
					table._table === "users" &&
					(Object.keys(fields).length !== 1 || !fields.stripeCustomerId)
				) {
					throw new Error("Unexpected Pro billing mutation");
				}
				for (const [id, row] of rowsFor(table)) {
					if (matches(row, table, condition))
						rowsFor(table).set(id, { ...row, ...fields });
				}
			},
		}),
	}),
	transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
		const result = state.transactionTail.then(() =>
			transactionContext.run(true, () => callback(database)),
		);
		state.transactionTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	},
};

function billingRow(overrides: Partial<BillingRow> = {}): BillingRow {
	return {
		organizationId,
		purchasedByUserId: userId,
		stripeCustomerId: "cus_owner",
		stripeSubscriptionId: null,
		stripePriceId: null,
		status: "unpaid",
		paidThrough: null,
		currentPeriodEnd: null,
		cancelAtPeriodEnd: false,
		checkoutAttemptId: null,
		checkoutSessionId: null,
		checkoutStartedAt: null,
		checkoutCurrency: null,
		checkoutPriceId: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	};
}

function paidInvoice(priceId = STRIPE_SAML_SSO_PRICE_ID): Stripe.Invoice {
	return {
		id: "in_sso",
		status: "paid",
		customer: "cus_owner",
		subscription: "sub_sso",
		lines: {
			has_more: false,
			data: [
				{
					type: "subscription",
					proration: false,
					amount: 20000,
					price: { id: priceId },
					subscription: "sub_sso",
					subscription_item: "si_sso",
					period: { start: periodEnd - 30 * 86400, end: periodEnd },
				},
			],
		},
	} as unknown as Stripe.Invoice;
}

function ssoSubscription(
	overrides: Partial<Stripe.Subscription> = {},
	priceId = STRIPE_SAML_SSO_PRICE_ID,
): Stripe.Subscription {
	return {
		id: "sub_sso",
		customer: "cus_owner",
		status: "active",
		currency: "usd",
		metadata: { type: "saml_sso", organizationId, userId },
		current_period_end: periodEnd,
		cancel_at_period_end: false,
		items: {
			has_more: false,
			data: [
				{
					id: "si_sso",
					quantity: 1,
					price: {
						id: priceId,
						product: STRIPE_SAML_SSO_PRODUCT_ID,
						recurring: { interval: "month", interval_count: 1 },
					},
				},
			],
		},
		latest_invoice: paidInvoice(priceId),
		...overrides,
	} as Stripe.Subscription;
}

function checkoutSession(
	overrides: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session {
	return {
		id: "cs_sso",
		mode: "subscription",
		status: "complete",
		payment_status: "paid",
		currency: "usd",
		customer: "cus_owner",
		subscription: "sub_sso",
		metadata: { type: "saml_sso", organizationId, userId },
		...overrides,
	} as Stripe.Checkout.Session;
}

function checkoutInput(currency: "usd" | "gbp" | "eur" = "usd") {
	return {
		organizationId,
		purchasedByUserId: userId,
		stripeCustomerId: "cus_owner",
		currency,
	};
}

function proSubscription(overrides: Partial<Stripe.Subscription> = {}) {
	const subscription = ssoSubscription(
		{ id: "sub_pro", metadata: {}, ...overrides },
		"price_pro",
	);
	const item = subscription.items.data[0];
	if (!item) throw new Error("Missing Pro subscription item");
	item.price.product = "prod_pro";
	item.price.currency = "usd";
	return subscription;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-09-02T00:00:00Z"));
	vi.clearAllMocks();
	state.billing.clear();
	state.organizations.clear();
	state.users.clear();
	state.sessions.clear();
	state.transactionTail = Promise.resolve();
	state.organizations.set(organizationId, {
		id: organizationId,
		ownerId: userId,
		tombstoneAt: null,
	});
	state.users.set(userId, { id: userId, stripeCustomerId: "cus_owner" });
	mocks.environment.NODE_ENV = "production";
	mocks.environment.STRIPE_SAML_SSO_PRICE_ID = undefined;
	mocks.stripe.subscriptions.retrieve.mockImplementation(async () => {
		expect(transactionContext.getStore()).not.toBe(true);
		return ssoSubscription();
	});
	mocks.listSubscriptions.mockResolvedValue([]);
	mocks.stripe.subscriptions.list.mockReturnValue({
		autoPagingToArray: mocks.listSubscriptions,
	});
	mocks.stripe.invoices.list.mockResolvedValue({ data: [] });
	mocks.stripe.customers.create.mockResolvedValue({ id: "cus_created" });
	mocks.stripe.prices.retrieve.mockResolvedValue({
		id: STRIPE_SAML_SSO_PRICE_ID,
		active: true,
		currency: "usd",
		unit_amount: 20000,
		recurring: { interval: "month", interval_count: 1 },
		currency_options: {
			usd: { unit_amount: 20000 },
			gbp: { unit_amount: 20000 },
			eur: { unit_amount: 20000 },
		},
	});
	mocks.stripe.checkout.sessions.retrieve.mockImplementation(
		async (id: string) => {
			expect(transactionContext.getStore()).not.toBe(true);
			const session = state.sessions.get(id);
			if (!session) throw new Error("Missing checkout session");
			return structuredClone(session);
		},
	);
	mocks.stripe.checkout.sessions.create.mockImplementation(
		async (params: Stripe.Checkout.SessionCreateParams) => {
			expect(transactionContext.getStore()).not.toBe(true);
			const existing = [...state.sessions.values()].find(
				(session) =>
					session.metadata?.checkoutAttemptId ===
					params.metadata?.checkoutAttemptId,
			);
			if (existing) return existing;
			const session = checkoutSession({
				id: `cs_created_${state.sessions.size}`,
				status: "open",
				payment_status: "unpaid",
				subscription: null,
				url: "https://checkout.stripe.test/sso",
				metadata: params.metadata as Stripe.Metadata,
				customer: params.customer,
				currency: params.currency ?? null,
			});
			state.sessions.set(session.id, session);
			return session;
		},
	);
	mocks.stripe.checkout.sessions.expire.mockImplementation(
		async (id: string) => {
			expect(transactionContext.getStore()).not.toBe(true);
			const session = state.sessions.get(id);
			if (!session || session.status !== "open") {
				throw new Error("Checkout is not open");
			}
			const expired = { ...session, status: "expired" as const, url: null };
			state.sessions.set(id, expired);
			return structuredClone(expired);
		},
	);
	mocks.stripe.billingPortal.sessions.create.mockResolvedValue({
		url: "https://billing.stripe.test/sso",
	});
});

afterEach(() => vi.useRealTimers());

describe("existing subscription billing currency", () => {
	it.each(["usd", "gbp", "eur"] as const)(
		"uses the actual %s subscription currency for pricing and checkout",
		async (currency) => {
			mocks.listSubscriptions.mockResolvedValue([
				proSubscription({ currency }),
			]);
			expect(await getSsoPrices(organizationId)).toEqual([
				{ currency, unitAmount: 20000 },
			]);
			expect(mocks.stripe.subscriptions.list).toHaveBeenCalledWith({
				customer: "cus_owner",
				status: "all",
				limit: 100,
			});
			await createSsoCheckout(checkoutInput(currency));
			expect(mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
				expect.objectContaining({ currency }),
				expect.any(Object),
			);
		},
	);

	it.each([
		"active",
		"trialing",
		"past_due",
		"unpaid",
		"paused",
		"incomplete",
	] as const)(
		"does not accept another currency for a %s subscription",
		async (status) => {
			mocks.listSubscriptions.mockResolvedValue([
				proSubscription({
					currency: "gbp",
					status,
					cancel_at_period_end: true,
				}),
			]);
			await expect(createSsoCheckout(checkoutInput("eur"))).rejects.toThrow(
				"must use your existing billing currency",
			);
			expect(mocks.stripe.checkout.sessions.create).not.toHaveBeenCalled();
			expect(state.billing.size).toBe(0);
		},
	);

	it.each(["canceled", "incomplete_expired"] as const)(
		"allows currency selection after a %s subscription",
		async (status) => {
			mocks.listSubscriptions.mockResolvedValue([
				proSubscription({ currency: "gbp", status }),
			]);
			expect(await getSsoPrices(organizationId)).toHaveLength(3);
			await createSsoCheckout(checkoutInput("eur"));
			expect(mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
				expect.objectContaining({ currency: "eur" }),
				expect.any(Object),
			);
		},
	);

	it("allows multiple current products using the same billing currency", async () => {
		const otherProduct = proSubscription({
			id: "sub_other_product",
			currency: "gbp",
		});
		const item = otherProduct.items.data[0];
		if (!item) throw new Error("Missing other product subscription item");
		item.price.id = "price_other_product";
		item.price.product = "prod_other_product";
		mocks.listSubscriptions.mockResolvedValue([
			otherProduct,
			proSubscription({ currency: "gbp" }),
		]);
		expect(await getSsoPrices(organizationId)).toEqual([
			{ currency: "gbp", unitAmount: 20000 },
		]);
		await createSsoCheckout(checkoutInput("gbp"));
		expect(mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
			expect.objectContaining({ currency: "gbp" }),
			expect.any(Object),
		);
	});

	it.each(["canceled", "incomplete_expired"] as const)(
		"ignores a %s historical currency alongside the current subscription",
		async (status) => {
			mocks.listSubscriptions.mockResolvedValue([
				proSubscription({ id: "sub_historical", currency: "usd", status }),
				proSubscription({ currency: "gbp" }),
			]);
			expect(await getSsoPrices(organizationId)).toEqual([
				{ currency: "gbp", unitAmount: 20000 },
			]);
			await createSsoCheckout(checkoutInput("gbp"));
			expect(mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
				expect.objectContaining({ currency: "gbp" }),
				expect.any(Object),
			);
		},
	);

	it("keeps the selector for an owner without a billing customer", async () => {
		state.users.set(userId, { id: userId, stripeCustomerId: null });
		expect(await getSsoPrices(organizationId)).toHaveLength(3);
		expect(mocks.stripe.subscriptions.list).not.toHaveBeenCalled();
	});

	it("does not fall back to another currency when the matching price is unavailable", async () => {
		mocks.listSubscriptions.mockResolvedValue([
			proSubscription({ currency: "gbp" }),
		]);
		mocks.stripe.prices.retrieve.mockResolvedValue({
			active: true,
			currency: "usd",
			unit_amount: 20000,
			recurring: { interval: "month", interval_count: 1 },
		});
		expect(await getSsoPrices(organizationId)).toEqual([]);
	});

	it.each([{ currencies: ["cad"] }, { currencies: ["usd", "gbp"] }])(
		"blocks unsupported or conflicting subscription currencies $currencies",
		async ({ currencies }) => {
			mocks.listSubscriptions.mockResolvedValue(
				currencies.map((currency) => proSubscription({ currency })),
			);
			await expect(getSsoPrices(organizationId)).rejects.toThrow();
			await expect(createSsoCheckout(checkoutInput())).rejects.toThrow();
			expect(mocks.stripe.checkout.sessions.create).not.toHaveBeenCalled();
			expect(state.billing.size).toBe(0);
		},
	);

	it("does not create checkout when the subscription lookup fails", async () => {
		mocks.listSubscriptions.mockRejectedValue(new Error("Stripe unavailable"));
		await expect(getSsoPrices(organizationId)).rejects.toThrow(
			"Stripe unavailable",
		);
		await expect(createSsoCheckout(checkoutInput())).rejects.toThrow(
			"Stripe unavailable",
		);
		expect(mocks.stripe.checkout.sessions.create).not.toHaveBeenCalled();
	});

	it("expires a previous checkout before using a newly established billing currency", async () => {
		await createSsoCheckout(checkoutInput("eur"));
		const previousSessionId =
			state.billing.get(organizationId)?.checkoutSessionId;
		mocks.listSubscriptions.mockResolvedValue([
			proSubscription({ currency: "gbp" }),
		]);
		await createSsoCheckout(checkoutInput("gbp"));
		expect(state.sessions.get(String(previousSessionId))?.status).toBe(
			"expired",
		);
		expect(mocks.stripe.checkout.sessions.create).toHaveBeenLastCalledWith(
			expect.objectContaining({ currency: "gbp" }),
			expect.any(Object),
		);
	});
});

describe("verified organization SSO subscription synchronization", () => {
	it("binds a paid subscription to its exact organization without touching Pro", async () => {
		const record = await syncSsoSubscription("sub_sso");
		expect(record).toMatchObject({
			organizationId,
			purchasedByUserId: userId,
			stripeSubscriptionId: "sub_sso",
			status: "active",
		});
		expect(record?.paidThrough).toEqual(new Date(periodEnd * 1000));
		expect(hasSsoAccess(record)).toBe(true);
		expect(state.users.get(userId)).toEqual({
			id: userId,
			stripeCustomerId: "cus_owner",
		});
	});

	it("retains an explicitly linked legacy price and does not charge again", async () => {
		state.billing.set(
			organizationId,
			billingRow({ stripeSubscriptionId: "sub_sso" }),
		);
		state.users.set(userId, {
			id: userId,
			stripeCustomerId: "cus_separate_pro",
		});
		const subscription = ssoSubscription(
			{ metadata: {} },
			STRIPE_SAML_SSO_LEGACY_PRICE_ID,
		);
		mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
		const record = await syncSsoSubscription("sub_sso");
		expect(record?.stripePriceId).toBe(STRIPE_SAML_SSO_LEGACY_PRICE_ID);
		expect(hasSsoAccess(record)).toBe(true);
		expect(mocks.stripe.checkout.sessions.create).not.toHaveBeenCalled();
	});

	it("does not guess an organization for an unbound payment without metadata", async () => {
		mocks.stripe.subscriptions.retrieve.mockResolvedValue(
			ssoSubscription({ metadata: {} }),
		);
		expect(await syncSsoSubscription("sub_sso")).toBeNull();
		expect(state.billing.size).toBe(0);
	});

	it.each(["active", "past_due", "trialing"] as const)(
		"does not grant never-paid %s access",
		async (status) => {
			mocks.stripe.subscriptions.retrieve.mockResolvedValue(
				ssoSubscription({ status, latest_invoice: null }),
			);
			const record = await syncSsoSubscription("sub_sso");
			expect(record?.paidThrough).toBeNull();
			expect(hasSsoAccess(record)).toBe(false);
		},
	);

	it("does not derive paid-through from an unrelated paid invoice", async () => {
		const invoice = paidInvoice();
		invoice.subscription = "sub_other";
		mocks.stripe.subscriptions.retrieve.mockResolvedValue(
			ssoSubscription({ latest_invoice: invoice }),
		);
		expect(hasSsoAccess(await syncSsoSubscription("sub_sso"))).toBe(false);
	});

	it("rejects metadata-only entitlement on an unapproved product price", async () => {
		const subscription = ssoSubscription({}, "price_unknown");
		mocks.stripe.subscriptions.retrieve.mockResolvedValue(subscription);
		await expect(syncSsoSubscription("sub_sso")).rejects.toThrow(
			"supported SAML SSO price",
		);
		expect(state.billing.size).toBe(0);
	});

	it("revokes access when a linked subscription changes to an unsupported price", async () => {
		state.billing.set(
			organizationId,
			billingRow({
				stripeSubscriptionId: "sub_sso",
				status: "active",
				paidThrough: new Date(periodEnd * 1000),
			}),
		);
		mocks.stripe.subscriptions.retrieve.mockResolvedValue(
			ssoSubscription({}, "price_unknown"),
		);
		const record = await syncSsoSubscription("sub_sso");
		expect(record?.status).toBe("unpaid");
		expect(hasSsoAccess(record)).toBe(false);
	});

	it("rejects a payment bound to another customer's owner", async () => {
		mocks.stripe.subscriptions.retrieve.mockResolvedValue(
			ssoSubscription({ customer: "cus_other" }),
		);
		await expect(syncSsoSubscription("sub_sso")).rejects.toThrow(
			"different account",
		);
		expect(state.billing.size).toBe(0);
	});

	it("rechecks the billing customer under the organization lock before new association", async () => {
		mocks.stripe.subscriptions.retrieve.mockResolvedValue(
			ssoSubscription({ latest_invoice: null }),
		);
		mocks.stripe.invoices.list.mockImplementationOnce(async () => {
			state.users.set(userId, { id: userId, stripeCustomerId: "cus_changed" });
			return { data: [paidInvoice()] };
		});
		await expect(syncSsoSubscription("sub_sso")).rejects.toThrow(
			"billing account changed",
		);
		expect(state.billing.size).toBe(0);
	});

	it("does not replace a different live subscription", async () => {
		state.billing.set(
			organizationId,
			billingRow({ stripeSubscriptionId: "sub_existing", status: "active" }),
		);
		await expect(syncSsoSubscription("sub_sso")).rejects.toThrow(
			"different SAML SSO subscription",
		);
		expect(state.billing.get(organizationId)?.stripeSubscriptionId).toBe(
			"sub_existing",
		);
	});

	it("uses fresh cancellation state and preserves later subscription bindings", async () => {
		state.billing.set(
			organizationId,
			billingRow({
				stripeSubscriptionId: "sub_sso",
				status: "active",
				paidThrough: new Date(periodEnd * 1000),
			}),
		);
		mocks.stripe.subscriptions.retrieve.mockResolvedValue(
			ssoSubscription({ status: "canceled" }),
		);
		const canceled = await syncSsoSubscription("sub_sso");
		expect(canceled?.status).toBe("canceled");
		expect(hasSsoAccess(canceled)).toBe(false);
		state.billing.set(
			organizationId,
			billingRow({ stripeSubscriptionId: "sub_new", status: "active" }),
		);
		await syncSsoSubscription("sub_sso");
		expect(state.billing.get(organizationId)?.stripeSubscriptionId).toBe(
			"sub_new",
		);
		expect(state.billing.get(organizationId)?.status).toBe("active");
	});

	it("refreshes again when another sync changes billing during the Stripe request", async () => {
		state.billing.set(
			organizationId,
			billingRow({ stripeSubscriptionId: "sub_sso", status: "active" }),
		);
		mocks.stripe.subscriptions.retrieve
			.mockImplementationOnce(async () => {
				state.billing.set(
					organizationId,
					billingRow({ stripeSubscriptionId: "sub_sso", status: "canceled" }),
				);
				return ssoSubscription();
			})
			.mockResolvedValue(ssoSubscription({ status: "canceled" }));
		expect((await syncSsoSubscription("sub_sso"))?.status).toBe("canceled");
		expect(mocks.stripe.subscriptions.retrieve).toHaveBeenCalledTimes(2);
	});

	it("preserves the confirmed paid period during dunning and advances it after payment", async () => {
		const oldPaidThrough = new Date("2026-08-31T00:00:00Z");
		state.billing.set(
			organizationId,
			billingRow({
				stripeSubscriptionId: "sub_sso",
				status: "active",
				paidThrough: oldPaidThrough,
			}),
		);
		mocks.stripe.subscriptions.retrieve.mockResolvedValue(
			ssoSubscription({ status: "past_due", latest_invoice: null }),
		);
		const overdue = await syncSsoSubscription("sub_sso");
		expect(overdue?.paidThrough).toEqual(oldPaidThrough);
		expect(hasSsoAccess(overdue)).toBe(true);
		mocks.stripe.subscriptions.retrieve.mockResolvedValue(ssoSubscription());
		expect((await syncSsoSubscription("sub_sso"))?.paidThrough).toEqual(
			new Date(periodEnd * 1000),
		);
	});

	it("recognizes a paid overdue invoice when a newer invoice is still open", async () => {
		state.billing.set(
			organizationId,
			billingRow({
				stripeSubscriptionId: "sub_sso",
				status: "past_due",
				paidThrough: new Date("2026-08-01T00:00:00Z"),
			}),
		);
		mocks.stripe.subscriptions.retrieve.mockResolvedValue(
			ssoSubscription({
				status: "past_due",
				latest_invoice: { ...paidInvoice(), id: "in_new", status: "open" },
			}),
		);
		mocks.stripe.invoices.list.mockResolvedValue({ data: [paidInvoice()] });
		expect((await syncSsoSubscription("sub_sso"))?.paidThrough).toEqual(
			new Date(periodEnd * 1000),
		);
	});

	it("loads remaining invoice lines before deciding the SSO period is unpaid", async () => {
		const invoice = paidInvoice();
		mocks.stripe.subscriptions.retrieve.mockResolvedValue(
			ssoSubscription({
				latest_invoice: {
					...invoice,
					lines: { ...invoice.lines, data: [], has_more: true },
				},
			}),
		);
		mocks.stripe.invoices.listLineItems.mockReturnValue({
			autoPagingToArray: vi.fn().mockResolvedValue(invoice.lines.data),
		});
		expect(hasSsoAccess(await syncSsoSubscription("sub_sso"))).toBe(true);
		expect(mocks.stripe.invoices.listLineItems).toHaveBeenCalledWith("in_sso", {
			limit: 100,
		});
	});

	it("keeps a scheduled cancellation accessible through the paid period", async () => {
		mocks.stripe.subscriptions.retrieve.mockResolvedValue(
			ssoSubscription({ cancel_at_period_end: true }),
		);
		const record = await syncSsoSubscription("sub_sso");
		expect(record?.cancelAtPeriodEnd).toBe(true);
		expect(hasSsoAccess(record)).toBe(true);
	});
});

describe("SSO checkout ownership and duplicate prevention", () => {
	it("verifies the current owner before reading checkout data", async () => {
		await expect(
			attachSsoCheckout("cs_other", {
				organizationId,
				userId: User.UserId.make("user_other"),
			}),
		).rejects.toThrow("Only the organization owner");
		expect(mocks.stripe.checkout.sessions.retrieve).not.toHaveBeenCalled();
	});

	it("does not accept another organization's checkout or an unpaid redirect", async () => {
		state.sessions.set(
			"cs_sso",
			checkoutSession({
				metadata: { type: "saml_sso", organizationId: "org_other", userId },
			}),
		);
		await expect(
			attachSsoCheckout("cs_sso", { organizationId, userId }),
		).rejects.toThrow("different organization or account");
		expect(state.billing.size).toBe(0);
		state.sessions.set("cs_sso", checkoutSession({ payment_status: "unpaid" }));
		expect(
			await attachSsoCheckout("cs_sso", { organizationId, userId }),
		).toBeNull();
		expect(state.billing.size).toBe(0);
	});

	it("confirms duplicate checkout delivery idempotently", async () => {
		state.sessions.set("cs_sso", checkoutSession());
		await attachSsoCheckout("cs_sso", { organizationId, userId });
		const second = await attachSsoCheckout("cs_sso", {
			organizationId,
			userId,
		});
		expect(hasSsoAccess(second)).toBe(true);
		expect(state.billing.size).toBe(1);
		expect(mocks.stripe.checkout.sessions.create).not.toHaveBeenCalled();
	});

	it("creates organization-bound checkout with the displayed currency and fixed quantity", async () => {
		expect(await createSsoCheckout(checkoutInput("gbp"))).toBe(
			"https://checkout.stripe.test/sso",
		);
		expect(mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
			expect.objectContaining({
				currency: "gbp",
				customer: "cus_owner",
				mode: "subscription",
				line_items: [{ price: STRIPE_SAML_SSO_PRICE_ID, quantity: 1 }],
				metadata: expect.objectContaining({
					type: "saml_sso",
					organizationId,
					userId,
				}),
				subscription_data: {
					metadata: expect.objectContaining({
						type: "saml_sso",
						organizationId,
						userId,
					}),
				},
				success_url: expect.stringContaining(
					"/security?organizationId=org_owner&sso_checkout=",
				),
			}),
			{ idempotencyKey: expect.stringContaining("saml-sso-checkout-") },
		);
	});

	it("creates a billing customer idempotently when the owner does not have one", async () => {
		state.users.set(userId, { id: userId, stripeCustomerId: null });
		await createSsoCheckout({ ...checkoutInput(), stripeCustomerId: null });
		expect(mocks.stripe.customers.create).toHaveBeenCalledWith(
			{ metadata: { userId } },
			{ idempotencyKey: `cap-sso-customer-${userId}` },
		);
		expect(state.users.get(userId)).toEqual({
			id: userId,
			stripeCustomerId: "cus_created",
		});
		expect(mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
			expect.objectContaining({ customer: "cus_created" }),
			expect.any(Object),
		);
	});

	it("preserves a Pro customer attached concurrently while creating the SSO customer", async () => {
		state.users.set(userId, { id: userId, stripeCustomerId: null });
		mocks.stripe.customers.create.mockImplementationOnce(async () => {
			state.users.set(userId, { id: userId, stripeCustomerId: "cus_new_pro" });
			return { id: "cus_created" };
		});
		await createSsoCheckout({ ...checkoutInput(), stripeCustomerId: null });
		expect(state.users.get(userId)?.stripeCustomerId).toBe("cus_new_pro");
		expect(mocks.stripe.checkout.sessions.create).toHaveBeenCalledWith(
			expect.objectContaining({ customer: "cus_new_pro" }),
			expect.any(Object),
		);
	});

	it("reopens an existing session without starting another purchase", async () => {
		await createSsoCheckout(checkoutInput("eur"));
		await createSsoCheckout(checkoutInput("eur"));
		expect(mocks.stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
		expect(state.billing.get(organizationId)?.checkoutCurrency).toBe("eur");
	});

	it("confirms expiration before replacing an open checkout with the selected currency", async () => {
		await createSsoCheckout(checkoutInput("usd"));
		const previous = state.billing.get(organizationId);
		await createSsoCheckout(checkoutInput("gbp"));
		expect(mocks.stripe.checkout.sessions.expire).toHaveBeenCalledWith(
			previous?.checkoutSessionId,
			{},
			{ idempotencyKey: `saml-sso-expire-${previous?.checkoutAttemptId}` },
		);
		expect(
			state.sessions.get(String(previous?.checkoutSessionId))?.status,
		).toBe("expired");
		expect(mocks.stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
		expect(mocks.stripe.checkout.sessions.create).toHaveBeenLastCalledWith(
			expect.objectContaining({ currency: "gbp" }),
			expect.any(Object),
		);
		expect(state.billing.get(organizationId)?.checkoutCurrency).toBe("gbp");
	});

	it("retains the same attempt until an ambiguous currency-switch expiration is reconciled", async () => {
		await createSsoCheckout(checkoutInput("usd"));
		const previous = structuredClone(state.billing.get(organizationId));
		mocks.stripe.checkout.sessions.expire.mockImplementationOnce(
			async (id: string) => {
				const session = state.sessions.get(id);
				if (!session) throw new Error("Missing checkout fixture");
				state.sessions.set(id, { ...session, status: "expired", url: null });
				throw new Error("Expiration response interrupted");
			},
		);
		await expect(createSsoCheckout(checkoutInput("gbp"))).rejects.toThrow(
			"Expiration response interrupted",
		);
		expect(state.billing.get(organizationId)).toEqual(previous);
		expect(mocks.stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
		await createSsoCheckout(checkoutInput("gbp"));
		expect(mocks.stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
		expect(state.billing.get(organizationId)?.checkoutCurrency).toBe("gbp");
	});

	it("reuses identical parameters and the same key after an ambiguous response", async () => {
		mocks.stripe.checkout.sessions.create.mockRejectedValueOnce(
			new Error("Connection interrupted"),
		);
		await expect(createSsoCheckout(checkoutInput("gbp"))).rejects.toThrow(
			"Connection interrupted",
		);
		await createSsoCheckout(checkoutInput("eur"));
		expect(mocks.stripe.checkout.sessions.create.mock.calls[1]).toEqual(
			mocks.stripe.checkout.sessions.create.mock.calls[0],
		);
	});

	it("reserves one stable purchase attempt for concurrent clicks", async () => {
		await Promise.all([
			createSsoCheckout(checkoutInput()),
			createSsoCheckout(checkoutInput()),
		]);
		const keys = mocks.stripe.checkout.sessions.create.mock.calls.map(
			(call) => call[1].idempotencyKey,
		);
		expect(new Set(keys).size).toBe(1);
		expect(state.billing.size).toBe(1);
	});

	it("does not reuse an ambiguous key beyond Stripe's retention window", async () => {
		state.billing.set(
			organizationId,
			billingRow({
				checkoutAttemptId: "attempt_old",
				checkoutCurrency: "usd",
				checkoutPriceId: STRIPE_SAML_SSO_PRICE_ID,
				checkoutStartedAt: new Date("2026-08-30T00:00:00Z"),
			}),
		);
		await expect(createSsoCheckout(checkoutInput())).rejects.toThrow(
			"could not be confirmed",
		);
		expect(mocks.stripe.checkout.sessions.create).not.toHaveBeenCalled();
	});

	it("allows a new attempt only after a prior session is confirmed expired", async () => {
		await createSsoCheckout(checkoutInput());
		const first = state.sessions.values().next().value;
		if (!first) throw new Error("Missing checkout fixture");
		state.sessions.set(first.id, { ...first, status: "expired" });
		await createSsoCheckout(checkoutInput());
		const keys = mocks.stripe.checkout.sessions.create.mock.calls.map(
			(call) => call[1].idempotencyKey,
		);
		expect(new Set(keys).size).toBe(2);
	});

	it("allows repurchase after a paid subscription has actually ended", async () => {
		await createSsoCheckout(checkoutInput());
		const first = state.sessions.values().next().value;
		if (!first) throw new Error("Missing checkout fixture");
		state.sessions.set(first.id, {
			...first,
			status: "complete",
			payment_status: "paid",
			subscription: "sub_sso",
		});
		await attachSsoCheckout(first.id, { organizationId, userId });
		mocks.stripe.subscriptions.retrieve.mockResolvedValue(
			ssoSubscription({ status: "canceled" }),
		);
		expect(await createSsoCheckout(checkoutInput())).toBe(
			"https://checkout.stripe.test/sso",
		);
		expect(mocks.stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
		expect(state.billing.get(organizationId)?.checkoutSessionId).not.toBe(
			first.id,
		);
	});

	it("blocks another charge when an external SSO payment needs association", async () => {
		mocks.listSubscriptions.mockResolvedValue([
			ssoSubscription({ metadata: {} }),
		]);
		await expect(createSsoCheckout(checkoutInput())).rejects.toThrow(
			"existing SAML SSO payment",
		);
		expect(mocks.stripe.checkout.sessions.create).not.toHaveBeenCalled();
	});

	it("blocks another purchase while an existing subscription can recover payment", async () => {
		state.billing.set(
			organizationId,
			billingRow({ stripeSubscriptionId: "sub_sso" }),
		);
		mocks.stripe.subscriptions.retrieve.mockResolvedValue(
			ssoSubscription({ status: "unpaid", latest_invoice: null }),
		);
		await expect(createSsoCheckout(checkoutInput())).rejects.toThrow(
			"existing billing",
		);
		expect(mocks.stripe.checkout.sessions.create).not.toHaveBeenCalled();
	});

	it("preserves an ended legacy binding when repurchase would change its billing customer", async () => {
		const existing = billingRow({
			stripeSubscriptionId: "sub_sso",
			status: "canceled",
			stripePriceId: STRIPE_SAML_SSO_LEGACY_PRICE_ID,
		});
		state.billing.set(organizationId, existing);
		state.users.set(userId, { id: userId, stripeCustomerId: "cus_pro" });
		mocks.stripe.subscriptions.retrieve.mockResolvedValue(
			ssoSubscription(
				{ status: "canceled", metadata: {} },
				STRIPE_SAML_SSO_LEGACY_PRICE_ID,
			),
		);
		await expect(
			createSsoCheckout({ ...checkoutInput(), stripeCustomerId: "cus_pro" }),
		).rejects.toThrow("different billing account");
		expect(state.billing.get(organizationId)?.stripeCustomerId).toBe(
			"cus_owner",
		);
		expect(mocks.stripe.checkout.sessions.create).not.toHaveBeenCalled();
	});
});

describe("SSO prices and billing management", () => {
	it("reads USD, GBP, and EUR amounts from the single multi-currency price", async () => {
		expect(await getSsoPrices()).toEqual([
			{ currency: "usd", unitAmount: 20000 },
			{ currency: "gbp", unitAmount: 20000 },
			{ currency: "eur", unitAmount: 20000 },
		]);
		expect(mocks.stripe.prices.retrieve).toHaveBeenCalledWith(
			STRIPE_SAML_SSO_PRICE_ID,
			{ expand: ["currency_options"] },
		);
	});

	it("does not use a live price by default outside production", async () => {
		mocks.environment.NODE_ENV = "development";
		await expect(getSsoPrices()).rejects.toThrow("not configured");
		expect(mocks.stripe.prices.retrieve).not.toHaveBeenCalled();
		mocks.environment.STRIPE_SAML_SSO_PRICE_ID = "price_test_sso";
		await getSsoPrices();
		expect(mocks.stripe.prices.retrieve).toHaveBeenCalledWith(
			"price_test_sso",
			{ expand: ["currency_options"] },
		);
	});

	it("manages the exact linked billing customer without rewriting Pro", async () => {
		state.billing.set(
			organizationId,
			billingRow({ stripeSubscriptionId: "sub_sso" }),
		);
		state.users.set(userId, {
			id: userId,
			stripeCustomerId: "cus_separate_pro",
		});
		expect(await createSsoBillingPortal(organizationId)).toBe(
			"https://billing.stripe.test/sso",
		);
		expect(mocks.stripe.billingPortal.sessions.create).toHaveBeenCalledWith({
			customer: "cus_owner",
			return_url:
				"https://cap.test/dashboard/settings/organization/security?organizationId=org_owner",
		});
	});

	it("does not expose the previous purchaser's portal after ownership changes", async () => {
		state.billing.set(
			organizationId,
			billingRow({
				stripeSubscriptionId: "sub_sso",
				purchasedByUserId: User.UserId.make("user_old_owner"),
			}),
		);
		await expect(createSsoBillingPortal(organizationId)).rejects.toThrow(
			"current owner",
		);
		expect(mocks.stripe.billingPortal.sessions.create).not.toHaveBeenCalled();
	});
});
