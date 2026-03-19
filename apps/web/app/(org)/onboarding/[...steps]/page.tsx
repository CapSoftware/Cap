import { getCurrentUser } from "@cap/database/auth/session";
import { CustomDomainPage } from "../components/CustomDomainPage";
import { DownloadPage } from "../components/DownloadPage";
import { InviteTeamPage } from "../components/InviteTeamPage";
import { OrganizationSetupPage } from "../components/OrganizationSetupPage";
import { WelcomePage } from "../components/WelcomePage";

export default async function OnboardingStepPage({
	params,
}: {
	params: Promise<{
		steps:
			| "welcome"
			| "organization-setup"
			| "custom-domain"
			| "invite-team"
			| "download";
	}>;
}) {
	const step = (await params).steps[0];

	switch (step) {
		case "welcome":
			return <WelcomePage />;
		case "organization-setup": {
			const user = await getCurrentUser();
			return <OrganizationSetupPage firstName={user?.name} />;
		}
		case "custom-domain":
			return <CustomDomainPage />;
		case "invite-team":
			return <InviteTeamPage />;
		case "download":
			return <DownloadPage />;
		default:
			return null;
	}
}
