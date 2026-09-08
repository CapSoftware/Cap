import { db } from "@cap/database";
import { getWorkOS, normalizeSsoDomain } from "@cap/database/auth/sso";
import { organizations } from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { DomainDataState } from "@workos-inc/node";
import { and, eq, isNull } from "drizzle-orm";

type CapOrganization = typeof organizations.$inferSelect;

export async function getSsoConfiguration(organization: CapOrganization) {
	if (!organization.workosOrganizationId) return null;
	const workos = getWorkOS();
	const [remote, connections] = await Promise.all([
		workos.organizations.getOrganization(organization.workosOrganizationId),
		workos.sso.listConnections({
			organizationId: organization.workosOrganizationId,
			limit: 100,
		}),
	]);
	if (
		remote.id !== organization.workosOrganizationId ||
		connections.data.some(
			(connection) => connection.organizationId !== remote.id,
		)
	) {
		throw new Error("The SSO organization could not be verified.");
	}
	if (connections.listMetadata.after) {
		throw new Error(
			"This organization has too many SSO connections. Please contact Cap support.",
		);
	}
	const active = connections.data.filter(
		(connection) => connection.state === "active",
	);
	const configured = active.find(
		(connection) => connection.id === organization.workosConnectionId,
	);
	return {
		organization: remote,
		requiresConnectionSelection: active.length > 1 && !configured,
		connection:
			configured ??
			(active.length === 1
				? active[0]
				: connections.data.length === 1
					? connections.data[0]
					: null) ??
			null,
	};
}

export async function ensureWorkosOrganization(
	organizationId: Organisation.OrganisationId,
	domainInput?: string,
) {
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
	const workos = getWorkOS();
	if (organization.workosOrganizationId) {
		const remote = await workos.organizations.getOrganization(
			organization.workosOrganizationId,
		);
		if (remote.id !== organization.workosOrganizationId)
			throw new Error("The SSO organization could not be verified.");
		return remote;
	}
	const domain = normalizeSsoDomain(domainInput ?? "");
	if (!domain) throw new Error("Enter your organization's work email domain.");
	let remote: Awaited<ReturnType<typeof workos.organizations.getOrganization>>;
	try {
		remote =
			await workos.organizations.getOrganizationByExternalId(organizationId);
	} catch (error) {
		if (
			!(
				error &&
				typeof error === "object" &&
				"status" in error &&
				error.status === 404
			)
		)
			throw error;
		try {
			remote = await workos.organizations.createOrganization(
				{
					name: organization.name,
					externalId: organization.id,
					domainData: [{ domain, state: DomainDataState.Pending }],
				},
				{ idempotencyKey: `cap-sso-organization:${organization.id}` },
			);
		} catch {
			remote =
				await workos.organizations.getOrganizationByExternalId(organizationId);
		}
	}
	if (remote.externalId !== organizationId)
		throw new Error("The SSO organization could not be verified.");
	await db()
		.update(organizations)
		.set({ workosOrganizationId: remote.id })
		.where(
			and(
				eq(organizations.id, organizationId),
				isNull(organizations.tombstoneAt),
				isNull(organizations.workosOrganizationId),
			),
		);
	const [linked] = await db()
		.select({ workosOrganizationId: organizations.workosOrganizationId })
		.from(organizations)
		.where(
			and(
				eq(organizations.id, organizationId),
				isNull(organizations.tombstoneAt),
			),
		)
		.limit(1);
	if (linked?.workosOrganizationId !== remote.id)
		throw new Error(
			"The SSO organization changed. Please refresh and try again.",
		);
	return remote;
}
