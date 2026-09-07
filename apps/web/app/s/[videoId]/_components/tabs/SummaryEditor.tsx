"use client";

import { Button } from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Plus, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { editAiContent } from "@/actions/videos/edit-ai-content";
import type { VideoStatusResult } from "@/actions/videos/get-status";
import {
	type AiContent,
	chaptersEqual,
	formatChapterTime,
	MAX_CHAPTER_TITLE_LENGTH,
	MAX_CHAPTERS,
	MAX_SUMMARY_LENGTH,
	parseChapterTime,
	validateAiContent,
} from "@/lib/ai-content";

export type SummaryEditingState = "clean" | "dirty" | "saving";

export function SummaryEditor({
	videoId,
	initialContent,
	duration,
	onClose,
	onEditingStateChange,
}: {
	videoId: Video.VideoId;
	initialContent: AiContent;
	duration?: number | null;
	onClose: (saved: boolean) => void;
	onEditingStateChange?: (state: SummaryEditingState) => void;
}) {
	const queryClient = useQueryClient();
	const id = useId();
	const [expected] = useState(initialContent);
	const [summary, setSummary] = useState(initialContent.summary);
	const nextId = useRef(initialContent.chapters.length);
	const [chapters, setChapters] = useState<
		{ id: number; title: string; time: string; originalStart?: number }[]
	>(() =>
		initialContent.chapters.map((chapter, index) => ({
			id: index,
			title: chapter.title,
			time: formatChapterTime(chapter.start),
			originalStart: chapter.start,
		})),
	);
	const [isSaving, setIsSaving] = useState(false);
	const savingRef = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const summaryRef = useRef<HTMLTextAreaElement>(null);
	const value: AiContent = {
		summary: summary.trim(),
		chapters: chapters.map((chapter) => ({
			title: chapter.title.trim(),
			start: chapter.originalStart ?? parseChapterTime(chapter.time),
		})),
	};
	const dirty =
		value.summary !== expected.summary ||
		!chaptersEqual(value.chapters, expected.chapters);
	const validationError = validateAiContent(value, duration);

	useEffect(() => {
		summaryRef.current?.focus();
	}, []);

	useEffect(() => {
		onEditingStateChange?.(isSaving ? "saving" : dirty ? "dirty" : "clean");
		return () => onEditingStateChange?.("clean");
	}, [dirty, isSaving, onEditingStateChange]);

	useEffect(() => {
		if (!dirty) return;
		const handleUnload = (event: BeforeUnloadEvent) => event.preventDefault();
		window.addEventListener("beforeunload", handleUnload);
		return () => window.removeEventListener("beforeunload", handleUnload);
	}, [dirty]);

	const save = async () => {
		if (savingRef.current || validationError || !dirty) return;
		savingRef.current = true;
		setIsSaving(true);
		setError(null);
		try {
			const queryKey = ["videoStatus", videoId];
			await queryClient.cancelQueries({ queryKey });
			const result = await editAiContent(videoId, { value, expected });
			if (!result.success) {
				setError(result.message);
				void queryClient.invalidateQueries({ queryKey });
				return;
			}
			await queryClient.cancelQueries({ queryKey });
			queryClient.setQueryData<VideoStatusResult>(queryKey, (current) =>
				current ? { ...current, ...result.data } : current,
			);
			void queryClient.invalidateQueries({ queryKey });
			onClose(true);
		} catch {
			setError("Couldn't save your changes. Please try again.");
		} finally {
			savingRef.current = false;
			setIsSaving(false);
		}
	};

	return (
		<form
			className="flex flex-col h-full min-h-0"
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
			onKeyDown={(event) => {
				if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
					event.preventDefault();
					void save();
				}
			}}
		>
			<div className="overflow-y-auto flex-1 p-4 space-y-6">
				<div className="space-y-2">
					<label
						htmlFor={`${id}-summary`}
						className="block text-sm font-medium text-gray-12"
					>
						Summary
					</label>
					<p id={`${id}-summary-help`} className="text-xs text-gray-10">
						Edit the summary below. Markdown formatting is supported.
					</p>
					<textarea
						ref={summaryRef}
						id={`${id}-summary`}
						aria-describedby={`${id}-summary-help`}
						value={summary}
						onChange={(event) => setSummary(event.target.value)}
						maxLength={MAX_SUMMARY_LENGTH}
						disabled={isSaving}
						rows={10}
						className="w-full min-h-40 p-3 text-sm leading-relaxed text-gray-12 bg-gray-1 border border-gray-5 rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-blue-9 disabled:opacity-60"
					/>
				</div>
				<fieldset disabled={isSaving} className="space-y-3">
					<legend className="text-sm font-medium text-gray-12">Chapters</legend>
					<p id={`${id}-time-help`} className="text-xs text-gray-10">
						Use MM:SS or HH:MM:SS. Keep timestamps in order.
					</p>
					{chapters.map((chapter, index) => (
						<div key={chapter.id} className="flex gap-2 items-start">
							<div className="w-24 shrink-0">
								<label htmlFor={`${id}-time-${chapter.id}`} className="sr-only">
									Chapter {index + 1} timestamp
								</label>
								<input
									id={`${id}-time-${chapter.id}`}
									aria-describedby={`${id}-time-help`}
									value={chapter.time}
									onChange={(event) =>
										setChapters((current) =>
											current.map((item) =>
												item.id === chapter.id
													? {
															...item,
															time: event.target.value,
															originalStart: undefined,
														}
													: item,
											),
										)
									}
									placeholder="00:00"
									className="w-full px-2 py-2 text-sm font-mono bg-gray-1 border border-gray-5 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-9"
								/>
							</div>
							<div className="flex-1 min-w-0">
								<label
									htmlFor={`${id}-title-${chapter.id}`}
									className="sr-only"
								>
									Chapter {index + 1} title
								</label>
								<input
									id={`${id}-title-${chapter.id}`}
									value={chapter.title}
									onChange={(event) =>
										setChapters((current) =>
											current.map((item) =>
												item.id === chapter.id
													? { ...item, title: event.target.value }
													: item,
											),
										)
									}
									maxLength={MAX_CHAPTER_TITLE_LENGTH}
									placeholder="Chapter title"
									className="w-full px-2 py-2 text-sm bg-gray-1 border border-gray-5 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-9"
								/>
							</div>
							<button
								type="button"
								aria-label={`Remove chapter ${index + 1}`}
								onClick={() =>
									setChapters((current) =>
										current.filter((item) => item.id !== chapter.id),
									)
								}
								className="p-2 text-gray-10 rounded-lg hover:bg-gray-3 hover:text-red-9 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-9"
							>
								<Trash2 className="size-4" />
							</button>
						</div>
					))}
					<Button
						type="button"
						variant="gray"
						size="sm"
						disabled={chapters.length >= MAX_CHAPTERS || isSaving}
						onClick={() => {
							const chapterId = nextId.current++;
							setChapters((current) => [
								...current,
								{
									id: chapterId,
									title: "",
									time: current.length ? "" : "00:00",
									originalStart: undefined,
								},
							]);
							requestAnimationFrame(() =>
								document.getElementById(`${id}-title-${chapterId}`)?.focus(),
							);
						}}
					>
						<Plus className="mr-1.5 size-4" /> Add chapter
					</Button>
				</fieldset>
			</div>
			<div className="shrink-0 p-4 space-y-3 border-t border-gray-4 bg-gray-1">
				{(error || validationError) && (
					<p role="alert" className="text-xs text-red-10">
						{error || validationError}
					</p>
				)}
				<div className="flex justify-end gap-2">
					<Button
						type="button"
						variant="gray"
						size="sm"
						disabled={isSaving}
						onClick={() => onClose(false)}
					>
						Cancel
					</Button>
					<Button
						type="submit"
						variant="primary"
						size="sm"
						disabled={isSaving || !dirty || !!validationError}
					>
						{isSaving && (
							<LoaderCircle className="mr-1.5 size-4 animate-spin" />
						)}
						{isSaving ? "Saving…" : "Save changes"}
					</Button>
				</div>
			</div>
		</form>
	);
}
