"use client";

import { classNames } from "@cap/utils";
import type { AutoMode } from "@cap/web-domain";
import { faClock, faInfinity } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

interface DurationStepProps {
	value: AutoMode.AutoModeDurationPreference | null;
	onChange: (value: AutoMode.AutoModeDurationPreference) => void;
}

interface DurationOption {
	value: AutoMode.AutoModeDurationPreference;
	label: string;
	description: string;
}

const DURATION_OPTIONS: DurationOption[] = [
	{
		value: "30s",
		label: "30 seconds",
		description: "Quick highlight or teaser",
	},
	{
		value: "1min",
		label: "1 minute",
		description: "Brief overview or demo",
	},
	{
		value: "2min",
		label: "2 minutes",
		description: "Standard walkthrough",
	},
	{
		value: "5min",
		label: "5 minutes",
		description: "Detailed tutorial",
	},
	{
		value: "as_needed",
		label: "As needed",
		description: "Let AI decide based on content",
	},
];

export function DurationStep({ value, onChange }: DurationStepProps) {
	return (
		<div className="flex flex-col gap-6 w-full">
			<div className="flex flex-col gap-2 text-center">
				<div className="flex items-center justify-center w-12 h-12 mx-auto rounded-xl bg-gradient-to-br from-orange-500/20 to-yellow-500/20">
					<FontAwesomeIcon icon={faClock} className="w-6 h-6 text-orange-500" />
				</div>
				<h2 className="text-xl font-semibold text-gray-12">
					How long should the video be?
				</h2>
				<p className="text-gray-11">
					Choose a target duration for your recording.
				</p>
			</div>

			<div className="flex flex-wrap justify-center gap-3">
				{DURATION_OPTIONS.map((option) => (
					<button
						key={option.value}
						type="button"
						onClick={() => onChange(option.value)}
						className={classNames(
							"flex flex-col items-center gap-1 px-5 py-3 rounded-xl border transition-all duration-200",
							value === option.value
								? "bg-gray-12 border-gray-12 text-gray-1"
								: "bg-gray-2 border-gray-4 hover:border-gray-6 hover:bg-gray-3 text-gray-12",
						)}
						aria-pressed={value === option.value}
					>
						{option.value === "as_needed" ? (
							<FontAwesomeIcon
								icon={faInfinity}
								className={classNames(
									"w-5 h-5 mb-1",
									value === option.value ? "text-gray-1" : "text-gray-11",
								)}
							/>
						) : (
							<span className="text-lg font-semibold">
								{option.label.split(" ")[0]}
							</span>
						)}
						<span
							className={classNames(
								"text-sm font-medium",
								option.value === "as_needed" && "mt-1",
							)}
						>
							{option.value === "as_needed"
								? option.label
								: option.label.split(" ").slice(1).join(" ")}
						</span>
						<span
							className={classNames(
								"text-xs",
								value === option.value ? "text-gray-1/70" : "text-gray-9",
							)}
						>
							{option.description}
						</span>
					</button>
				))}
			</div>
		</div>
	);
}
