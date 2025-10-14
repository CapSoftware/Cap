import { getCurrentUser } from "@cap/database/auth/session";
import Stepper from "./components/Stepper";
export const dynamic = "force-dynamic";

export default async function OnboardingLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const user = await getCurrentUser();
	const completedSteps = user?.onboardingSteps || {};

	return (
		<div className="flex overflow-y-auto relative flex-col justify-center items-center px-5 py-10 w-full min-h-fit lg:min-h-auto h-dvh bg-gray-1">
			<Stepper completedSteps={completedSteps} />
			{children}
		</div>
	);
}
