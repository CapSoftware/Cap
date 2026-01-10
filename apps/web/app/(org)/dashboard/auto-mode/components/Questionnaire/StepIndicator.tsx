"use client";

import { classNames } from "@cap/utils";
import type { QuestionnaireStep } from "../../hooks/useQuestionnaireFlow";

interface StepIndicatorProps {
	currentStep: QuestionnaireStep;
	currentStepIndex: number;
	totalSteps: number;
	onStepClick?: (step: QuestionnaireStep) => void;
}

const STEP_LABELS: Record<QuestionnaireStep, string> = {
	url: "URL",
	focus: "Focus",
	actions: "Actions",
	tone: "Tone",
	duration: "Duration",
	context: "Context",
};

const STEP_ORDER: QuestionnaireStep[] = [
	"url",
	"focus",
	"actions",
	"tone",
	"duration",
	"context",
];

export function StepIndicator({
	currentStepIndex,
	totalSteps,
	onStepClick,
}: StepIndicatorProps) {
	return (
		<div className="flex items-center justify-center w-full gap-2 mb-8">
			{STEP_ORDER.map((step, index) => {
				const isActive = index === currentStepIndex;
				const isCompleted = index < currentStepIndex;
				const isClickable = onStepClick && index <= currentStepIndex;

				return (
					<button
						key={step}
						type="button"
						onClick={() => isClickable && onStepClick(step)}
						disabled={!isClickable}
						className={classNames(
							"flex items-center gap-2 px-3 py-1.5 rounded-full text-sm transition-all duration-200",
							isActive && "bg-gray-12 text-gray-1",
							isCompleted && "bg-gray-4 text-gray-11 hover:bg-gray-5",
							!isActive &&
								!isCompleted &&
								"bg-gray-3 text-gray-9 cursor-default",
							isClickable && !isActive && "cursor-pointer",
						)}
						aria-current={isActive ? "step" : undefined}
					>
						<span
							className={classNames(
								"flex items-center justify-center w-5 h-5 text-xs font-medium rounded-full",
								isActive && "bg-gray-1 text-gray-12",
								isCompleted && "bg-gray-6 text-gray-11",
								!isActive && !isCompleted && "bg-gray-4 text-gray-9",
							)}
						>
							{isCompleted ? "✓" : index + 1}
						</span>
						<span className="hidden sm:inline">{STEP_LABELS[step]}</span>
					</button>
				);
			})}
			<span className="ml-2 text-sm text-gray-10">
				{currentStepIndex + 1}/{totalSteps}
			</span>
		</div>
	);
}
