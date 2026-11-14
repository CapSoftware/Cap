import { getCurrentUser } from "@cap/database/auth/session";
import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";
import { getOrganizationDirectorySync } from "@/actions/organization/directory-sync";
import { getOrganizationSsoSettings } from "@/actions/organization/sso";
import { KeyDoodle } from "../_components/doodles";
import {
	SettingsCard,
	SettingsRow,
	SettingsSection,
} from "../_components/settings-ui";
import { ComplianceCard } from "../components/ComplianceCard";
import {
	DirectorySyncCard,
	directorySyncNotAdded,
} from "../components/DirectorySyncCard";
import { SignedBaaCard } from "../components/SignedBaaCard";
import { SsoCard } from "../components/SsoCard";

export const metadata: Metadata = {
	title: "Security & Compliance — Cap",
};

export default async function OrganizationSecurityPage({
	searchParams,
}: {
	searchParams: Promise<{
		sso_checkout?: string | string[];
		organizationId?: string | string[];
	}>;
}) {
	const [user, query] = await Promise.all([getCurrentUser(), searchParams]);
	if (!user) redirect("/auth/signin");
	if (!user.activeOrganizationId) redirect("/dashboard/caps");
	if (
		(query.sso_checkout || query.organizationId) &&
		query.organizationId !== user.activeOrganizationId
	) {
		return (
			<div className="flex flex-col gap-10">
				<SettingsSection title="Add-ons">
					<SettingsCard>
						<SettingsRow
							icon={<KeyDoodle />}
							title="Switch organizations to continue SSO setup"
							description="Choose the organization you were setting up from the organization switcher, then reload this page to refresh its payment and SSO status. If you are already in the correct organization, contact Cap support."
						/>
					</SettingsCard>
				</SettingsSection>
				<ComplianceCard />
			</div>
		);
	}
	let settings: Awaited<ReturnType<typeof getOrganizationSsoSettings>> | null;
	try {
		settings = await getOrganizationSsoSettings(user.activeOrganizationId);
	} catch (error) {
		unstable_rethrow(error);
		settings = null;
	}

	const directorySync = settings?.entitled
		? await getOrganizationDirectorySync(settings.organizationId).catch(
				(error) => {
					unstable_rethrow(error);
					return null;
				},
			)
		: null;

	return (
		<div className="flex flex-col gap-10">
			<SettingsSection anchor="add-ons" title="Add-ons">
				<SettingsCard>
					{settings ? (
						<SsoCard
							key={settings.organizationId}
							initialSettings={settings}
							checkoutSessionId={
								typeof query.sso_checkout === "string"
									? query.sso_checkout
									: undefined
							}
						/>
					) : (
						<SettingsRow
							anchor="sso"
							icon={<KeyDoodle />}
							title="SAML SSO"
							description={
								<>
									Unable to load SAML SSO settings. Reload this page to try
									again. If the problem continues, contact{" "}
									<a className="underline" href="mailto:hello@cap.so">
										hello@cap.so
									</a>{" "}
									for help.
								</>
							}
						/>
					)}
					{settings && (!settings.entitled || directorySync) && (
						<DirectorySyncCard
							key={`directory-${settings.organizationId}`}
							organizationId={settings.organizationId}
							organizationName={settings.organizationName}
							initialStatus={directorySync ?? directorySyncNotAdded}
							requiresSso={!settings.entitled}
						/>
					)}
					<SignedBaaCard />
				</SettingsCard>
			</SettingsSection>
			<ComplianceCard />
		</div>
	);
}
