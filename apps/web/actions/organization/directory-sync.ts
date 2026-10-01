"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { getWorkOS } from "@cap/database/auth/sso";
import { directorySyncEntitled } from "@cap/database/directory-sync/worker";
import {
	directoryUsers,
	organizationDirectorySync,
	organizations,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Organisation } from "@cap/web-domain";
import { GeneratePortalLinkIntent } from "@workos-inc/node";
import { and, count, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireOrganizationSettingsManager } from "./authorization";

const settingsPath = "/dashboard/settings/organization/security";

async function requireManager(organizationId: Organisation.OrganisationId) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	await requireOrganizationSettingsManager(user.id, organizationId);
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
	return organization;
}

export type DirectorySyncSettings = {
	organizationId: Organisation.OrganisationId;
	entitled: boolean;
	configured: boolean;
	state: string;
	activeUsers: number;
	inactiveUsers: number;
	usersNeedingReview: number;
	lastSyncedAt: string | null;
	hasError: boolean;
};

export async function getDirectorySyncSettings(
	organizationId: Organisation.OrganisationId,
): Promise<DirectorySyncSettings> {
	await requireManager(organizationId);
	const [configuration] = await db()
		.select()
		.from(organizationDirectorySync)
		.where(eq(organizationDirectorySync.organizationId, organizationId))
		.limit(1);
	const totals = configuration
		? await db()
				.select({ state: directoryUsers.state, count: count() })
				.from(directoryUsers)
				.where(eq(directoryUsers.organizationId, organizationId))
				.groupBy(directoryUsers.state)
		: [];
	return {
		organizationId,
		entitled: directorySyncEntitled(organizationId),
		configured: Boolean(configuration),
		state: configuration?.state ?? "unconfigured",
		activeUsers: totals.find((row) => row.state === "active")?.count ?? 0,
		inactiveUsers: totals.find((row) => row.state === "inactive")?.count ?? 0,
		usersNeedingReview:
			totals.find((row) => row.state === "conflict")?.count ?? 0,
		lastSyncedAt: configuration?.lastSyncedAt?.toISOString() ?? null,
		hasError: Boolean(configuration?.lastError),
	};
}

export async function openDirectorySyncPortal(
	organizationId: Organisation.OrganisationId,
) {
	const organization = await requireManager(organizationId);
	if (!directorySyncEntitled(organizationId))
		throw new Error(
			"Contact Cap to enable user provisioning for this organization.",
		);
	if (!organization.workosOrganizationId)
		throw new Error("Configure your organization's SSO connection first.");
	const workos = getWorkOS();
	const remote = await workos.organizations.getOrganization(
		organization.workosOrganizationId,
	);
	if (
		remote.id !== organization.workosOrganizationId ||
		!remote.domains.some((domain) => domain.state === "verified")
	)
		throw new Error(
			"Verify your organization's work email domain before configuring provisioning.",
		);
	await db().transaction(async (tx) => {
		const [current] = await tx
			.select()
			.from(organizations)
			.where(eq(organizations.id, organizationId))
			.for("update");
		if (
			!current ||
			current.tombstoneAt ||
			current.workosOrganizationId !== remote.id
		)
			throw new Error(
				"Organization configuration changed. Refresh and try again.",
			);
		const [configuration] = await tx
			.select()
			.from(organizationDirectorySync)
			.where(eq(organizationDirectorySync.organizationId, organizationId))
			.for("update");
		if (
			configuration &&
			(configuration.workosOrganizationId !== remote.id ||
				configuration.state === "deleted")
		)
			throw new Error("Contact Cap to reconcile the directory connection.");
		if (!configuration)
			await tx.insert(organizationDirectorySync).values({
				organizationId,
				workosOrganizationId: remote.id,
				eventStartedAt: new Date(),
				nextAttemptAt: new Date(),
			});
	});
	const url = new URL(settingsPath, serverEnv().WEB_URL);
	url.searchParams.set("organizationId", organizationId);
	const result = await workos.portal.generateLink({
		organization: remote.id,
		intent: GeneratePortalLinkIntent.DSync,
		returnUrl: url.toString(),
		successUrl: url.toString(),
	});
	revalidatePath(settingsPath);
	return { url: result.link };
}
