"use client";

import { classNames } from "@cap/utils";
import type { AutoMode } from "@cap/web-domain";
import {
	faBug,
	faEllipsis,
	faGraduationCap,
	faRocket,
	faRoute,
	type IconDefinition,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

interface FocusStepProps {
	value: AutoMode.AutoModeRecordingFocus | null;
	onChange: (value: AutoMode.AutoModeRecordingFocus) => void;
}

interface FocusOption {
	value: AutoMode.AutoModeRecordingFocus;
	label: string;
	description: string;
	icon: IconDefinition;
}

const FOCUS_OPTIONS: FocusOption[] = [
	{
		value: "feature_demo",
		label: "Feature Demo",
		description: "Showcase a product feature or functionality",
		icon: faRocket,
	},
	{
		value: "bug_report",
		label: "Bug Report",
		description: "Document a bug or issue for developers",
		icon: faBug,
	},
	{
		value: "tutorial",
		label: "Tutorial",
		description: "Step-by-step educational content",
		icon: faGraduationCap,
	},
	{
		value: "walkthrough",
		label: "Walkthrough",
		description: "Guide through a process or workflow",
		icon: faRoute,
	},
	{
		value: "other",
		label: "Other",
		description: "Something else not listed here",
		icon: faEllipsis,
	},
];

export function FocusStep({ value, onChange }: FocusStepProps) {
	return (
		<div className="flex flex-col gap-6 w-full">
			<div className="flex flex-col gap-2 text-center">
				<h2 className="text-xl font-semibold text-gray-12">
					What type of recording is this?
				</h2>
				<p className="text-gray-11">
					This helps us tailor the narration style and action flow.
				</p>
			</div>

			<div className="grid gap-3 sm:grid-cols-2">
				{FOCUS_OPTIONS.map((option) => (
					<button
						key={option.value}
						type="button"
						onClick={() => onChange(option.value)}
						className={classNames(
							"flex flex-col gap-2 p-4 rounded-xl border transition-all duration-200 text-left",
							value === option.value
								? "bg-gray-12 border-gray-12 text-gray-1"
								: "bg-gray-2 border-gray-4 hover:border-gray-6 hover:bg-gray-3 text-gray-12",
						)}
						aria-pressed={value === option.value}
					>
						<div className="flex items-center gap-3">
							<div
								className={classNames(
									"flex items-center justify-center w-10 h-10 rounded-lg",
									value === option.value ? "bg-gray-1/20" : "bg-gray-4",
								)}
							>
								<FontAwesomeIcon
									icon={option.icon}
									className={classNames(
										"w-5 h-5",
										value === option.value ? "text-gray-1" : "text-gray-11",
									)}
								/>
							</div>
							<span className="font-medium">{option.label}</span>
						</div>
						<p
							className={classNames(
								"text-sm",
								value === option.value ? "text-gray-1/80" : "text-gray-10",
							)}
						>
							{option.description}
						</p>
					</button>
				))}
			</div>
		</div>
	);
}
