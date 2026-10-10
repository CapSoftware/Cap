import { getCurrentUser } from "@cap/database/auth/session";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
	hasOnboardingName,
	ONBOARDING_NEXT_COOKIE,
	onboardingHrefForIntent,
	onboardingIntentFromNextPath,
	onboardingStepHref,
} from "./onboarding-flow";

export default async function Onboarding() {
	const user = await getCurrentUser();
	if (!user) redirect("/login");
	if (!hasOnboardingName(user)) redirect(onboardingStepHref("welcome"));

	const nextPath = (await cookies()).get(ONBOARDING_NEXT_COOKIE)?.value;
	redirect(onboardingHrefForIntent(onboardingIntentFromNextPath(nextPath)));
}
