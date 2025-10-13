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
	};
}) {
	const currentPath = usePathname();
	const currentStep = useMemo(() => {
		if (currentPath === "/onboarding/welcome") return "Welcome";
		if (currentPath === "/onboarding/organization-setup")
			return "Organization Setup";
		if (currentPath === "/onboarding/custom-domain") return "Custom Domain";
		if (currentPath === "/onboarding/invite-team") return "Invite your team";
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
	];

	return (
		<div className="flex items-center absolute top-10 left-0 right-0 mx-auto justify-center max-w-fit bg-gray-2 rounded-xl px-5 py-2 h-[64px] border border-gray-4">
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
										"text-sm text-nowrap",
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
	);
}
