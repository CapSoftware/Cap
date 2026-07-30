import { db } from "@cap/database";
import { decrypt, encrypt } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import { integrationInstallations } from "@cap/database/schema";
import type { Organisation, User } from "@cap/web-domain";
import { and, asc, eq, sql } from "drizzle-orm";

export type IntegrationInstallationSummary = {
	id: string;
	externalId: string;
	displayName: string;
	createdAt: Date;
	updatedAt: Date;
};

export const saveIntegrationInstallation = async ({
	provider,
	externalId,
	displayName,
	organizationId,
	installedByUserId,
	credentials,
	metadata,
}: {
	provider: string;
	externalId: string;
	displayName: string;
	organizationId: Organisation.OrganisationId;
	installedByUserId: User.UserId;
	credentials: Record<string, unknown>;
	metadata: Record<string, unknown>;
}) => {
	const encryptedCredentials = await encrypt(JSON.stringify(credentials));
	const candidateId = nanoId();
	await db().transaction(async (tx) => {
		await tx
			.insert(integrationInstallations)
			.values({
				id: candidateId,
				provider,
				externalId,
				displayName,
				organizationId,
				installedByUserId,
				encryptedCredentials,
				metadata,
			})
			.onDuplicateKeyUpdate({
				set: {
					externalId: sql`${integrationInstallations.externalId}`,
				},
			});

		const [installation] = await tx
			.select({
				id: integrationInstallations.id,
				organizationId: integrationInstallations.organizationId,
			})
			.from(integrationInstallations)
			.where(
				and(
					eq(integrationInstallations.provider, provider),
					eq(integrationInstallations.externalId, externalId),
				),
			)
			.for("update");
		if (!installation) {
			throw new Error("Integration installation could not be saved");
		}
		if (installation.organizationId !== organizationId) {
			throw new Error(
				"Integration is already connected to another organization",
			);
		}
		if (installation.id === candidateId) return;

		await tx
			.update(integrationInstallations)
			.set({
				displayName,
				installedByUserId,
				encryptedCredentials,
				metadata,
				updatedAt: new Date(),
			})
			.where(eq(integrationInstallations.id, installation.id));
	});
};

export const listIntegrationInstallations = async ({
	organizationId,
	provider,
}: {
	organizationId: Organisation.OrganisationId;
	provider: string;
}): Promise<IntegrationInstallationSummary[]> =>
	db()
		.select({
			id: integrationInstallations.id,
			externalId: integrationInstallations.externalId,
			displayName: integrationInstallations.displayName,
			createdAt: integrationInstallations.createdAt,
			updatedAt: integrationInstallations.updatedAt,
		})
		.from(integrationInstallations)
		.where(
			and(
				eq(integrationInstallations.organizationId, organizationId),
				eq(integrationInstallations.provider, provider),
			),
		)
		.orderBy(asc(integrationInstallations.displayName));

export const getIntegrationCredentials = async ({
	provider,
	externalId,
}: {
	provider: string;
	externalId: string;
}): Promise<unknown | null> => {
	const [installation] = await db()
		.select({
			encryptedCredentials: integrationInstallations.encryptedCredentials,
		})
		.from(integrationInstallations)
		.where(
			and(
				eq(integrationInstallations.provider, provider),
				eq(integrationInstallations.externalId, externalId),
			),
		)
		.limit(1);
	if (!installation) return null;
	return JSON.parse(
		await decrypt(installation.encryptedCredentials),
	) as unknown;
};

export const deleteIntegrationInstallation = async ({
	provider,
	organizationId,
	installationId,
}: {
	provider: string;
	organizationId: Organisation.OrganisationId;
	installationId: string;
}) => {
	await db()
		.delete(integrationInstallations)
		.where(
			and(
				eq(integrationInstallations.provider, provider),
				eq(integrationInstallations.id, installationId),
				eq(integrationInstallations.organizationId, organizationId),
			),
		);
};

export const deleteIntegrationInstallationByExternalId = async ({
	provider,
	externalId,
}: {
	provider: string;
	externalId: string;
}) => {
	await db()
		.delete(integrationInstallations)
		.where(
			and(
				eq(integrationInstallations.provider, provider),
				eq(integrationInstallations.externalId, externalId),
			),
		);
};
