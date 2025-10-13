import { getCurrentUser } from "@cap/database/auth/session";
import { redirect } from "next/navigation";

export default async function OrganizationSetupLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const user = await getCurrentUser();
	const steps = user?.onboardingSteps || {};

	// Guard: require welcome to be complete
	if (!steps.welcome) redirect("/onboarding/welcome");

	// If this step already complete, move forward to next incomplete
	if (steps.organizationSetup) {
		if (!steps.customDomain) redirect("/onboarding/custom-domain");
		if (!steps.inviteTeam) redirect("/onboarding/invite-team");
		redirect("/dashboard/caps");
	}

	return children;
}
