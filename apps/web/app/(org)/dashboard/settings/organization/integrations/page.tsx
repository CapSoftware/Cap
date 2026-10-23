import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getOrganizationSlackSettings } from "@/actions/organization/slack";
import { getOrganizationStorageSettings } from "@/actions/organization/storage";
import { SlackIntegration } from "./slack-integration";
import { OrganizationStorageIntegrations } from "./storage-integrations";

export const metadata: Metadata = {
	title: "Organization Integrations — Cap",
};

export default async function OrganizationIntegrationsPage({
	searchParams,
}: {
	searchParams: Promise<{ slack?: string }>;
}) {
	const user = await getCurrentUser();

	if (!user) {
		redirect("/auth/signin");
	}

	if (!user.activeOrganizationId) {
		redirect("/dashboard/caps");
	}

	const settings = await getOrganizationStorageSettings(
		user.activeOrganizationId,
	).catch((error: unknown) => {
		if (
			error instanceof Error &&
			(error.message ===
				"Organization settings are only available to admins and owners" ||
				error.message === "Organization not found")
		) {
			redirect("/dashboard/caps");
		}

		throw error;
	});
	const slackSettings = await getOrganizationSlackSettings(
		user.activeOrganizationId,
	);
	const { slack } = await searchParams;

	return (
		<div className="flex flex-col gap-4">
			<SlackIntegration
				organizationId={user.activeOrganizationId}
				configured={slackSettings.configured}
				installations={slackSettings.installations}
				result={slack}
			/>
			<OrganizationStorageIntegrations initialSettings={settings} />
		</div>
	);
}
