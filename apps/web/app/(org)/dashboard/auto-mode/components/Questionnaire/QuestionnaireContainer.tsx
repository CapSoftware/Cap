"use client";

import { Button } from "@cap/ui";
import {
	faArrowLeft,
	faArrowRight,
	faCheck,
	faForward,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useCallback } from "react";
import {
	type QuestionnaireAnswers,
	useQuestionnaireFlow,
} from "../../hooks/useQuestionnaireFlow";
import { ActionsStep } from "./ActionsStep";
import { ContextStep } from "./ContextStep";
import { DurationStep } from "./DurationStep";
import { FocusStep } from "./FocusStep";
import { StepIndicator } from "./StepIndicator";
import { ToneStep } from "./ToneStep";
import { UrlStep } from "./UrlStep";

interface QuestionnaireContainerProps {
	initialPrompt: string;
	onComplete: (answers: QuestionnaireAnswers) => void;
	onCancel: () => void;
}

export function QuestionnaireContainer({
	initialPrompt,
	onComplete,
	onCancel,
}: QuestionnaireContainerProps) {
	const questionnaire = useQuestionnaireFlow({
		initialPrompt,
		onComplete,
	});

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === "Enter" && e.metaKey && questionnaire.canGoNext) {
				e.preventDefault();
				questionnaire.goNext();
			}
		},
		[questionnaire],
	);

	const renderCurrentStep = () => {
		switch (questionnaire.currentStep) {
			case "url":
				return (
					<UrlStep
						value={questionnaire.answers.targetUrl}
						onChange={(value) => questionnaire.setAnswer("targetUrl", value)}
					/>
				);
			case "focus":
				return (
					<FocusStep
						value={questionnaire.answers.recordingFocus}
						onChange={(value) =>
							questionnaire.setAnswer("recordingFocus", value)
						}
					/>
				);
			case "actions":
				return (
					<ActionsStep
						value={questionnaire.answers.keyActions}
						onChange={(value) => questionnaire.setAnswer("keyActions", value)}
					/>
				);
			case "tone":
				return (
					<ToneStep
						value={questionnaire.answers.narrationTone}
						onChange={(value) =>
							questionnaire.setAnswer("narrationTone", value)
						}
					/>
				);
			case "duration":
				return (
					<DurationStep
						value={questionnaire.answers.durationPreference}
						onChange={(value) =>
							questionnaire.setAnswer("durationPreference", value)
						}
					/>
				);
			case "context":
				return (
					<ContextStep
						value={questionnaire.answers.additionalContext}
						onChange={(value) =>
							questionnaire.setAnswer("additionalContext", value)
						}
					/>
				);
			default:
				return null;
		}
	};

	const handleSubmit = useCallback(
		(e: React.FormEvent) => {
			e.preventDefault();
			if (questionnaire.canGoNext) {
				questionnaire.goNext();
			}
		},
		[questionnaire],
	);

	return (
		<form
			className="flex flex-col w-full max-w-2xl"
			onKeyDown={handleKeyDown}
			onSubmit={handleSubmit}
			aria-label="Auto Mode questionnaire"
		>
			<StepIndicator
				currentStep={questionnaire.currentStep}
				currentStepIndex={questionnaire.currentStepIndex}
				totalSteps={questionnaire.totalSteps}
				onStepClick={questionnaire.goToStep}
			/>

			<div className="p-6 border rounded-xl bg-gray-2 border-gray-4">
				<div className="mb-2 text-sm text-center text-gray-10">
					Your prompt: &quot;{initialPrompt.slice(0, 60)}
					{initialPrompt.length > 60 ? "..." : ""}&quot;
				</div>

				<div className="min-h-[300px] flex items-center justify-center py-4">
					{renderCurrentStep()}
				</div>

				<div className="flex items-center justify-between pt-4 mt-4 border-t border-gray-4">
					<div className="flex gap-2">
						{questionnaire.isFirstStep ? (
							<Button variant="outline" size="sm" onClick={onCancel}>
								<FontAwesomeIcon icon={faArrowLeft} className="w-3 h-3 mr-2" />
								Back to prompt
							</Button>
						) : (
							<Button
								variant="outline"
								size="sm"
								onClick={questionnaire.goBack}
								disabled={questionnaire.isFirstStep}
							>
								<FontAwesomeIcon icon={faArrowLeft} className="w-3 h-3 mr-2" />
								Back
							</Button>
						)}
					</div>

					<div className="flex gap-2">
						{questionnaire.stepConfig.skippable && (
							<Button variant="outline" size="sm" onClick={questionnaire.skip}>
								Skip
								<FontAwesomeIcon icon={faForward} className="w-3 h-3 ml-2" />
							</Button>
						)}

						<Button
							variant="primary"
							size="sm"
							onClick={questionnaire.goNext}
							disabled={!questionnaire.canGoNext}
						>
							{questionnaire.isLastStep ? (
								<>
									<FontAwesomeIcon icon={faCheck} className="w-3 h-3 mr-2" />
									Finish
								</>
							) : (
								<>
									Next
									<FontAwesomeIcon
										icon={faArrowRight}
										className="w-3 h-3 ml-2"
									/>
								</>
							)}
						</Button>
					</div>
				</div>

				<div className="mt-3 text-xs text-center text-gray-9">
					Press ⌘+Enter to continue
				</div>
			</div>
		</form>
	);
}
