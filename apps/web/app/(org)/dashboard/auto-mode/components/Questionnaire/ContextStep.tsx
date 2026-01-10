"use client";

import { classNames } from "@cap/utils";
import { faLightbulb } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

interface ContextStepProps {
	value: string;
	onChange: (value: string) => void;
}

export function ContextStep({ value, onChange }: ContextStepProps) {
	return (
		<div className="flex flex-col gap-6 w-full">
			<div className="flex flex-col gap-2 text-center">
				<div className="flex items-center justify-center w-12 h-12 mx-auto rounded-xl bg-gradient-to-br from-yellow-500/20 to-amber-500/20">
					<FontAwesomeIcon
						icon={faLightbulb}
						className="w-6 h-6 text-yellow-500"
					/>
				</div>
				<h2 className="text-xl font-semibold text-gray-12">
					Any additional context?
				</h2>
				<p className="text-gray-11">
					Share any other details that might help create a better recording.
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
						placeholder="Examples:
• Target audience is new users who just signed up
• Highlight the speed improvement over competitors
• Mention the 14-day free trial at the end
• Use 'Acme Corp' as the sample company name"
						className="w-full h-32 p-4 text-base bg-transparent border-0 resize-none text-gray-12 placeholder:text-gray-8 focus:outline-none focus:ring-0"
						value={value}
						onChange={(e) => onChange(e.target.value)}
						aria-label="Additional context"
					/>
				</div>
				<p className="text-sm text-center text-gray-9">
					Optional - Skip if you don&apos;t have additional notes
				</p>
			</div>
		</div>
	);
}
