import { isSsoSubscription, stripe } from "@cap/utils";
import type Stripe from "stripe";

export type BillingDocument = {
	id: string;
	number: string | null;
	description: string;
	created: number;
	total: number;
	currency: string;
	status: string;
	url: string | null;
	kind: "invoice" | "receipt";
};

export type InvoiceCursor = {
	invoices: string | null;
	receipts: string | null;
};

export type InvoicePage = {
	documents: BillingDocument[];
	next: InvoiceCursor | null;
};

export function stripeDocumentUrl(value: string | null | undefined) {
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" &&
			["invoice.stripe.com", "pay.stripe.com", "pay.cap.so"].includes(
				url.hostname,
			) &&
			!url.username &&
			!url.password &&
			!url.port
			? url.toString()
			: null;
	} catch {
		return null;
	}
}

function stripeId(value: string | { id: string } | null) {
	return typeof value === "string" ? value : value?.id;
}

export function invoiceDocument(invoice: Stripe.Invoice): BillingDocument {
	return {
		id: invoice.id,
		number: invoice.number,
		description:
			invoice.description ||
			invoice.lines.data
				.map((line) => line.description)
				.filter(Boolean)
				.join(", ")
				.slice(0, 200) ||
			"Cap purchase",
		created: invoice.created,
		total: invoice.total,
		currency: invoice.currency,
		status: invoice.status ?? "unknown",
		url: stripeDocumentUrl(invoice.invoice_pdf),
		kind: "invoice",
	};
}

export async function listCustomerDocuments(
	customerId: string,
	userId: string,
	cursor?: InvoiceCursor,
): Promise<InvoicePage> {
	const client = stripe();
	const customer = await client.customers.retrieve(customerId);
	if (
		customer.id !== customerId ||
		customer.deleted ||
		(customer.metadata.userId && customer.metadata.userId !== userId)
	) {
		throw new Error("Billing account ownership could not be verified.");
	}
	const [invoices, charges] = await Promise.all([
		cursor?.invoices === null
			? null
			: client.invoices.list({
					customer: customerId,
					limit: 25,
					...(cursor?.invoices ? { starting_after: cursor.invoices } : {}),
				}),
		cursor?.receipts === null
			? null
			: client.charges.list({
					customer: customerId,
					limit: 25,
					...(cursor?.receipts ? { starting_after: cursor.receipts } : {}),
				}),
	]);
	if (
		[...(invoices?.data ?? []), ...(charges?.data ?? [])].some(
			(document) => stripeId(document.customer) !== customerId,
		)
	) {
		throw new Error("Billing documents do not match the billing account.");
	}
	const documents = (invoices?.data ?? [])
		.filter(
			(invoice) =>
				invoice.status !== "draft" &&
				!isSsoSubscription({
					metadata: invoice.subscription_details?.metadata,
					items: { data: invoice.lines.data },
				}),
		)
		.map(invoiceDocument);
	for (const charge of charges?.data ?? []) {
		if (charge.invoice || !charge.paid || charge.status !== "succeeded")
			continue;
		documents.push({
			id: charge.id,
			number: charge.receipt_number,
			description: charge.description || "Cap purchase",
			created: charge.created,
			total: charge.amount,
			currency: charge.currency,
			status: charge.refunded
				? "refunded"
				: charge.amount_refunded > 0
					? "partially refunded"
					: "paid",
			url: stripeDocumentUrl(charge.receipt_url),
			kind: "receipt",
		});
	}
	documents.sort((a, b) => b.created - a.created || a.id.localeCompare(b.id));
	return {
		documents,
		next:
			invoices?.has_more || charges?.has_more
				? {
						invoices: invoices?.has_more
							? (invoices.data.at(-1)?.id ?? null)
							: null,
						receipts: charges?.has_more
							? (charges.data.at(-1)?.id ?? null)
							: null,
					}
				: null,
	};
}
