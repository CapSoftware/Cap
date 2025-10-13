import { getCurrentUser } from "@cap/database/auth/session";
import { redirect } from "next/navigation";

export default async function WelcomeStepLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const user = await getCurrentUser();
	const steps = user?.onboardingSteps || {};

	// If welcome already completed, push user to the first incomplete step
	if (steps.welcome) {
		if (!steps.organizationSetup) redirect("/onboarding/organization-setup");
		if (!steps.customDomain) redirect("/onboarding/custom-domain");
		if (!steps.inviteTeam) redirect("/onboarding/invite-team");
		// All done → go to dashboard caps
		redirect("/dashboard/caps");
	}

	return children;
}
