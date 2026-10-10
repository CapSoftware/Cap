import type Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	listCustomerDocuments,
	stripeDocumentUrl,
} from "@/lib/billing/invoices";

const mocks = vi.hoisted(() => ({
	customers: { retrieve: vi.fn() },
	invoices: { list: vi.fn() },
	charges: { list: vi.fn() },
}));
vi.mock("@cap/utils", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cap/utils")>()),
	stripe: () => mocks,
}));

const invoice = (overrides: Partial<Stripe.Invoice> = {}) => ({
	id: "in_pro",
	customer: "cus_owner",
	number: "CAP-001",
	description: "Cap Pro",
	created: 100,
	total: 1000,
	currency: "usd",
	status: "paid",
	invoice_pdf: "https://pay.stripe.com/invoice/example/pdf",
	lines: { data: [] },
	...overrides,
});
const charge = (overrides: Partial<Stripe.Charge> = {}) => ({
	id: "ch_license",
	customer: "cus_owner",
	invoice: null,
	paid: true,
	status: "succeeded",
	created: 200,
	amount: 2900,
	amount_refunded: 0,
	refunded: false,
	currency: "usd",
	receipt_number: null,
	description: "Desktop license",
	receipt_url: "https://pay.stripe.com/receipts/example",
	...overrides,
});

beforeEach(() => {
	mocks.customers.retrieve.mockResolvedValue({
		id: "cus_owner",
		metadata: { userId: "owner" },
	});
	mocks.invoices.list.mockResolvedValue({ data: [invoice()], has_more: false });
	mocks.charges.list.mockResolvedValue({ data: [charge()], has_more: false });
});

describe("invoice documents", () => {
	it("combines invoices and historical receipts without duplicating invoiced charges", async () => {
		mocks.charges.list.mockResolvedValue({
			data: [
				charge(),
				charge({ id: "ch_invoiced", invoice: "in_pro" }),
				charge({ id: "ch_failed", paid: false }),
			],
			has_more: false,
		});
		const result = await listCustomerDocuments("cus_owner", "owner");
		expect(
			result.documents.map((document) => [document.id, document.kind]),
		).toEqual([
			["ch_license", "receipt"],
			["in_pro", "invoice"],
		]);
		expect(result.next).toBeNull();
		expect(mocks.invoices.list).toHaveBeenCalledWith({
			customer: "cus_owner",
			limit: 25,
		});
	});
	it("omits drafts and SSO invoices from account-wide history", async () => {
		mocks.invoices.list.mockResolvedValue({
			data: [
				invoice({ status: "draft" }),
				invoice({
					id: "in_sso",
					subscription_details: { metadata: { type: "saml_sso" } },
				}),
			],
			has_more: false,
		});
		mocks.charges.list.mockResolvedValue({ data: [], has_more: false });
		expect(
			(await listCustomerDocuments("cus_owner", "owner")).documents,
		).toEqual([]);
	});
	it.each([
		{ id: "cus_owner", deleted: true },
		{ id: "cus_owner", metadata: { userId: "other" } },
		{ id: "cus_other", metadata: {} },
	])(
		"fails closed for unavailable or reassigned billing customers",
		async (customer) => {
			mocks.customers.retrieve.mockResolvedValue(customer);
			await expect(listCustomerDocuments("cus_owner", "owner")).rejects.toThrow(
				"ownership",
			);
			expect(mocks.invoices.list).not.toHaveBeenCalled();
			expect(mocks.charges.list).not.toHaveBeenCalled();
		},
	);
	it("rejects a provider response containing another customer's document", async () => {
		mocks.charges.list.mockResolvedValue({
			data: [charge({ customer: "cus_other" })],
			has_more: false,
		});
		await expect(listCustomerDocuments("cus_owner", "owner")).rejects.toThrow(
			"do not match",
		);
	});
	it("advances past filtered records and does not restart exhausted invoice streams", async () => {
		mocks.invoices.list.mockResolvedValue({
			data: [invoice({ status: "draft" })],
			has_more: true,
		});
		const first = await listCustomerDocuments("cus_owner", "owner");
		expect(first.next).toEqual({ invoices: "in_pro", receipts: null });
		await listCustomerDocuments("cus_owner", "owner", first.next ?? undefined);
		expect(mocks.charges.list).toHaveBeenCalledTimes(1);
		expect(mocks.invoices.list).toHaveBeenLastCalledWith({
			customer: "cus_owner",
			limit: 25,
			starting_after: "in_pro",
		});
	});
	it("reports partial refunds and keeps documents with no downloadable PDF", async () => {
		mocks.invoices.list.mockResolvedValue({
			data: [invoice({ invoice_pdf: null })],
			has_more: false,
		});
		mocks.charges.list.mockResolvedValue({
			data: [charge({ amount_refunded: 100 })],
			has_more: false,
		});
		const result = await listCustomerDocuments("cus_owner", "owner");
		expect(result.documents[0]?.status).toBe("partially refunded");
		expect(result.documents[1]?.url).toBeNull();
	});
	it.each([
		"javascript:alert(1)",
		"http://pay.stripe.com/x",
		"https://pay.stripe.com.evil.test/x",
		"https://user@pay.stripe.com/x",
		"https://pay.stripe.com:8443/x",
		"not a URL",
	])("rejects an untrusted document URL: %s", (url) => {
		expect(stripeDocumentUrl(url)).toBeNull();
	});
});
