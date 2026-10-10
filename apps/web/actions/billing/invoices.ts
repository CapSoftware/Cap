"use server";

import { createHash } from "node:crypto";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { getLicenseCustomerIds } from "@cap/database/billing/license-customers";
import {
	accounts,
	developerCreditAccounts,
	organizationSso,
	organizations,
	users,
} from "@cap/database/schema";
import { buildEnv } from "@cap/env";
import type { Organisation } from "@cap/web-domain";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import {
	type InvoiceCursor,
	type InvoicePage,
	listCustomerDocuments,
} from "@/lib/billing/invoices";
import { allowInvoiceRequest } from "@/lib/billing/request-limit";
import { hasVerifiedProviderEmail } from "@/lib/billing/verified-email";
import { listSsoInvoices } from "@/lib/sso/billing";

type BillingUser = NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>;
type InvoiceSource = {
	id: string;
	title: string;
} & (
	| { kind: "customer"; customerId: string }
	| { kind: "sso"; organizationId: Organisation.OrganisationId }
);

export type InvoiceSection = {
	id: string;
	title: string;
	page: InvoicePage | null;
};

const cursorSchema = z
	.object({
		invoices: z
			.string()
			.regex(/^in_[a-zA-Z0-9_]+$/)
			.max(255)
			.nullable(),
		receipts: z
			.string()
			.regex(/^ch_[a-zA-Z0-9_]+$/)
			.max(255)
			.nullable(),
	})
	.strict();

async function requireBillingUser() {
	const user = await getCurrentUser();
	if (!user || !buildEnv.NEXT_PUBLIC_IS_CAP) throw new Error("Unauthorized");
	if (!allowInvoiceRequest(user.id))
		throw new Error("Too many invoice requests. Try again in a minute.");
	return user;
}

function sourceId(user: BillingUser, key: string) {
	return createHash("sha256").update(`${user.id}:${key}`).digest("hex");
}

async function invoiceSources(user: BillingUser) {
	const warnings: string[] = [];
	const canReadLicenseEmail =
		user.emailVerified ||
		(
			await db()
				.select({
					provider: accounts.provider,
					providerAccountId: accounts.providerAccountId,
					idToken: accounts.id_token,
				})
				.from(accounts)
				.where(
					and(
						eq(accounts.userId, user.id),
						inArray(accounts.provider, ["google", "apple"]),
					),
				)
		).some((account) => hasVerifiedProviderEmail(user.email, account));
	const [licenseIds, sso, credits] = await Promise.all([
		canReadLicenseEmail
			? getLicenseCustomerIds(user.email).catch(() => {
					warnings.push(
						"Desktop and self-hosted license invoices couldn’t be loaded. Please try again.",
					);
					return [];
				})
			: Promise.resolve([]),
		db()
			.select({
				organizationId: organizations.id,
				name: organizations.name,
			})
			.from(organizations)
			.innerJoin(
				organizationSso,
				eq(organizationSso.organizationId, organizations.id),
			)
			.where(
				and(
					eq(organizations.ownerId, user.id),
					isNull(organizations.tombstoneAt),
					isNotNull(organizationSso.stripeSubscriptionId),
				),
			),
		db()
			.select({ customerId: developerCreditAccounts.stripeCustomerId })
			.from(developerCreditAccounts)
			.where(eq(developerCreditAccounts.ownerId, user.id)),
	]);
	if (!canReadLicenseEmail) {
		warnings.push(
			"To see desktop and self-hosted license invoices, sign in using the email verification code sent to your purchase email.",
		);
	}
	const sources: InvoiceSource[] = [];
	const customers = new Map<string, string>();
	if (user.stripeCustomerId)
		customers.set(user.stripeCustomerId, "Account purchases");
	for (const row of credits) {
		if (row.customerId && !customers.has(row.customerId)) {
			customers.set(row.customerId, "Developer credits");
		}
	}
	const claimedCustomers = licenseIds.length
		? await db()
				.select({ userId: users.id, customerId: users.stripeCustomerId })
				.from(users)
				.where(inArray(users.stripeCustomerId, licenseIds))
		: [];
	for (const id of licenseIds) {
		if (
			claimedCustomers.some(
				(row) => row.customerId === id && row.userId !== user.id,
			)
		)
			continue;
		if (!customers.has(id))
			customers.set(id, "Desktop and self-hosted licenses");
	}
	for (const [customerId, title] of customers) {
		sources.push({
			id: sourceId(user, customerId),
			title,
			kind: "customer",
			customerId,
		});
	}
	for (const organization of sso) {
		sources.push({
			id: sourceId(user, `sso:${organization.organizationId}`),
			title: `${organization.name} · SSO`,
			kind: "sso",
			organizationId: organization.organizationId,
		});
	}
	return { sources, warnings };
}

async function sourcePage(
	user: BillingUser,
	source: InvoiceSource,
	cursor?: InvoiceCursor,
): Promise<InvoicePage> {
	if (source.kind === "customer") {
		return listCustomerDocuments(source.customerId, user.id, cursor);
	}
	if (cursor?.invoices === null) return { documents: [], next: null };
	const result = await listSsoInvoices(source.organizationId, {
		limit: 25,
		ownerId: user.id,
		startingAfter: cursor?.invoices ?? undefined,
	});
	return {
		documents: result.invoices
			.filter((invoice) => invoice.status !== "draft")
			.map((invoice) => ({
				id: invoice.id,
				number: invoice.number,
				description: "SAML SSO",
				created: invoice.created,
				total: invoice.total,
				currency: invoice.currency,
				status: invoice.status ?? "unknown",
				url: invoice.pdfUrl,
				kind: "invoice",
			})),
		next: result.hasMore
			? { invoices: result.invoices.at(-1)?.id ?? null, receipts: null }
			: null,
	};
}

export async function getInvoiceHistory() {
	const user = await requireBillingUser();
	const { sources, warnings } = await invoiceSources(user);
	const sections: InvoiceSection[] = [];
	for (let i = 0; i < sources.length; i += 4) {
		sections.push(
			...(await Promise.all(
				sources.slice(i, i + 4).map(async (source) => ({
					id: source.id,
					title: source.title,
					page: await sourcePage(user, source).catch(() => null),
				})),
			)),
		);
	}
	return { sections, warnings };
}

export async function getInvoiceHistoryPage(
	id: string,
	cursor?: InvoiceCursor,
) {
	if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
		throw new Error("Invalid invoice history.");
	const parsedCursor =
		cursor === undefined ? undefined : cursorSchema.parse(cursor);
	const user = await requireBillingUser();
	const { sources } = await invoiceSources(user);
	const source = sources.find((entry) => entry.id === id);
	if (!source)
		throw new Error(
			"Invoice history is no longer available. Refresh the page.",
		);
	return sourcePage(user, source, parsedCursor);
}
