import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	getInvoiceHistory,
	getInvoiceHistoryPage,
} from "@/actions/billing/invoices";

const mocks = vi.hoisted(() => ({
	user: {
		id: "owner",
		email: "owner@example.com",
		emailVerified: new Date(),
		stripeCustomerId: "cus_pro",
	} as {
		id: string;
		email: string;
		emailVerified: Date | null;
		stripeCustomerId: string | null;
	} | null,
	isCap: true,
	licenses: vi.fn(),
	documents: vi.fn(),
	sso: vi.fn(),
	rows: {} as Record<string, Record<string, unknown>[]>,
}));
type Condition =
	| { column: string; value: unknown }
	| { conditions: Condition[] }
	| { column: string; values: unknown[] }
	| { notNull: string };
function matches(row: Record<string, unknown>, condition: Condition): boolean {
	if ("conditions" in condition)
		return condition.conditions.every((entry) => matches(row, entry));
	if ("notNull" in condition) return row[condition.notNull] != null;
	if ("values" in condition)
		return condition.values.includes(row[condition.column]);
	return row[condition.column] === condition.value;
}
vi.mock("@cap/database", () => ({
	db: () => ({
		select: (fields: Record<string, string>) => ({
			from: (table: { _table: string }) => {
				const query = {
					innerJoin: () => query,
					where: (condition: Condition) =>
						Promise.resolve(
							(mocks.rows[table._table] ?? [])
								.filter((row) => matches(row, condition))
								.map((row) =>
									Object.fromEntries(
										Object.entries(fields).map(([key, column]) => [
											key,
											row[column],
										]),
									),
								),
						),
				};
				return query;
			},
		}),
	}),
}));
vi.mock("@cap/database/schema", () => {
	const table = (name: string, columns: string[]) => ({
		_table: name,
		...Object.fromEntries(
			columns.map((column) => [column, `${name}.${column}`]),
		),
	});
	return {
		accounts: table("accounts", [
			"userId",
			"provider",
			"providerAccountId",
			"id_token",
		]),
		users: table("users", ["id", "stripeCustomerId"]),
		organizations: table("organizations", [
			"id",
			"ownerId",
			"name",
			"tombstoneAt",
		]),
		organizationSso: table("sso", ["organizationId", "stripeSubscriptionId"]),
		developerCreditAccounts: table("credits", ["ownerId", "stripeCustomerId"]),
	};
});
vi.mock("drizzle-orm", () => ({
	eq: (column: string, value: unknown) => ({ column, value }),
	and: (...conditions: Condition[]) => ({ conditions }),
	isNull: (column: string) => ({ column, value: null }),
	isNotNull: (notNull: string) => ({ notNull }),
	inArray: (column: string, values: unknown[]) => ({ column, values }),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => mocks.user,
}));
vi.mock("@cap/database/billing/license-customers", () => ({
	getLicenseCustomerIds: mocks.licenses,
}));
vi.mock("@cap/env", () => ({
	buildEnv: {
		get NEXT_PUBLIC_IS_CAP() {
			return mocks.isCap;
		},
	},
}));
vi.mock("@/lib/billing/invoices", () => ({
	listCustomerDocuments: mocks.documents,
}));
vi.mock("@/lib/sso/billing", () => ({ listSsoInvoices: mocks.sso }));

const sourceId = (key: string, user = "owner") =>
	createHash("sha256").update(`${user}:${key}`).digest("hex");
