import { getCurrentUser } from "@inflight/database/auth/session";
import Bottom from "./components/Bottom";
import Stepper from "./components/Stepper";

export default async function OnboardingLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const user = await getCurrentUser();
	const completedSteps = user?.onboardingSteps || {};

	return (
		<div className="flex relative flex-col justify-center items-center px-5 py-10 w-full custom-scroll min-h-fit lg:min-h-auto h-dvh bg-gray-1">
			<Stepper completedSteps={completedSteps} />
			{children}
			<Bottom />
		</div>
	);
}
