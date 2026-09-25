import { db } from "@cap/database";
import { directoryAccessAllowed } from "@cap/database/directory-sync/access";
import {
	organizationMembers,
	organizations,
	s3Buckets,
	storageIntegrations,
} from "@cap/database/schema";
import type { Organisation, User } from "@cap/web-domain";
import { and, desc, eq, isNull, or } from "drizzle-orm";

const googleDriveProvider = "googleDrive";

export type ManagedOrganizationStorage = {
	id: string;
	name: string;
	activeProvider: "s3" | "googleDrive";
};

export const getAccessibleOrganization = async (
	userId: User.UserId,
	organizationId: Organisation.OrganisationId,
) => {
	const [organization] = await db()
		.select({
			id: organizations.id,
			name: organizations.name,
			ownerId: organizations.ownerId,
			memberRole: organizationMembers.role,
		})
		.from(organizations)
		.leftJoin(
			organizationMembers,
			and(
				eq(organizationMembers.organizationId, organizations.id),
				and(
					eq(organizationMembers.userId, userId),
					directoryAccessAllowed(userId, organizationMembers.organizationId),
				),
			),
		)
		.where(
			and(
				eq(organizations.id, organizationId),
				isNull(organizations.tombstoneAt),
				or(
					and(
						eq(organizations.ownerId, userId),
						directoryAccessAllowed(userId, organizations.id),
					),
					and(
						eq(organizationMembers.userId, userId),
						directoryAccessAllowed(userId, organizationMembers.organizationId),
					),
				),
			),
		)
		.limit(1);

	return organization ?? null;
};

export const requireOrganizationOwner = async (
	userId: User.UserId,
	organizationId: Organisation.OrganisationId,
) => {
	const organization = await getAccessibleOrganization(userId, organizationId);
	if (!organization || organization.ownerId !== userId) return null;
	return organization;
};

export const getOrganizationGoogleDriveIntegration = async (
	organizationId: Organisation.OrganisationId,
) => {
	const [integration] = await db()
		.select()
		.from(storageIntegrations)
		.where(
			and(
				eq(storageIntegrations.organizationId, organizationId),
				eq(storageIntegrations.provider, googleDriveProvider),
			),
		)
		.orderBy(
			desc(storageIntegrations.active),
			desc(storageIntegrations.updatedAt),
		)
		.limit(1);

	return integration ?? null;
};

export const getActiveOrganizationGoogleDriveIntegration = async (
	organizationId: Organisation.OrganisationId,
) => {
	const [integration] = await db()
		.select()
		.from(storageIntegrations)
		.where(
			and(
				eq(storageIntegrations.organizationId, organizationId),
				eq(storageIntegrations.provider, googleDriveProvider),
				eq(storageIntegrations.active, true),
				eq(storageIntegrations.status, "active"),
			),
		)
		.orderBy(desc(storageIntegrations.updatedAt))
		.limit(1);

	return integration ?? null;
};

export const getOrganizationS3Bucket = async (
	organizationId: Organisation.OrganisationId,
) => {
	const [bucket] = await db()
		.select()
		.from(s3Buckets)
		.where(
			and(
				eq(s3Buckets.organizationId, organizationId),
				eq(s3Buckets.active, true),
			),
		)
		.orderBy(desc(s3Buckets.updatedAt))
		.limit(1);

	return bucket ?? null;
};

export const getManagedOrganizationStorage = async (
	userId: User.UserId,
	organizationId: Organisation.OrganisationId,
): Promise<ManagedOrganizationStorage | null> => {
	const organization = await getAccessibleOrganization(userId, organizationId);
	if (!organization) return null;

	const activeDrive =
		await getActiveOrganizationGoogleDriveIntegration(organizationId);
	if (activeDrive) {
		return {
			id: organization.id,
			name: organization.name,
			activeProvider: "googleDrive",
		};
	}

	const bucket = await getOrganizationS3Bucket(organizationId);
	if (!bucket) return null;

	return {
		id: organization.id,
		name: organization.name,
		activeProvider: "s3",
	};
};
