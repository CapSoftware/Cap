import Stepper from "./Stepper";

export default function OnboardingLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<div className="flex relative justify-center items-center w-full h-screen bg-gray-1">
			<Stepper />
			{children}
		</div>
	);
}
