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
		<div className="flex relative justify-center items-center w-full h-screen bg-gray-1">
			<Stepper completedSteps={completedSteps} />
			{children}
		</div>
	);
}
