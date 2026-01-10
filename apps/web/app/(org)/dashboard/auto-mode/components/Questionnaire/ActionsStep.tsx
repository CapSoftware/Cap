"use client";

import { classNames } from "@cap/utils";
import { faListCheck } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

interface ActionsStepProps {
	value: string;
	onChange: (value: string) => void;
}

export function ActionsStep({ value, onChange }: ActionsStepProps) {
	return (
		<div className="flex flex-col gap-6 w-full">
			<div className="flex flex-col gap-2 text-center">
				<div className="flex items-center justify-center w-12 h-12 mx-auto rounded-xl bg-gradient-to-br from-green-500/20 to-teal-500/20">
					<FontAwesomeIcon
						icon={faListCheck}
						className="w-6 h-6 text-green-500"
					/>
				</div>
				<h2 className="text-xl font-semibold text-gray-12">
					What actions should be shown?
				</h2>
				<p className="text-gray-11">
					Describe the specific steps or actions you want demonstrated.
				</p>
			</div>

			<div className="flex flex-col gap-2">
				<div
					className={classNames(
						"w-full p-1 rounded-xl border transition-colors duration-200",
						"bg-gray-2 border-gray-4 focus-within:border-gray-6 focus-within:ring-1 focus-within:ring-gray-6",
					)}
				>
					<textarea
						placeholder="Example:
1. Click the 'Sign Up' button in the header
2. Fill in the registration form with sample data
3. Submit the form and show the confirmation page
4. Navigate to the dashboard"
						className="w-full h-40 p-4 text-base bg-transparent border-0 resize-none text-gray-12 placeholder:text-gray-8 focus:outline-none focus:ring-0"
						value={value}
						onChange={(e) => onChange(e.target.value)}
						aria-label="Key actions to demonstrate"
					/>
				</div>
				<p className="text-sm text-center text-gray-9">
					Be specific about buttons, links, and interactions
				</p>
			</div>
		</div>
	);
}
