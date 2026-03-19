"use client";

import { faCheck } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import clsx from "clsx";
import { usePathname } from "next/navigation";
import { Fragment, useMemo } from "react";

export default function Stepper({
	completedSteps,
}: {
	completedSteps: {
		welcome?: boolean;
		organizationSetup?: boolean;
		customDomain?: boolean;
		inviteTeam?: boolean;
		download?: boolean;
	};
}) {
	const currentPath = usePathname();
	const currentStep = useMemo(() => {
		if (currentPath === "/onboarding/welcome") return "Welcome";
		if (currentPath === "/onboarding/organization-setup")
			return "Organization Setup";
		if (currentPath === "/onboarding/custom-domain") return "Custom Domain";
		if (currentPath === "/onboarding/invite-team") return "Invite your team";
		if (currentPath === "/onboarding/download") return "Download";
	}, [currentPath]);

	const steps = [
		{
			id: "1",
			name: "Welcome",
			completed: completedSteps.welcome || false,
		},
		{
			id: "2",
			name: "Organization Setup",
			completed: completedSteps.organizationSetup || false,
		},
		{
			id: "3",
			name: "Custom Domain",
			completed: completedSteps.customDomain || false,
		},
		{
			id: "4",
			name: "Invite your team",
			completed: completedSteps.inviteTeam || false,
		},
		{
			id: "5",
			name: "Download",
			completed: completedSteps.download || false,
		},
	];

	return (
		<>
			{/* Mobile Stepper - shows on devices up to 1024px */}
			<div className="justify-center mx-auto mb-10 max-w-fit lg:hidden">
				<MobileStepper currentStep={currentStep} steps={steps} />
			</div>

			{/* Desktop Stepper - shows on devices 1024px and up */}
			<div className="hidden absolute right-0 left-0 top-6 justify-center items-center p-4 mx-auto rounded-xl border lg:flex max-w-fit bg-gray-2 border-gray-4">
				{steps.map((step, idx) => {
					return (
						<Fragment key={step.id}>
							<div className="flex justify-center items-center">
								{idx !== 0 && (
									<div className="flex-1 mx-5 border-t border-dashed min-w-[72px] h-[2px] border-gray-8" />
								)}
								<div className="flex flex-1 gap-2 justify-center items-center min-w-fit">
									<div
										className={clsx(
											"flex justify-center items-center text-xs text-white rounded-full size-5 min-size-5",
											currentStep === step.name && !step.completed
												? "bg-blue-500"
												: step.completed
													? "bg-green-500"
													: "bg-gray-7",
										)}
									>
										{step.completed ? (
											<FontAwesomeIcon
												icon={faCheck}
												className="text-white size-2"
											/>
										) : (
											<p>{step.id}</p>
										)}
									</div>
									<p
										className={clsx(
											"text-[13px] text-nowrap",
											step.completed || currentStep === step.name
												? "text-gray-12"
												: "text-gray-9",
										)}
									>
										{step.name}
									</p>
								</div>
							</div>
						</Fragment>
					);
				})}
			</div>
		</>
	);
}

const MobileStepper = ({
	currentStep,
	steps,
}: {
	currentStep: string | undefined;
	steps: Array<{
		id: string;
		name: string;
		completed: boolean;
	}>;
}) => {
	const activeStep = steps.find((step) => step.name === currentStep);

	if (!activeStep) return null;

	return (
		<div className="flex gap-x-4 items-center p-3 rounded-xl border bg-gray-2 border-gray-4">
			<div className="flex gap-2 items-center">
				<div
					className={clsx(
						"flex justify-center items-center text-xs text-white rounded-full size-5 min-size-5",
						"bg-blue-500",
					)}
				>
					<p>{activeStep.id}</p>
				</div>
				<p className="text-sm font-medium text-gray-12">{activeStep.name}</p>
			</div>
			<div>
				<p className="text-[13px] text-gray-10">
					Step <span className="text-gray-11">{activeStep.id}/5</span>
				</p>
			</div>
		</div>
	);
};
