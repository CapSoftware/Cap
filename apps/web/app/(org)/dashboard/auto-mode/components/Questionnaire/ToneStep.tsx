"use client";

import { classNames } from "@cap/utils";
import type { AutoMode } from "@cap/web-domain";
import {
	faBookOpen,
	faBriefcase,
	faComments,
	faFaceSmileBeam,
	type IconDefinition,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";

interface ToneStepProps {
	value: AutoMode.AutoModeNarrationTone | null;
	onChange: (value: AutoMode.AutoModeNarrationTone) => void;
}

interface ToneOption {
	value: AutoMode.AutoModeNarrationTone;
	label: string;
	description: string;
	icon: IconDefinition;
	example: string;
}

const TONE_OPTIONS: ToneOption[] = [
	{
		value: "professional",
		label: "Professional",
		description: "Formal and business-appropriate",
		icon: faBriefcase,
		example: '"This feature enables teams to..."',
	},
	{
		value: "casual",
		label: "Casual",
		description: "Friendly and conversational",
		icon: faComments,
		example: '"Hey! Let me show you how easy this is..."',
	},
	{
		value: "educational",
		label: "Educational",
		description: "Clear explanations with context",
		icon: faBookOpen,
		example: '"First, we\'ll understand why this matters..."',
	},
	{
		value: "enthusiastic",
		label: "Enthusiastic",
		description: "Energetic and engaging",
		icon: faFaceSmileBeam,
		example: '"You\'re going to love this awesome feature!"',
	},
];

export function ToneStep({ value, onChange }: ToneStepProps) {
	return (
		<div className="flex flex-col gap-6 w-full">
			<div className="flex flex-col gap-2 text-center">
				<h2 className="text-xl font-semibold text-gray-12">
					What tone should the narration have?
				</h2>
				<p className="text-gray-11">
					Choose the voice style that best matches your audience.
				</p>
			</div>

			<div className="grid gap-3 sm:grid-cols-2">
				{TONE_OPTIONS.map((option) => (
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
							<div>
								<span className="font-medium">{option.label}</span>
								<p
									className={classNames(
										"text-sm",
										value === option.value ? "text-gray-1/80" : "text-gray-10",
									)}
								>
									{option.description}
								</p>
							</div>
						</div>
						<p
							className={classNames(
								"text-xs italic",
								value === option.value ? "text-gray-1/60" : "text-gray-9",
							)}
						>
							{option.example}
						</p>
					</button>
				))}
			</div>
		</div>
	);
}