beforeEach(() => {
	mocks.user = {
		id: "owner",
		email: "owner@example.com",
		emailVerified: new Date(),
		stripeCustomerId: "cus_pro",
	};
	mocks.isCap = true;
	mocks.licenses.mockReset().mockResolvedValue(["cus_license", "cus_pro"]);
	mocks.documents.mockReset().mockResolvedValue({ documents: [], next: null });
	mocks.sso.mockReset().mockResolvedValue({ invoices: [], hasMore: false });
	mocks.rows = {
		organizations: [
			{
				"organizations.id": "org_owner",
				"organizations.ownerId": "owner",
				"organizations.name": "Example",
				"organizations.tombstoneAt": null,
				"sso.stripeSubscriptionId": "sub_sso",
			},
			{
				"organizations.id": "org_other",
				"organizations.ownerId": "other",
				"organizations.name": "Other",
				"organizations.tombstoneAt": null,
				"sso.stripeSubscriptionId": "sub_other",
			},
		],
		credits: [
			{ "credits.ownerId": "owner", "credits.stripeCustomerId": "cus_credits" },
		],
	};
});
describe("invoice authorization", () => {
	it("combines owned sources, deduplicates customers and limits SSO to owned organizations", async () => {
		const result = await getInvoiceHistory();
		expect(result.sections).toHaveLength(4);
		expect(mocks.documents.mock.calls.map(([id]) => id)).toEqual([
			"cus_pro",
			"cus_credits",
			"cus_license",
		]);
		expect(mocks.sso).toHaveBeenCalledExactlyOnceWith("org_owner", {
			limit: 25,
			ownerId: "owner",
			startingAfter: undefined,
		});
		expect(mocks.licenses).toHaveBeenCalledWith("owner@example.com");
		expect(JSON.stringify(result)).not.toContain("cus_");
	});
	it.each(["signed-out", "self-hosted"])(
		"rejects %s requests before any billing reads",
		async (mode) => {
			if (mode === "signed-out") mocks.user = null;
			else mocks.isCap = false;
			await expect(getInvoiceHistory()).rejects.toThrow("Unauthorized");
			expect(mocks.licenses).not.toHaveBeenCalled();
			expect(mocks.documents).not.toHaveBeenCalled();
		},
	);
	it("requires verified email before looking up desktop purchases", async () => {
		if (mocks.user) mocks.user.emailVerified = null;
		const result = await getInvoiceHistory();
		expect(result.warnings[0]).toContain("verification code");
		expect(mocks.licenses).not.toHaveBeenCalled();
		expect(mocks.documents).not.toHaveBeenCalledWith(
			"cus_license",
			expect.anything(),
			expect.anything(),
		);
	});

	it("accepts the verified email of a persisted Google account", async () => {
		if (mocks.user) mocks.user.emailVerified = null;
		mocks.rows.accounts = [
			{
				"accounts.userId": "owner",
				"accounts.provider": "google",
				"accounts.providerAccountId": "subject",
				"accounts.id_token": `header.${Buffer.from(JSON.stringify({ iss: "https://accounts.google.com", sub: "subject", email: "owner@example.com", email_verified: true })).toString("base64url")}.signature`,
			},
		];
		const result = await getInvoiceHistory();
		expect(result.warnings).toEqual([]);
		expect(mocks.licenses).toHaveBeenCalledWith("owner@example.com");
	});
	it("excludes a license customer assigned to a different Cap user", async () => {
		mocks.rows.users = [
			{ "users.id": "other", "users.stripeCustomerId": "cus_license" },
		];
		await getInvoiceHistory();
		expect(mocks.documents.mock.calls.map(([id]) => id)).not.toContain(
			"cus_license",
		);
	});
	it("reauthorizes pagination after an organization transfer", async () => {
		await getInvoiceHistory();
		mocks.sso.mockClear();
		mocks.rows.organizations = [];
		await expect(
			getInvoiceHistoryPage(sourceId("sso:org_owner"), {
				invoices: "in_last",
				receipts: null,
			}),
		).rejects.toThrow("no longer available");
		expect(mocks.sso).not.toHaveBeenCalled();
	});
	it("rejects a source identifier from a different signed-in user", async () => {
		if (mocks.user) mocks.user.id = "other";
		await expect(getInvoiceHistoryPage(sourceId("cus_pro"))).rejects.toThrow(
			"no longer available",
		);
		expect(mocks.documents).not.toHaveBeenCalled();
	});
	it("rejects malformed pagination before reading provider data", async () => {
		await expect(
			getInvoiceHistoryPage(sourceId("cus_pro"), {
				invoices: "https://evil.test",
				receipts: null,
			}),
		).rejects.toThrow();
		expect(mocks.documents).not.toHaveBeenCalled();
	});
	it("keeps a failed provider section visible and recovers other purchases", async () => {
		mocks.licenses.mockRejectedValue(new Error("Unavailable"));
		mocks.documents.mockRejectedValueOnce(new Error("Unavailable"));
		const result = await getInvoiceHistory();
		expect(result.warnings).toHaveLength(1);
		expect(result.sections[0]?.page).toBeNull();
		expect(result.sections[1]?.page).not.toBeNull();
	});
	it("passes SSO pagination to the subscription-scoped reader", async () => {
		await getInvoiceHistoryPage(sourceId("sso:org_owner"), {
			invoices: "in_last",
			receipts: null,
		});
		expect(mocks.sso).toHaveBeenCalledWith("org_owner", {
			startingAfter: "in_last",
			limit: 25,
			ownerId: "owner",
		});
	});
});
