"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { getWorkOS } from "@cap/database/auth/sso";
import {
	directoryUsers,
	organizationDirectorySync,
	organizations,
} from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { hasSsoAccess } from "@cap/utils";
import type { Organisation } from "@cap/web-domain";
import { GeneratePortalLinkIntent } from "@workos-inc/node";
import { and, count, eq, gte, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { getSsoBilling } from "@/lib/sso/billing";
import { requestDirectorySync } from "@/lib/sso/directory-sync";
import { hasScimSubscription } from "@/lib/sso/scim-billing";
import { requireOrganizationSettingsManager } from "./authorization";

const settingsPath = "/dashboard/settings/organization/security";

export type OrganizationDirectorySync = {
	entitled: boolean;
	available: boolean;
	directories: Array<{ id: string; name: string; state: string }>;
	syncedMembers: number;
	lastSyncedAt: string | null;
	syncFailed: boolean;
	heldRemovals: number;
};

async function requireDirectorySyncManager(
	organizationId: Organisation.OrganisationId,
) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	await requireOrganizationSettingsManager(user.id, organizationId);
	const [organization] = await db()
		.select({ workosOrganizationId: organizations.workosOrganizationId })
		.from(organizations)
		.where(
			and(
				eq(organizations.id, organizationId),
				isNull(organizations.tombstoneAt),
			),
		)
		.limit(1);
	if (!organization) throw new Error("Organization not found.");
	const env = serverEnv();
	const billing = await getSsoBilling(organizationId);
	const entitled =
		Boolean(env.WORKOS_API_KEY && env.WORKOS_CLIENT_ID) &&
		hasSsoAccess(billing) &&
		(await hasScimSubscription(organizationId));
	return {
		entitled,
		workosOrganizationId: entitled ? organization.workosOrganizationId : null,
	};
}

async function getVerifiedWorkosOrganization(workosOrganizationId: string) {
	const remote =
		await getWorkOS().organizations.getOrganization(workosOrganizationId);
	if (remote.id !== workosOrganizationId)
		throw new Error("The SSO organization could not be verified.");
	return remote.domains.some((entry) => entry.state === "verified")
		? remote
		: null;
}

export async function getOrganizationDirectorySync(
	organizationId: Organisation.OrganisationId,
): Promise<OrganizationDirectorySync> {
	const { entitled, workosOrganizationId } =
		await requireDirectorySyncManager(organizationId);
	const unavailable = {
		entitled,
		available: false,
		directories: [],
		syncedMembers: 0,
		lastSyncedAt: null,
		syncFailed: false,
		heldRemovals: 0,
	};
	if (!workosOrganizationId) return unavailable;
	const [remote, directories] = await Promise.all([
		getVerifiedWorkosOrganization(workosOrganizationId),
		getWorkOS().directorySync.listDirectories({
			organizationId: workosOrganizationId,
			limit: 10,
		}),
	]);
	if (!remote) return unavailable;
	if (
		directories.data.some(
			(directory) => directory.organizationId !== workosOrganizationId,
		)
	) {
		throw new Error("The directory organization could not be verified.");
	}
	const [[state], [synced]] = await Promise.all([
		db()
			.select()
			.from(organizationDirectorySync)
			.where(eq(organizationDirectorySync.organizationId, organizationId))
			.limit(1),
		db()
			.select({ value: count() })
			.from(directoryUsers)
			.where(
				and(
					eq(directoryUsers.organizationId, organizationId),
					eq(directoryUsers.active, true),
				),
			),
	]);
	if (!state && directories.data.length > 0) {
		await requestDirectorySync(organizationId);
	}
	return {
		entitled,
		available: true,
		directories: directories.data.map((directory) => ({
			id: directory.id,
			name: directory.name,
			state: directory.state,
		})),
		syncedMembers: synced?.value ?? 0,
		lastSyncedAt: state?.syncedAt?.toISOString() ?? null,
		syncFailed: Boolean(state?.lastError),
		heldRemovals: state?.heldRemovals ?? 0,
	};
}

export async function openOrganizationDirectorySyncPortal(
	organizationId: Organisation.OrganisationId,
) {
	const { workosOrganizationId } =
		await requireDirectorySyncManager(organizationId);
	if (!workosOrganizationId)
		throw new Error("The SCIM directory sync add-on is required.");
	const remote = await getVerifiedWorkosOrganization(workosOrganizationId);
	if (!remote) throw new Error("Verify your organization's domain first.");
	await requestDirectorySync(organizationId);
	const returnUrl = new URL(settingsPath, serverEnv().WEB_URL);
	returnUrl.searchParams.set("organizationId", organizationId);
	const result = await getWorkOS().portal.generateLink({
		organization: remote.id,
		intent: GeneratePortalLinkIntent.DSync,
		returnUrl: returnUrl.toString(),
		successUrl: returnUrl.toString(),
	});
	revalidatePath(settingsPath);
	return { url: result.link };
}

export async function approveDirectorySyncRemovals(
	organizationId: Organisation.OrganisationId,
	confirmedRemovals: number,
) {
	if (!Number.isSafeInteger(confirmedRemovals) || confirmedRemovals < 1)
		throw new Error("Invalid removal confirmation.");
	const { workosOrganizationId } =
		await requireDirectorySyncManager(organizationId);
	if (!workosOrganizationId)
		throw new Error("The SCIM directory sync add-on is required.");
	const now = new Date();
	await db()
		.update(organizationDirectorySync)
		.set({
			removalsApprovedAt: now,
			requestedAt: now,
			heldRemovals: confirmedRemovals,
		})
		.where(
			and(
				eq(organizationDirectorySync.organizationId, organizationId),
				gte(organizationDirectorySync.heldRemovals, confirmedRemovals),
			),
		);
	revalidatePath(settingsPath);
	return getOrganizationDirectorySync(organizationId);
}
