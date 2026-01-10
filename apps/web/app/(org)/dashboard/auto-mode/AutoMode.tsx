"use client";

import { faWandMagicSparkles } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useCallback, useState } from "react";
import { PromptInput, QuestionnaireContainer } from "./components";
import type { QuestionnaireAnswers } from "./hooks/useQuestionnaireFlow";

interface AutoModeProps {
	userId: string;
}

type FlowState = "prompt" | "questionnaire" | "generating";

export function AutoMode({ userId: _userId }: AutoModeProps) {
	const [flowState, setFlowState] = useState<FlowState>("prompt");
	const [initialPrompt, setInitialPrompt] = useState("");

	const handlePromptSubmit = useCallback((prompt: string) => {
		setInitialPrompt(prompt);
		setFlowState("questionnaire");
	}, []);

	const handleQuestionnaireComplete = useCallback(
		(answers: QuestionnaireAnswers) => {
			console.log("Questionnaire completed:", {
				prompt: initialPrompt,
				answers,
			});
			setFlowState("generating");
		},
		[initialPrompt],
	);

	const handleQuestionnaireCancel = useCallback(() => {
		setFlowState("prompt");
	}, []);

	return (
		<div className="flex flex-col items-center justify-center w-full min-h-[60vh]">
			<div className="flex flex-col items-center w-full max-w-2xl text-center">
				{flowState === "prompt" && (
					<>
						<div className="flex items-center justify-center w-16 h-16 mb-6 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600">
							<FontAwesomeIcon
								icon={faWandMagicSparkles}
								className="w-8 h-8 text-white"
							/>
						</div>

						<h1 className="mb-3 text-3xl font-semibold text-gray-12">
							Auto Mode
						</h1>

						<p className="mb-8 text-lg text-gray-11">
							Describe what you want to record and let AI create a polished
							screen recording with automated narration.
						</p>

						<PromptInput onSubmit={handlePromptSubmit} />
					</>
				)}

				{flowState === "questionnaire" && (
					<QuestionnaireContainer
						initialPrompt={initialPrompt}
						onComplete={handleQuestionnaireComplete}
						onCancel={handleQuestionnaireCancel}
					/>
				)}

				{flowState === "generating" && (
					<div className="flex flex-col items-center gap-4 p-8 border rounded-xl bg-gray-2 border-gray-4">
						<div className="flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 animate-pulse">
							<FontAwesomeIcon
								icon={faWandMagicSparkles}
								className="w-6 h-6 text-white"
							/>
						</div>
						<p className="text-lg font-medium text-gray-12">
							Generating your recording plan...
						</p>
						<p className="text-sm text-gray-10">
							This will be implemented in future tasks
						</p>
						<button
							type="button"
							onClick={() => setFlowState("prompt")}
							className="mt-2 text-sm text-blue-500 hover:underline"
						>
							Start over
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
