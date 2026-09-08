"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { getSsoEmailDomain, getWorkOS } from "@cap/database/auth/sso";
import { organizations } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { hasSsoAccess } from "@cap/utils";
import type { Organisation } from "@cap/web-domain";
import { GeneratePortalLinkIntent } from "@workos-inc/node";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
	attachSsoCheckout,
	createSsoBillingPortal,
	createSsoCheckout,
	getSsoBilling,
	getSsoPrices,
	syncSsoSubscription,
} from "@/lib/sso/billing";
import {
	ensureWorkosOrganization,
	getSsoConfiguration,
} from "@/lib/sso/workos";
import { isSupportedCurrency } from "@/utils/currency";
import {
	requireOrganizationOwner,
	requireOrganizationSettingsManager,
} from "./authorization";

const settingsPath = "/dashboard/settings/organization/security";

export type OrganizationSsoSettings = {
	organizationId: Organisation.OrganisationId;
	organizationName: string;
	canManageBilling: boolean;
	ssoAvailable: boolean;
	entitled: boolean;
	hasSubscription: boolean;
	subscriptionStatus: string | null;
	cancelAtPeriodEnd: boolean;
	currentPeriodEnd: string | null;
	suggestedDomain: string;
	prices: Array<{ currency: "usd" | "gbp" | "eur"; unitAmount: number }>;
	domains: Array<{ domain: string; state: string }>;
	connection: { name: string; state: string } | null;
	connectionIssue?: string;
	signInUrl: string | null;
};

async function requireSsoManager(organizationId: Organisation.OrganisationId) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	const access = await requireOrganizationSettingsManager(
		user.id,
		organizationId,
	);
	const [organization] = await db()
		.select()
		.from(organizations)
		.where(
			and(
				eq(organizations.id, organizationId),
				isNull(organizations.tombstoneAt),
			),
		)
		.limit(1);
	if (!organization) throw new Error("Organization not found.");
	return { user, access, organization };
}

async function requireSsoOwner(organizationId: Organisation.OrganisationId) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	await requireOrganizationOwner(user.id, organizationId);
	return user;
}

async function refreshSsoBilling(organizationId: Organisation.OrganisationId) {
	const billing = await getSsoBilling(organizationId);
	if (!billing?.stripeSubscriptionId) return billing;
	return syncSsoSubscription(billing.stripeSubscriptionId);
}

export async function getOrganizationSsoSettings(
	organizationId: Organisation.OrganisationId,
): Promise<OrganizationSsoSettings> {
	const { user, access, organization } =
		await requireSsoManager(organizationId);
	const env = serverEnv();
	const ssoAvailable = Boolean(env.WORKOS_API_KEY && env.WORKOS_CLIENT_ID);
	const [billing, prices, configuration] = await Promise.all([
		refreshSsoBilling(organizationId),
		getSsoPrices(organizationId).catch(() => []),
		ssoAvailable ? getSsoConfiguration(organization) : null,
	]);
	const entitled = hasSsoAccess(billing);
	const connection = configuration?.connection;
	const signInUrl = new URL("/login", env.WEB_URL);
	signInUrl.searchParams.set("organizationId", organizationId);
	return {
		organizationId,
		organizationName: organization.name,
		canManageBilling: access.role === "owner",
		ssoAvailable,
		entitled,
		hasSubscription: Boolean(billing?.stripeSubscriptionId),
		subscriptionStatus: billing?.status ?? null,
		cancelAtPeriodEnd: billing?.cancelAtPeriodEnd ?? false,
		currentPeriodEnd: billing?.currentPeriodEnd?.toISOString() ?? null,
		suggestedDomain:
			configuration?.organization.domains[0]?.domain ??
			getSsoEmailDomain(user.email) ??
			"",
		prices,
		domains:
			configuration?.organization.domains.map(({ domain, state }) => ({
				domain,
				state,
			})) ?? [],
		connection: connection
			? { name: connection.name, state: connection.state }
			: null,
		connectionIssue: configuration?.requiresConnectionSelection
			? "Multiple SSO connections are active. Open Manage SSO to keep one active connection, or contact Cap support to select the default connection."
			: undefined,
		signInUrl:
			entitled &&
			connection?.state === "active" &&
			configuration?.organization.domains.some(
				(domain) => domain.state === "verified",
			)
				? signInUrl.toString()
				: null,
	};
}

export async function startOrganizationSsoCheckout(
	organizationId: Organisation.OrganisationId,
	currency: string,
) {
	const user = await requireSsoOwner(organizationId);
	if (!isSupportedCurrency(currency))
		throw new Error("Unsupported billing currency.");
	getWorkOS();
	const url = await createSsoCheckout({
		organizationId,
		purchasedByUserId: user.id,
		stripeCustomerId: user.stripeCustomerId,
		currency,
	});
	return { url };
}

export async function openOrganizationSsoPortal(
	organizationId: Organisation.OrganisationId,
	domain?: string,
	purpose: "sso" | "domain_verification" = "sso",
) {
	await requireSsoManager(organizationId);
	if (purpose !== "sso" && purpose !== "domain_verification")
		throw new Error("Invalid setup request.");
	const billing = await refreshSsoBilling(organizationId);
	if (!hasSsoAccess(billing))
		throw new Error("An active SAML SSO add-on is required.");
	const organization = await ensureWorkosOrganization(organizationId, domain);
	const returnUrl = new URL(settingsPath, serverEnv().WEB_URL);
	returnUrl.searchParams.set("organizationId", organizationId);
	const successUrl = new URL(returnUrl);
	successUrl.searchParams.set("sso_setup", "complete");
	const result = await getWorkOS().portal.generateLink({
		organization: organization.id,
		intent:
			purpose === "domain_verification" ||
			!organization.domains.some((entry) => entry.state === "verified")
				? GeneratePortalLinkIntent.DomainVerification
				: GeneratePortalLinkIntent.SSO,
		returnUrl: returnUrl.toString(),
		successUrl: successUrl.toString(),
	});
	revalidatePath(settingsPath);
	return { url: result.link };
}

export async function confirmOrganizationSsoCheckout(
	organizationId: Organisation.OrganisationId,
	sessionId: string,
) {
	const user = await requireSsoOwner(organizationId);
	if (!/^cs_[a-zA-Z0-9_]+$/.test(sessionId) || sessionId.length > 255)
		throw new Error("Invalid checkout session.");
	const billing = await attachSsoCheckout(sessionId, {
		organizationId,
		userId: user.id,
	});
	if (!hasSsoAccess(billing))
		throw new Error(
			"Your SSO payment is still processing. Please refresh in a moment.",
		);
	revalidatePath(settingsPath);
	return getOrganizationSsoSettings(organizationId);
}

export async function manageOrganizationSsoBilling(
	organizationId: Organisation.OrganisationId,
) {
	await requireSsoOwner(organizationId);
	return { url: await createSsoBillingPortal(organizationId) };
}
