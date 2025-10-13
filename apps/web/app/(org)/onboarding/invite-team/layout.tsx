import { getCurrentUser } from "@cap/database/auth/session";
import { redirect } from "next/navigation";

export default async function InviteTeamLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const user = await getCurrentUser();
	const steps = user?.onboardingSteps || {};

	// Require previous steps
	if (!steps.welcome) redirect("/onboarding/welcome");
	if (!steps.organizationSetup) redirect("/onboarding/organization-setup");
	if (!steps.customDomain) redirect("/onboarding/custom-domain");

	// If already complete, proceed to dashboard caps
	if (steps.inviteTeam) redirect("/dashboard/caps");

	return children;
}
