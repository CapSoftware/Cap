"use client";

import { Fragment } from "react";

export default function Stepper() {
	const steps = [
		{
			id: "1",
			name: "Welcome",
		},
		{
			id: "2",
			name: "Organization Setup",
		},
		{
			id: "3",
			name: "Custom Domain",
		},
		{
			id: "4",
			name: "Invite your team",
		},
	];

	return (
		<div className="flex items-center absolute top-10 left-0 right-0 mx-auto justify-center max-w-fit bg-gray-2 rounded-xl px-5 py-2 h-[64px] border border-gray-4">
			{steps.map((step, idx) => (
				<Fragment key={step.id}>
					<div className="flex justify-center items-center">
						{idx !== 0 && (
							<div className="flex-1 min-w-[72px] mx-5 h-[2px] border-t border-dashed border-gray-8" />
						)}
						<div className="flex flex-1 gap-2 justify-center items-center min-w-fit">
							<div className="flex justify-center items-center text-xs text-white bg-blue-500 rounded-full size-5 min-size-5">
								<p>{step.id}</p>
							</div>
							<p className="text-sm text-gray-12 text-nowrap">{step.name}</p>
						</div>
					</div>
				</Fragment>
			))}
		</div>
	);
}
