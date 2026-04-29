"use client";

import { Button } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import {
	faRectangleList,
	faRotateRight,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useState } from "react";
import ReactMarkdown from "react-markdown";

type AiGenerationStatus =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED";

interface Chapter {
	title: string;
	start: number;
}

interface SummaryProps {
	videoId: Video.VideoId;
	onSeek?: (time: number) => void;
	initialAiData?: {
		title?: string | null;
		summary?: string | null;
		chapters?: Chapter[] | null;
		aiGenerationStatus?: AiGenerationStatus | null;
	};
	aiGenerationEnabled?: boolean;
	isSummaryDisabled?: boolean;
	ownerIsPro: boolean;
}

const formatTime = (time: number) => {
	const minutes = Math.floor(time / 60);
	const seconds = Math.floor(time % 60);
	return `${minutes.toString().padStart(2, "0")}:${seconds
		.toString()
		.padStart(2, "0")}`;
};

const SkeletonLoader = () => (
	<div className="p-4 space-y-6 animate-pulse">
		<div>
			<div className="mb-3 w-24 h-6 bg-gray-200 rounded"></div>
			<div className="mb-4 w-32 h-3 bg-gray-100 rounded"></div>
			<div className="space-y-3">
				<div className="w-full h-4 bg-gray-200 rounded"></div>
				<div className="w-5/6 h-4 bg-gray-200 rounded"></div>
				<div className="w-4/5 h-4 bg-gray-200 rounded"></div>
				<div className="w-full h-4 bg-gray-200 rounded"></div>
				<div className="w-3/4 h-4 bg-gray-200 rounded"></div>
			</div>
		</div>

		<div>
			<div className="mb-4 w-24 h-6 bg-gray-200 rounded"></div>
			<div className="space-y-2">
				{[1, 2, 3, 4].map((i) => (
					<div key={i} className="flex items-center p-2">
						<div className="mr-3 w-12 h-4 bg-gray-200 rounded"></div>
						<div className="flex-1 h-4 bg-gray-200 rounded"></div>
					</div>
				))}
			</div>
		</div>
	</div>
);

export const Summary: React.FC<SummaryProps> = ({
	videoId,
	onSeek,
	initialAiData,
	isSummaryDisabled = false,
	aiGenerationEnabled = false,
	ownerIsPro,
}) => {
	const [isRetrying, setIsRetrying] = useState(false);
	const [retryError, setRetryError] = useState<string | null>(null);

	const aiData = initialAiData || null;
	const aiGenerationStatus = aiData?.aiGenerationStatus;

	const isLoading =
		aiGenerationEnabled &&
		(aiGenerationStatus === "QUEUED" || aiGenerationStatus === "PROCESSING") &&
		!aiData?.summary &&
		!aiData?.chapters?.length;

	const canRetry =
		aiGenerationStatus === "ERROR" || aiGenerationStatus === "SKIPPED";

	const handleSeek = (time: number) => {
		if (onSeek) {
			onSeek(time);
		}
	};

	const handleRetry = async () => {
		setIsRetrying(true);
		setRetryError(null);

		try {
			const response = await fetch(`/api/videos/${videoId}/retry-ai`, {
				method: "POST",
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.error || "Failed to retry AI generation");
			}

			window.location.reload();
		} catch (error) {
			setRetryError(
				error instanceof Error
					? error.message
					: "Failed to retry AI generation",
			);
		} finally {
			setIsRetrying(false);
		}
	};

	if (!ownerIsPro) {
		return (
			<div className="flex flex-col justify-center items-center p-8 h-full text-center">
				<div className="space-y-4 max-w-sm">
					<div className="p-6 bg-gradient-to-br from-blue-50 to-purple-50 rounded-lg border border-blue-100">
						<div className="mb-3 text-blue-600">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								className="mx-auto w-12 h-12"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={1.5}
									d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z"
								/>
							</svg>
						</div>
						<h3 className="mb-2 text-lg font-semibold text-gray-900">
							Unlock Cap AI
						</h3>
						<p className="mb-4 text-sm leading-relaxed text-gray-600">
							Upgrade to Cap Pro to access AI-powered features including
							automatic titles, video summaries, and intelligent chapter
							generation.
						</p>
						<Button
							href="/pricing"
							variant="primary"
							size="sm"
							className="mx-auto"
						>
							Upgrade to Cap Pro
						</Button>
					</div>
				</div>
			</div>
		);
	}

	if (isSummaryDisabled) return null;

	if (isLoading) {
		return (
			<div className="flex flex-col h-full">
				<div className="overflow-y-auto flex-1">
					<SkeletonLoader />
				</div>
			</div>
		);
	}

	if (!aiData?.summary && !aiData?.chapters?.length) {
		return (
			<div className="flex flex-col justify-center items-center p-8 h-full text-center">
				<FontAwesomeIcon
					icon={faRectangleList}
					className="mb-4 text-gray-12 size-8"
				/>
				<div className="space-y-1">
					<h3 className="text-base font-medium text-gray-12">
						{aiGenerationStatus === "ERROR"
							? "AI generation failed"
							: aiGenerationStatus === "SKIPPED"
								? "AI generation skipped"
								: "No summary available"}
					</h3>
					<p className="text-sm text-gray-10">
						{aiGenerationStatus === "ERROR"
							? "There was an error generating the AI summary."
							: aiGenerationStatus === "SKIPPED"
								? "The video was too short or had no speech detected."
								: "AI summary has not been generated for this video yet."}
					</p>
					{canRetry && (
						<div className="pt-4">
							<Button
								variant="gray"
								size="sm"
								onClick={handleRetry}
								disabled={isRetrying}
							>
								<FontAwesomeIcon
									icon={faRotateRight}
									className={`mr-2 ${isRetrying ? "animate-spin" : ""}`}
								/>
								{isRetrying ? "Retrying..." : "Retry AI Generation"}
							</Button>
							{retryError && (
								<p className="mt-2 text-sm text-red-500">{retryError}</p>
							)}
						</div>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			<div className="overflow-y-auto flex-1">
				<div className="p-4 space-y-6">
					{aiData?.summary && (
						<div>
							<h3 className="text-lg font-medium">Summary</h3>
							<div className="mb-2">
								<span className="text-xs font-semibold text-gray-8">
									Generated by Cap AI
								</span>
							</div>
							<div className="text-sm text-gray-12 prose prose-sm prose-gray max-w-none prose-p:my-2 prose-ul:my-2 prose-li:my-0 prose-strong:text-gray-12">
								<ReactMarkdown>{aiData.summary}</ReactMarkdown>
							</div>
						</div>
					)}

					{aiData?.chapters && aiData.chapters.length > 0 && (
						<div className={aiData?.summary ? "mt-6" : ""}>
							<h3 className="mb-2 text-lg font-medium">Chapters</h3>
							<div className="divide-y">
								{aiData.chapters.map((chapter) => (
									<div
										key={chapter.start}
										className="flex items-center p-2 rounded transition-colors cursor-pointer hover:bg-gray-100"
										onClick={() => handleSeek(chapter.start)}
									>
										<span className="w-16 text-xs text-gray-500">
											{formatTime(chapter.start)}
										</span>
										<span className="ml-2 text-sm">{chapter.title}</span>
									</div>
								))}
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
};
