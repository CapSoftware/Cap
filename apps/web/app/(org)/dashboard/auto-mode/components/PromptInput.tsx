"use client";

import { Button } from "@cap/ui";
import { classNames } from "@cap/utils";
import { faWandMagicSparkles } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useCallback, useState } from "react";

interface PromptInputProps {
	onSubmit: (prompt: string) => void;
	isLoading?: boolean;
	disabled?: boolean;
}

export function PromptInput({
	onSubmit,
	isLoading = false,
	disabled = false,
}: PromptInputProps) {
	const [prompt, setPrompt] = useState("");

	const handleSubmit = useCallback(() => {
		const trimmedPrompt = prompt.trim();
		if (trimmedPrompt) {
			onSubmit(trimmedPrompt);
		}
	}, [prompt, onSubmit]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === "Enter" && e.metaKey) {
				e.preventDefault();
				handleSubmit();
			}
		},
		[handleSubmit],
	);

	const isSubmitDisabled = disabled || isLoading || !prompt.trim();

	return (
		<div className="flex flex-col items-center w-full max-w-2xl gap-4">
			<div
				className={classNames(
					"w-full p-1 rounded-xl border transition-colors duration-200",
					disabled
						? "bg-gray-3 border-gray-4"
						: "bg-gray-2 border-gray-4 focus-within:border-gray-6 focus-within:ring-1 focus-within:ring-gray-6",
				)}
			>
				<textarea
					placeholder="What would you like to record? e.g., 'Create a demo of our checkout flow showing how easy it is to complete a purchase'"
					className={classNames(
						"w-full h-32 p-4 text-base bg-transparent border-0 resize-none text-gray-12 placeholder:text-gray-9 focus:outline-none focus:ring-0",
						disabled && "cursor-not-allowed",
					)}
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					onKeyDown={handleKeyDown}
					disabled={disabled}
					aria-label="Recording prompt"
				/>
			</div>

			<div className="flex items-center justify-between w-full gap-4">
				<span className="text-sm text-gray-10">
					{!disabled && "Press ⌘+Enter to submit"}
				</span>

				<Button
					size="lg"
					variant="primary"
					onClick={handleSubmit}
					disabled={isSubmitDisabled}
					spinner={isLoading}
				>
					<FontAwesomeIcon
						icon={faWandMagicSparkles}
						className="w-4 h-4 mr-2"
					/>
					Start Auto Recording
				</Button>
			</div>
		</div>
	);
}
