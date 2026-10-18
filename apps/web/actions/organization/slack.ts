"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import type { Organisation } from "@cap/web-domain";
import { revalidatePath } from "next/cache";
import { isSlackIntegrationConfigured } from "@/lib/slack/client";
import {
	deleteSlackInstallation,
	listSlackInstallations,
} from "@/lib/slack/installations";
import { requireOrganizationSettingsManager } from "./authorization";

const settingsPath = "/dashboard/settings/organization/integrations";

const requireSlackSettingsManager = async (
	organizationId: Organisation.OrganisationId,
) => {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	await requireOrganizationSettingsManager(user.id, organizationId);
	return user;
};

export const getOrganizationSlackSettings = async (
	organizationId: Organisation.OrganisationId,
) => {
	await requireSlackSettingsManager(organizationId);
	return {
		configured: isSlackIntegrationConfigured(),
		installations: await listSlackInstallations(organizationId),
	};
};

export const disconnectOrganizationSlack = async ({
	organizationId,
	installationId,
}: {
	organizationId: Organisation.OrganisationId;
	installationId: string;
}) => {
	await requireSlackSettingsManager(organizationId);
	await deleteSlackInstallation({ organizationId, installationId });
	revalidatePath(settingsPath);
};
