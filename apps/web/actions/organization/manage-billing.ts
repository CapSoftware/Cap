"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations, users } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { stripe } from "@cap/utils";
import type { Organisation } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";
import type Stripe from "stripe";

export async function manageBilling(
	organizationId?: Organisation.OrganisationId,
) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	const targetOrgId = organizationId || user.activeOrganizationId;

	let customerId: string | null = null;

	if (targetOrgId) {
		const [org] = await db()
			.select({
				stripeCustomerId: organizations.stripeCustomerId,
			})
			.from(organizations)
			.where(eq(organizations.id, targetOrgId));

		if (org?.stripeCustomerId) {
			customerId = org.stripeCustomerId;
		}
	}

	if (!customerId) {
		customerId = user.stripeCustomerId || null;
	}

	if (!customerId) {
		const existingCustomers = await stripe().customers.list({
			email: user.email,
			limit: 1,
		});

		let customer: Stripe.Customer;
		if (existingCustomers.data.length > 0 && existingCustomers.data[0]) {
			customer = existingCustomers.data[0];

			customer = await stripe().customers.update(customer.id, {
				metadata: {
					...customer.metadata,
					userId: user.id,
				},
			});
		} else {
			customer = await stripe().customers.create({
				email: user.email,
				metadata: {
					userId: user.id,
				},
			});
		}

		await db()
			.update(users)
			.set({
				stripeCustomerId: customer.id,
			})
			.where(eq(users.id, user.id));

		if (targetOrgId) {
			await db()
				.update(organizations)
				.set({
					stripeCustomerId: customer.id,
				})
				.where(eq(organizations.id, targetOrgId));
		}

		customerId = customer.id;
	}

	const { url } = await stripe().billingPortal.sessions.create({
		customer: customerId,
		return_url: `${serverEnv().WEB_URL}/dashboard/settings/organization`,
	});

	return url;
}
