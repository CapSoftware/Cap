"use client";

import { faWandMagicSparkles } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useCallback, useState } from "react";
import { PromptInput } from "./components";

interface AutoModeProps {
	userId: string;
}

type FlowState = "prompt" | "questionnaire";

export function AutoMode({ userId: _userId }: AutoModeProps) {
	const [flowState, setFlowState] = useState<FlowState>("prompt");
	const [initialPrompt, setInitialPrompt] = useState("");

	const handlePromptSubmit = useCallback((prompt: string) => {
		setInitialPrompt(prompt);
		setFlowState("questionnaire");
	}, []);

	return (
		<div className="flex flex-col items-center justify-center w-full min-h-[60vh]">
			<div className="flex flex-col items-center w-full max-w-2xl text-center">
				<div className="flex items-center justify-center w-16 h-16 mb-6 rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600">
					<FontAwesomeIcon
						icon={faWandMagicSparkles}
						className="w-8 h-8 text-white"
					/>
				</div>

				<h1 className="mb-3 text-3xl font-semibold text-gray-12">Auto Mode</h1>

				<p className="mb-8 text-lg text-gray-11">
					Describe what you want to record and let AI create a polished screen
					recording with automated narration.
				</p>

				{flowState === "prompt" && (
					<PromptInput onSubmit={handlePromptSubmit} />
				)}

				{flowState === "questionnaire" && (
					<div className="flex flex-col items-center gap-4 p-6 border rounded-xl bg-gray-2 border-gray-4">
						<p className="text-gray-11">Questionnaire coming soon...</p>
						<p className="text-sm text-gray-10">
							Your prompt: &quot;{initialPrompt}&quot;
						</p>
						<button
							type="button"
							onClick={() => setFlowState("prompt")}
							className="text-sm text-blue-500 hover:underline"
						>
							Go back
						</button>
					</div>
				)}
			</div>
		</div>
	);
}
