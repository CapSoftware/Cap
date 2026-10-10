import ReactMarkdown from "react-markdown";
import { formatTimeMinutes } from "./utils/transcript-utils";

type AiGenerationStatus =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED";

interface SummaryChaptersProps {
	isSummaryDisabled: boolean;
	areChaptersDisabled: boolean;
	handleSeek: (time: number) => void;
	aiData: {
		title: string | null;
		summary: string | null;
		chapters:
			| {
					title: string;
					start: number;
			  }[]
			| null;
		aiGenerationStatus: AiGenerationStatus | null;
	};
	aiLoading: boolean;
}

const SummaryChapters = ({
	isSummaryDisabled,
	areChaptersDisabled,
	handleSeek,
	aiData,
	aiLoading,
}: SummaryChaptersProps) => {
	const hasSummary = !isSummaryDisabled && !!aiData?.summary;
	const hasChapters =
		!areChaptersDisabled &&
		Array.isArray(aiData?.chapters) &&
		aiData.chapters.length > 0;

	if (aiLoading || (!hasSummary && !hasChapters)) return null;

	return (
		<div className="p-4 bg-gray-1 rounded-2xl border border-gray-3">
			{hasSummary && (
				<>
					<h3 className="text-lg font-medium">Summary</h3>
					<div className="text-sm prose prose-sm prose-gray max-w-none prose-p:my-2 prose-ul:my-2 prose-li:my-0 prose-strong:text-gray-12">
						<ReactMarkdown>{aiData.summary}</ReactMarkdown>
					</div>
				</>
			)}

			{hasChapters && (
				<div className={hasSummary ? "mt-6" : ""}>
					<h3 className="mb-2 text-lg font-medium">Chapters</h3>
					<div className="divide-y">
						{aiData.chapters?.map((chapter) => (
							<button
								type="button"
								key={chapter.start}
								className="flex items-center w-full p-2 text-left rounded transition-colors hover:bg-gray-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
								onClick={() => handleSeek(chapter.start)}
							>
								<span className="w-16 text-xs text-gray-10">
									{formatTimeMinutes(chapter.start)}
								</span>
								<span className="ml-2 text-sm">{chapter.title}</span>
							</button>
						))}
					</div>
				</div>
			)}
		</div>
	);
};

export default SummaryChapters;
