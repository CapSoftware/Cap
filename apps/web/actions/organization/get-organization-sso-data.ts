"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import {
	getRegisteredSsoOrganization,
	getSsoEmailDomain,
	getWorkOS,
	normalizeSsoDomain,
} from "@cap/database/auth/sso";
import {
	createSsoLoginIntent,
	ssoIntentCookie,
} from "@cap/database/auth/sso-state";
import { organizations } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { hasSsoAccess } from "@cap/utils";
import { Organisation } from "@cap/web-domain";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { cookies } from "next/headers";
import { getSafeNextPath } from "@/app/(org)/safe-next";
import { isRateLimited } from "@/lib/rate-limit";
import { getSsoBilling, syncSsoSubscription } from "@/lib/sso/billing";
import { getSsoConfiguration } from "@/lib/sso/workos";

export async function getOrganizationSSOData(
	identifier: string,
	connectionId?: string,
	returnTo?: string,
) {
	if (
		typeof identifier !== "string" ||
		identifier.length > 255 ||
		(connectionId !== undefined &&
			(typeof connectionId !== "string" ||
				!/^conn_[a-zA-Z0-9]{1,100}$/.test(connectionId)))
	) {
		throw new Error("Enter a valid work email or organization domain.");
	}
	if (await isRateLimited("rl_auth_sso_start"))
		throw new Error("Too many SSO attempts. Please try again shortly.");
	const workos = getWorkOS();
	const value = identifier.trim().toLowerCase();
	let organizationId: Organisation.OrganisationId;
	if (connectionId) {
		const connection = await workos.sso.getConnection(connectionId);
		if (connection.state !== "active" || !connection.organizationId)
			throw new Error("SSO is not configured for this organization.");
		const [organization] = await db()
			.select({ id: organizations.id })
			.from(organizations)
			.where(
				and(
					eq(organizations.workosOrganizationId, connection.organizationId),
					isNull(organizations.tombstoneAt),
				),
			)
			.limit(1);
		if (!organization)
			throw new Error("SSO is not configured for this organization.");
		organizationId = organization.id;
	} else if (/^[a-z0-9]{15}$/.test(value)) {
		organizationId = Organisation.OrganisationId.make(value);
	} else {
		const domain = value.includes("@")
			? getSsoEmailDomain(value)
			: normalizeSsoDomain(value);
		if (!domain)
			throw new Error("Enter a valid work email or organization domain.");
		const remote = await workos.organizations.listOrganizations({
			domains: [domain],
			limit: 100,
		});
		const verified = remote.data.filter((organization) =>
			organization.domains.some(
				(entry) =>
					entry.state === "verified" &&
					normalizeSsoDomain(entry.domain) === domain,
			),
		);
		if (verified.length === 0 || remote.listMetadata.after)
			throw new Error("SSO is not configured for this organization.");
		const matches = await db()
			.select({ id: organizations.id })
			.from(organizations)
			.where(
				and(
					inArray(
						organizations.workosOrganizationId,
						verified.map((organization) => organization.id),
					),
					isNull(organizations.tombstoneAt),
				),
			)
			.limit(2);
		if (matches.length !== 1 || !matches[0])
			throw new Error(
				"Use the SSO sign-in link provided by your administrator.",
			);
		organizationId = matches[0].id;
	}
	const existingBilling = await getSsoBilling(organizationId);
	const billing = existingBilling?.stripeSubscriptionId
		? await syncSsoSubscription(existingBilling.stripeSubscriptionId)
		: null;
	if (!hasSsoAccess(billing))
		throw new Error(
			"SSO is not available for this organization. Contact your administrator.",
		);
	const organization = await getRegisteredSsoOrganization(organizationId);
	const configuration = await getSsoConfiguration(organization);
	const connection = connectionId
		? await workos.sso.getConnection(connectionId)
		: configuration?.connection;
	if (
		!configuration ||
		!connection ||
		connection.state !== "active" ||
		connection.organizationId !== organization.workosOrganizationId ||
		!configuration.organization.domains.some(
			(domain) => domain.state === "verified",
		)
	) {
		throw new Error("SSO setup is not complete. Contact your administrator.");
	}
	const user = await getCurrentUser();
	const env = serverEnv();
	const cookie = ssoIntentCookie(new URL(env.WEB_URL).protocol === "https:");
	(await cookies()).set(
		cookie.name,
		createSsoLoginIntent(
			{
				organizationId,
				workosOrganizationId: configuration.organization.id,
				connectionId: connection.id,
				actorId: user?.id ?? null,
				returnTo: getSafeNextPath(
					typeof returnTo === "string" ? returnTo : undefined,
					env.WEB_URL,
				),
			},
			env.NEXTAUTH_SECRET,
		),
		cookie.options,
	);
	return {
		organizationId: configuration.organization.id,
		connectionId: connection.id,
		name: organization.name,
	};
}
