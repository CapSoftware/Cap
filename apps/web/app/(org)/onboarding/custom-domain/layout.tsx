import { getCurrentUser } from "@cap/database/auth/session";
import { redirect } from "next/navigation";

export default async function CustomDomainLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const user = await getCurrentUser();
	const steps = user?.onboardingSteps || {};

	// Require previous steps
	if (!steps.welcome) redirect("/onboarding/welcome");
	if (!steps.organizationSetup) redirect("/onboarding/organization-setup");

	// If this step complete, move forward
	if (steps.customDomain) {
		if (!steps.inviteTeam) redirect("/onboarding/invite-team");
		redirect("/dashboard/caps");
	}

	return children;
}
