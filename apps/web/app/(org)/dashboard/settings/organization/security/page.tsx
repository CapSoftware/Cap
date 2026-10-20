import { getCurrentUser } from "@cap/database/auth/session";
import { Card, CardDescription, CardHeader, CardTitle } from "@cap/ui";
import type { Metadata } from "next";
import { redirect, unstable_rethrow } from "next/navigation";
import { getOrganizationSsoSettings } from "@/actions/organization/sso";
import { ComplianceCard } from "../components/ComplianceCard";
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
			<div className="flex flex-col gap-6">
				<Card>
					<CardHeader>
						<CardTitle>Switch organizations to continue SSO setup</CardTitle>
						<CardDescription>
							Choose the organization you were setting up from the organization
							switcher, then reload this page to refresh its payment and SSO
							status. If you are already in the correct organization, contact
							Cap support.
						</CardDescription>
					</CardHeader>
				</Card>
				<ComplianceCard />
			</div>
		);
	}
	let settings: Awaited<ReturnType<typeof getOrganizationSsoSettings>>;
	try {
		settings = await getOrganizationSsoSettings(user.activeOrganizationId);
	} catch (error) {
		unstable_rethrow(error);
		return (
			<div className="flex flex-col gap-6">
				<Card>
					<CardHeader>
						<CardTitle>SAML SSO</CardTitle>
						<CardDescription>
							Unable to load SAML SSO settings. Reload this page to try again.
							If the problem continues, contact{" "}
							<a className="underline" href="mailto:hello@cap.so">
								hello@cap.so
							</a>{" "}
							for help.
						</CardDescription>
					</CardHeader>
				</Card>
				<ComplianceCard />
			</div>
		);
	}

	return (
		<div className="flex flex-col gap-6">
			<SsoCard
				key={settings.organizationId}
				initialSettings={settings}
				checkoutSessionId={
					typeof query.sso_checkout === "string"
						? query.sso_checkout
						: undefined
				}
			/>
			<ComplianceCard />
		</div>
	);
}
