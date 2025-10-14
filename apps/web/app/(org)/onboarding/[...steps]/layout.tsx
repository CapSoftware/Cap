import { getCurrentUser } from "@cap/database/auth/session";
import { redirect } from "next/navigation";

export default async function OnboardingStepLayout({
	children,
	params,
}: {
	children: React.ReactNode;
	params: Promise<{ steps: string[] }>;
}) {
	const user = await getCurrentUser();
	const steps = user?.onboardingSteps || {};
	const currentStep = (await params).steps?.[0];

	switch (currentStep) {
		case "welcome":
			if (steps.welcome) {
				if (!steps.organizationSetup)
					redirect("/onboarding/organization-setup");
				if (!steps.customDomain) redirect("/onboarding/custom-domain");
				if (!steps.inviteTeam) redirect("/onboarding/invite-team");
				redirect("/dashboard/caps");
			}
			break;

		case "organization-setup":
			if (!steps.welcome) redirect("/onboarding/welcome");
			if (steps.organizationSetup) {
				if (!steps.customDomain) redirect("/onboarding/custom-domain");
				if (!steps.inviteTeam) redirect("/onboarding/invite-team");
				redirect("/dashboard/caps");
			}
			break;

		case "custom-domain":
			if (!steps.welcome) redirect("/onboarding/welcome");
			if (!steps.organizationSetup) redirect("/onboarding/organization-setup");

			if (steps.customDomain) {
				if (!steps.inviteTeam) redirect("/onboarding/invite-team");
				redirect("/dashboard/caps");
			}
			break;

		case "invite-team":
			if (!steps.welcome) redirect("/onboarding/welcome");
			if (!steps.organizationSetup) redirect("/onboarding/organization-setup");
			if (!steps.customDomain) redirect("/onboarding/custom-domain");

			if (steps.inviteTeam) redirect("/dashboard/caps");
			break;

		default:
			redirect("/onboarding/welcome");
	}

	return children;
}
