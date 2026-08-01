import type { Organisation, User } from "@cap/web-domain";
import {
	deleteIntegrationInstallation,
	deleteIntegrationInstallationByExternalId,
	getIntegrationCredentials,
	listIntegrationInstallations,
	saveIntegrationInstallation,
} from "@/lib/integrations/installations";

const SLACK_PROVIDER = "slack";

export type SlackInstallationSummary = {
	id: string;
	teamId: string;
	teamName: string;
	createdAt: Date;
	updatedAt: Date;
};

export const saveSlackInstallation = async ({
	organizationId,
	installedByUserId,
	teamId,
	teamName,
	enterpriseId,
	botUserId,
	accessToken,
	scope,
}: {
	organizationId: Organisation.OrganisationId;
	installedByUserId: User.UserId;
	teamId: string;
	teamName: string;
	enterpriseId: string | null;
	botUserId: string | null;
	accessToken: string;
	scope: string;
}) => {
	await saveIntegrationInstallation({
		provider: SLACK_PROVIDER,
		externalId: teamId,
		displayName: teamName,
		organizationId,
		installedByUserId,
		credentials: { accessToken },
		metadata: {
			enterpriseId,
			botUserId,
			scopes: scope
				.split(",")
				.map((value) => value.trim())
				.filter(Boolean),
		},
	});
};

export const listSlackInstallations = async (
	organizationId: Organisation.OrganisationId,
): Promise<SlackInstallationSummary[]> =>
	listIntegrationInstallations({
		organizationId,
		provider: SLACK_PROVIDER,
	}).then((installations) =>
		installations.map((installation) => ({
			id: installation.id,
			teamId: installation.externalId,
			teamName: installation.displayName,
			createdAt: installation.createdAt,
			updatedAt: installation.updatedAt,
		})),
	);

export const getSlackInstallationToken = async (teamId: string) => {
	const credentials = await getIntegrationCredentials({
		provider: SLACK_PROVIDER,
		externalId: teamId,
	});
	if (credentials === null) return null;
	if (
		typeof credentials !== "object" ||
		Array.isArray(credentials) ||
		typeof (credentials as { accessToken?: unknown }).accessToken !== "string"
	) {
		throw new Error("Slack installation credentials are invalid");
	}
	return (credentials as { accessToken: string }).accessToken;
};

export const deleteSlackInstallation = async ({
	organizationId,
	installationId,
}: {
	organizationId: Organisation.OrganisationId;
	installationId: string;
}) => {
	await deleteIntegrationInstallation({
		provider: SLACK_PROVIDER,
		organizationId,
		installationId,
	});
};

export const deleteSlackInstallationByTeamId = async (teamId: string) => {
	await deleteIntegrationInstallationByExternalId({
		provider: SLACK_PROVIDER,
		externalId: teamId,
	});
};
