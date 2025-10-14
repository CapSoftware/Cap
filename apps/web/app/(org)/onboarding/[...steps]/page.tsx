import { CustomDomainPage } from "../components/CustomDomainPage";
import { InviteTeamPage } from "../components/InviteTeamPage";
import { OrganizationSetupPage } from "../components/OrganizationSetupPage";
import { WelcomePage } from "../components/WelcomePage";

export default async function OnboardingStepPage({
	params,
}: {
	params: Promise<{
		steps: "welcome" | "organization-setup" | "custom-domain" | "invite-team";
	}>;
}) {
	const step = (await params).steps[0];

	switch (step) {
		case "welcome":
			return <WelcomePage />;
		case "organization-setup":
			return <OrganizationSetupPage />;
		case "custom-domain":
			return <CustomDomainPage />;
		case "invite-team":
			return <InviteTeamPage />;
		default:
			return null;
	}
}
