"use client";

import { Button } from "@cap/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLiveTranscript } from "hooks/use-live-transcript";
import { useInvalidateTranscript, useTranscript } from "hooks/use-transcript";
import {
	Check,
	ChevronDown,
	Copy,
	Download,
	Edit3,
	Globe,
	LoaderCircle,
	MessageSquare,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { editTranscriptEntry } from "@/actions/videos/edit-transcript";
import {
	type LanguageCode,
	SUPPORTED_LANGUAGES,
} from "@/actions/videos/translation-languages";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { formatTranscriptAsParagraphs } from "@/lib/transcript-text";
import { normalizeTranscriptCueText } from "@/lib/transcript-vtt";
import type { VideoData } from "../../types";
import { type CaptionLanguage, useCaptionContext } from "../CaptionContext";

interface TranscriptProps {
	data: VideoData;
	onSeek?: (time: number) => void;
	user?: { id: string } | null;
}

interface TranscriptEntry {
	id: number;
	timestamp: string;
	text: string;
	startTime: number;
	endTime: number;
}

const parseVTT = (vttContent: string): TranscriptEntry[] => {
	const lines = vttContent.split("\n");
	const entries: TranscriptEntry[] = [];
	let currentEntry: Partial<TranscriptEntry & { startTime: number }> = {};
	let currentId = 0;

	const timeToSeconds = (timeStr: string): number | null => {
		const parts = timeStr.split(":");
		if (parts.length !== 3) return null;

		const [hoursStr, minutesStr, secondsStr] = parts;
		if (!hoursStr || !minutesStr || !secondsStr) return null;

		const hours = parseInt(hoursStr, 10);
		const minutes = parseInt(minutesStr, 10);
		const seconds = parseInt(secondsStr, 10);

		if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds))
			return null;

		return hours * 3600 + minutes * 60 + seconds;
	};

	const parseTimestamp = (
		timestamp: string,
	): { mm_ss: string; totalSeconds: number } | null => {
		const parts = timestamp.split(":");
		if (parts.length !== 3) return null;

		const [hoursStr, minutesStr, secondsWithMs] = parts;
		if (!hoursStr || !minutesStr || !secondsWithMs) return null;

		const secondsPart = secondsWithMs.split(".")[0];
		if (!secondsPart) return null;

		const totalSeconds = timeToSeconds(
			`${hoursStr}:${minutesStr}:${secondsPart}`,
		);
		if (totalSeconds === null) return null;

		const fractionPart = secondsWithMs.split(".")[1];
		const fraction = fractionPart ? Number(`0.${fractionPart}`) : 0;

		return {
			mm_ss: `${minutesStr}:${secondsPart}`,
			totalSeconds: totalSeconds + (Number.isFinite(fraction) ? fraction : 0),
		};
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line?.trim()) continue;

		const trimmedLine = line.trim();

		if (trimmedLine === "WEBVTT") continue;

		if (/^\d+$/.test(trimmedLine)) {
			currentId = parseInt(trimmedLine, 10);
			continue;
		}

		if (trimmedLine.includes("-->")) {
			const [startTimeStr, endTimeStr] = trimmedLine.split(" --> ");
			if (!startTimeStr || !endTimeStr) continue;

			const startTimestamp = parseTimestamp(startTimeStr);
			const endTimestamp = parseTimestamp(endTimeStr);
			if (startTimestamp) {
				currentEntry = {
					id: currentId,
					timestamp: startTimestamp.mm_ss,
					startTime: startTimestamp.totalSeconds,
					endTime: endTimestamp?.totalSeconds ?? startTimestamp.totalSeconds,
				};
			}
			continue;
		}

		if (currentEntry.timestamp && !currentEntry.text) {
			const textContent =
				trimmedLine.startsWith('"') && trimmedLine.endsWith('"')
					? trimmedLine.slice(1, -1)
					: trimmedLine;

			currentEntry.text = textContent;
			if (
				currentEntry.id !== undefined &&
				currentEntry.timestamp &&
				currentEntry.text &&
				currentEntry.startTime !== undefined
			) {
				entries.push(currentEntry as TranscriptEntry);
			}
			currentEntry = {};
		}
	}

	const sortedEntries = entries.sort((a, b) => a.startTime - b.startTime);
	return sortedEntries;
};

export const Transcript: React.FC<TranscriptProps> = ({ data, onSeek }) => {
	const user = useCurrentUser();
	const queryClient = useQueryClient();
	const captionContext = useCaptionContext();
	const [transcriptData, setTranscriptData] = useState<TranscriptEntry[]>([]);
	const [selectedEntry, setSelectedEntry] = useState<number | null>(null);
	const [retryTriggered, setRetryTriggered] = useState(false);
	const [editingEntry, setEditingEntry] = useState<number | null>(null);
	const [editText, setEditText] = useState<string>("");
	const [isSaving, setIsSaving] = useState(false);
	const [isCopying, setIsCopying] = useState(false);
	const [copyPressed, setCopyPressed] = useState(false);
	const [downloadPressed, setDownloadPressed] = useState(false);
	const [showLanguageMenu, setShowLanguageMenu] = useState(false);
	const [showDownloadMenu, setShowDownloadMenu] = useState(false);
	const [showCopyMenu, setShowCopyMenu] = useState(false);
	const languageMenuRef = useRef<HTMLDivElement>(null);
	const downloadMenuRef = useRef<HTMLDivElement>(null);
	const copyMenuRef = useRef<HTMLDivElement>(null);

	const selectedLanguage =
		captionContext.selectedLanguage === "off"
			? "original"
			: captionContext.selectedLanguage;
	const isTranslating = captionContext.isTranslating;
	const _translatedContent = captionContext.translatedVttContent;

	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (
				languageMenuRef.current &&
				!languageMenuRef.current.contains(event.target as Node)
			) {
				setShowLanguageMenu(false);
			}
		};

		if (showLanguageMenu) {
			document.addEventListener("mousedown", handleClickOutside);
		}

		return () => {
			document.removeEventListener("mousedown", handleClickOutside);
		};
	}, [showLanguageMenu]);

	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (
				downloadMenuRef.current &&
				!downloadMenuRef.current.contains(event.target as Node)
			) {
				setShowDownloadMenu(false);
			}
		};

		if (showDownloadMenu) {
			document.addEventListener("mousedown", handleClickOutside);
		}

		return () => {
			document.removeEventListener("mousedown", handleClickOutside);
		};
	}, [showDownloadMenu]);

	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (
				copyMenuRef.current &&
				!copyMenuRef.current.contains(event.target as Node)
			) {
				setShowCopyMenu(false);
			}
		};

		if (showCopyMenu) {
			document.addEventListener("mousedown", handleClickOutside);
		}

		return () => {
			document.removeEventListener("mousedown", handleClickOutside);
		};
	}, [showCopyMenu]);

	const {
		data: transcriptContent,
		isLoading: isTranscriptLoading,
		error: transcriptError,
	} = useTranscript(data.id, data.transcriptionStatus);

	const isLiveTranscriptEnabled =
		data.source?.type === "desktopSegments" &&
		data.metadata?.liveTranscript != null &&
		data.transcriptionStatus !== "COMPLETE";

	const { data: liveTranscript } = useLiveTranscript(
		data.id,
		isLiveTranscriptEnabled,
	);

	const liveTranscriptData = useMemo(
		() => (liveTranscript?.content ? parseVTT(liveTranscript.content) : []),
		[liveTranscript?.content],
	);

	const showLiveTranscript =
		isLiveTranscriptEnabled && liveTranscriptData.length > 0;

	const invalidateTranscript = useInvalidateTranscript();

	const retryTranscriptionMutation = useMutation({
		mutationFn: async () => {
			const response = await fetch(
				`/api/videos/${data.id}/retry-transcription`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
				},
			);

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Failed to retry transcription: ${errorText}`);
			}

			return response.json();
		},
		onSuccess: () => {
			setRetryTriggered(true);
			invalidateTranscript(data.id);
			queryClient.invalidateQueries({
				queryKey: ["videoStatus", data.id],
			});
		},
	});

	useEffect(() => {
		const vttContent = captionContext.currentVttContent;
		if (vttContent) {
			const parsed = parseVTT(vttContent);
			setTranscriptData(parsed);
		} else if (transcriptContent && selectedLanguage === "original") {
			const parsed = parseVTT(transcriptContent);
			setTranscriptData(parsed);
		}
	}, [captionContext.currentVttContent, transcriptContent, selectedLanguage]);

	const handleLanguageChange = async (language: CaptionLanguage) => {
		setShowLanguageMenu(false);
		captionContext.setSelectedLanguage(language);
	};

	const isTranscriptionProcessing = useMemo(() => {
		if (
			data.transcriptionStatus === "SKIPPED" ||
			data.transcriptionStatus === "NO_AUDIO"
		) {
			return false;
		}
		if (retryTriggered && data.transcriptionStatus !== "COMPLETE") {
			return true;
		}
		return (
			data.transcriptionStatus === "PROCESSING" || !data.transcriptionStatus
		);
	}, [data.transcriptionStatus, retryTriggered]);

	const isQueryLoading =
		isTranscriptLoading && data.transcriptionStatus === "COMPLETE";

	const hasTimedOut = useMemo(() => {
		const videoCreationTime = new Date(data.createdAt).getTime();
		const fiveMinutesInMs = 5 * 60 * 1000;
		const isVideoOlderThanFiveMinutes =
			Date.now() - videoCreationTime > fiveMinutesInMs;
		return (
			isVideoOlderThanFiveMinutes &&
			!data.transcriptionStatus &&
			!retryTriggered
		);
	}, [data.createdAt, data.transcriptionStatus, retryTriggered]);

	const handleTranscriptClick = (entry: TranscriptEntry) => {
		if (editingEntry === entry.id) {
			return;
		}

		setSelectedEntry(entry.id);

		onSeek?.(entry.startTime);
	};

	const startEditing = (entry: TranscriptEntry) => {
		setEditingEntry(entry.id);
		setEditText(entry.text);
	};

	const cancelEditing = () => {
		setEditingEntry(null);
		setEditText("");
	};

	const saveEdit = async () => {
		const normalizedEditText = normalizeTranscriptCueText(editText);

		if (!editingEntry || !normalizedEditText) {
			return;
		}

		const _originalEntry = transcriptData.find(
			(entry) => entry.id === editingEntry,
		);

		setIsSaving(true);
		try {
			const result = await editTranscriptEntry(
				data.id,
				editingEntry,
				normalizedEditText,
			);

			if (result.success) {
				setTranscriptData((prev) =>
					prev.map((entry) =>
						entry.id === editingEntry
							? { ...entry, text: normalizedEditText }
							: entry,
					),
				);
				setEditingEntry(null);
				setEditText("");
				invalidateTranscript(data.id);
			} else {
				console.error("[Transcript] Failed to save transcript edit:", {
					entryId: editingEntry,
					videoId: data.id,
					errorMessage: result.message,
					result,
				});
			}
		} catch (error) {
			console.error("[Transcript] Error saving transcript edit:", {
				entryId: editingEntry,
				videoId: data.id,
				error: error instanceof Error ? error.message : error,
				stack: error instanceof Error ? error.stack : undefined,
			});
		} finally {
			setIsSaving(false);
		}
	};

	const formatTranscriptForClipboard = (entries: TranscriptEntry[]): string => {
		return entries
			.map((entry) => `[${entry.timestamp}] ${entry.text}`)
			.join("\n\n");
	};

	const formatTranscriptAsVTT = (entries: TranscriptEntry[]): string => {
		const vttHeader = "WEBVTT\n\n";

		const vttEntries = entries.map((entry, index) => {
			const startSeconds = entry.startTime;
			const nextEntry = entries[index + 1];
			const endSeconds = nextEntry ? nextEntry.startTime : startSeconds + 3;

			const formatTime = (seconds: number): string => {
				const hours = Math.floor(seconds / 3600);
				const minutes = Math.floor((seconds % 3600) / 60);
				const secs = Math.floor(seconds % 60);
				const milliseconds = Math.floor((seconds % 1) * 1000);

				return `${hours.toString().padStart(2, "0")}:${minutes
					.toString()
					.padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${milliseconds
					.toString()
					.padStart(3, "0")}`;
			};

			return `${entry.id}\n${formatTime(startSeconds)} --> ${formatTime(
				endSeconds,
			)}\n${entry.text}\n`;
		});

		return vttHeader + vttEntries.join("\n");
	};

	const copyTranscriptText = async (content: string) => {
		if (!content) return;

		setIsCopying(true);
		try {
			await navigator.clipboard.writeText(content);
			setCopyPressed(true);
			setTimeout(() => {
				setCopyPressed(false);
			}, 2000);
		} catch (error) {
			console.error("Failed to copy transcript:", error);
		} finally {
			setIsCopying(false);
		}
	};

	const copyFormattedTranscript = () => {
		if (transcriptData.length === 0) return;
		void copyTranscriptText(formatTranscriptAsParagraphs(transcriptData));
	};

	const copyTimestampedTranscript = () => {
		if (transcriptData.length === 0) return;
		void copyTranscriptText(formatTranscriptForClipboard(transcriptData));
	};

	const triggerTranscriptDownload = (
		extension: string,
		content: string,
		mimeType: string,
	) => {
		const blob = new Blob([content], { type: mimeType });
		const url = URL.createObjectURL(blob);

		const langSuffix =
			selectedLanguage === "original" ? "" : `.${selectedLanguage}`;
		const link = document.createElement("a");
		link.href = url;
		link.download = `transcript-${data.id}${langSuffix}.${extension}`;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);

		URL.revokeObjectURL(url);

		setDownloadPressed(true);
		setTimeout(() => {
			setDownloadPressed(false);
		}, 2000);
	};

	const downloadTranscriptFile = () => {
		if (transcriptData.length === 0) return;
		triggerTranscriptDownload(
			"vtt",
			formatTranscriptAsVTT(transcriptData),
			"text/vtt",
		);
	};

	const downloadFormattedTranscript = () => {
		if (transcriptData.length === 0) return;
		const content = formatTranscriptAsParagraphs(transcriptData);
		if (!content) return;
		triggerTranscriptDownload("txt", `${content}\n`, "text/plain");
	};

	const canEdit = user?.id === data.owner.id && selectedLanguage === "original";

	if (isTranscriptionProcessing && !hasTimedOut) {
		if (showLiveTranscript) {
			const isLiveActive = liveTranscript?.state === "active";

			return (
				<div className="flex flex-col h-full">
					<div className="flex flex-none items-center gap-2 border-b border-gray-3 px-4 py-3">
						{isLiveActive ? (
							<span className="relative flex size-2">
								<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
								<span className="relative inline-flex rounded-full size-2 bg-red-500" />
							</span>
						) : (
							<LoaderCircle className="size-3 animate-spin text-gray-9" />
						)}
						<span className="text-[11px] font-medium text-gray-12">
							Live transcript
						</span>
						<span className="text-[11px] text-gray-9">
							{isLiveActive
								? "updating as the recording uploads"
								: "processing final transcript…"}
						</span>
					</div>

					<div className="overflow-y-auto flex-1">
						<div className="px-3 py-3">
							{liveTranscriptData.map((entry) => (
								<div
									key={entry.id}
									className={`flex items-start gap-1 rounded-lg px-2 transition-colors ${
										selectedEntry === entry.id ? "bg-gray-3" : "hover:bg-gray-2"
									}`}
								>
									<button
										className="flex min-w-0 flex-1 items-baseline gap-2.5 py-1.5 text-left"
										onClick={() => handleTranscriptClick(entry)}
										type="button"
									>
										<span className="w-9 shrink-0 font-mono text-[10px] leading-[22px] tabular-nums text-gray-8">
											{entry.timestamp}
										</span>
										<span className="min-w-0 flex-1 text-[13px] leading-[22px] text-gray-11">
											{entry.text}
										</span>
									</button>
								</div>
							))}
						</div>
					</div>
				</div>
			);
		}

		return (
			<div className="flex h-full items-center justify-center p-7">
				<div className="text-center">
					<LoaderCircle className="mx-auto size-5 animate-spin text-gray-9" />
					<p className="mt-4 text-[13px] font-semibold text-gray-12">
						Transcribing audio
					</p>
					<p className="mt-1.5 text-[11px] leading-[18px] text-gray-9">
						The transcript will appear here shortly.
					</p>
				</div>
			</div>
		);
	}

	if (isQueryLoading) {
		return (
			<div className="flex h-full items-center justify-center">
				<LoaderCircle className="size-5 animate-spin text-gray-9" />
			</div>
		);
	}

	if (data.transcriptionStatus === "NO_AUDIO") {
		return (
			<div className="flex h-full items-center justify-center p-7">
				<div className="text-center">
					<div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-full bg-gray-3 text-gray-9">
						<MessageSquare className="size-[18px]" />
					</div>
					<p className="text-[13px] font-semibold text-gray-12">
						No audio track detected
					</p>
					<p className="mt-1.5 text-[11px] leading-[18px] text-gray-9">
						This video doesn't contain audio for transcription
					</p>
					{canEdit && (
						<>
							<Button
								type="button"
								onClick={() => {
									retryTranscriptionMutation.mutate();
								}}
								disabled={retryTranscriptionMutation.isPending}
								variant="primary"
								size="sm"
								spinner={retryTranscriptionMutation.isPending}
								className="mt-4"
							>
								{retryTranscriptionMutation.isPending
									? "Retrying..."
									: "Retry transcription"}
							</Button>
							{retryTranscriptionMutation.isError && (
								<p className="mt-2 text-xs text-red-500">
									Failed to retry. Please try again.
								</p>
							)}
						</>
					)}
				</div>
			</div>
		);
	}

	if (data.transcriptionStatus === "SKIPPED") {
		return (
			<div className="flex h-full items-center justify-center p-7">
				<div className="text-center">
					<div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-full bg-gray-3 text-gray-9">
						<MessageSquare className="size-[18px]" />
					</div>
					<p className="text-[13px] font-semibold text-gray-12">
						Transcription disabled
					</p>
					<p className="mt-1.5 text-[11px] leading-[18px] text-gray-9">
						Transcription has been disabled for this video
					</p>
				</div>
			</div>
		);
	}

	const showRetryButton =
		data.transcriptionStatus === "ERROR" ||
		hasTimedOut ||
		(data.transcriptionStatus === "COMPLETE" &&
			!transcriptData.length &&
			!isQueryLoading &&
			transcriptError);

	if (showRetryButton) {
		return (
			<div className="flex h-full items-center justify-center p-7">
				<div className="text-center">
					<div className="mx-auto mb-4 flex size-10 items-center justify-center rounded-full bg-gray-3 text-gray-9">
						<MessageSquare className="size-[18px]" />
					</div>
					<p className="mb-4 text-[13px] font-semibold text-gray-12">
						{data.transcriptionStatus === "ERROR"
							? "Transcript not available"
							: "No transcript available"}
					</p>
					{canEdit && (
						<>
							<Button
								onClick={() => {
									retryTranscriptionMutation.mutate();
								}}
								disabled={retryTranscriptionMutation.isPending}
								variant="primary"
								size="sm"
								spinner={retryTranscriptionMutation.isPending}
							>
								{retryTranscriptionMutation.isPending
									? "Retrying..."
									: "Retry Transcription"}
							</Button>
							{retryTranscriptionMutation.isError && (
								<p className="mt-2 text-xs text-red-500">
									Failed to retry. Please try again.
								</p>
							)}
						</>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			<div className="flex flex-none items-center justify-between gap-2 border-b border-gray-3 px-4 py-3">
				<div className="relative" ref={languageMenuRef}>
					<button
						onClick={() => setShowLanguageMenu(!showLanguageMenu)}
						disabled={isTranslating || transcriptData.length === 0}
						className="inline-flex h-7 items-center gap-1.5 rounded-full border border-gray-4 bg-gray-1 pl-2.5 pr-2 text-[11px] font-medium text-gray-11 transition hover:bg-gray-2 hover:text-gray-12 disabled:cursor-not-allowed disabled:opacity-50"
						type="button"
					>
						{isTranslating ? (
							<LoaderCircle className="size-3 animate-spin text-gray-9" />
						) : (
							<Globe className="size-3 text-gray-9" />
						)}
						<span>
							{isTranslating
								? "Translating…"
								: selectedLanguage === "original"
									? "Original"
									: SUPPORTED_LANGUAGES[selectedLanguage]}
						</span>
						<ChevronDown className="size-3 text-gray-9" />
					</button>
					{showLanguageMenu && (
						<div className="absolute left-0 top-full z-50 mt-1 max-h-64 w-48 overflow-y-auto rounded-xl border border-gray-4 bg-gray-1 py-1 shadow-[0_12px_32px_-12px_rgba(15,23,42,0.25)]">
							<button
								onClick={() => handleLanguageChange("original")}
								className={`w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-gray-2 ${
									selectedLanguage === "original"
										? "font-medium text-blue-500"
										: "text-gray-12"
								}`}
								type="button"
							>
								Original
							</button>
							<div className="my-1 border-t border-gray-3" />
							{(
								Object.entries(SUPPORTED_LANGUAGES) as [LanguageCode, string][]
							).map(([code, name]) => (
								<button
									key={code}
									onClick={() => handleLanguageChange(code)}
									className={`w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-gray-2 ${
										selectedLanguage === code
											? "font-medium text-blue-500"
											: "text-gray-12"
									}`}
									type="button"
								>
									{name}
									{captionContext.translatedVttContent.has(code) && (
										<span className="ml-1.5 text-gray-9">(cached)</span>
									)}
								</button>
							))}
						</div>
					)}
				</div>

				<div className="flex items-center gap-1">
					<div className="relative" ref={copyMenuRef}>
						<button
							type="button"
							aria-label="Copy transcript"
							title="Copy transcript"
							onClick={() => setShowCopyMenu((value) => !value)}
							disabled={isCopying || transcriptData.length === 0}
							className="inline-flex size-7 items-center justify-center rounded-full text-gray-9 transition hover:bg-gray-3 hover:text-gray-12 disabled:pointer-events-none disabled:opacity-40"
						>
							{isCopying ? (
								<LoaderCircle className="size-3.5 animate-spin" />
							) : copyPressed ? (
								<Check className="size-3.5 text-blue-500" />
							) : (
								<Copy className="size-3.5" />
							)}
						</button>
						{showCopyMenu && (
							<div className="absolute right-0 top-full z-50 mt-1 w-52 rounded-xl border border-gray-4 bg-gray-1 py-1 shadow-[0_12px_32px_-12px_rgba(15,23,42,0.25)]">
								<button
									type="button"
									onClick={() => {
										setShowCopyMenu(false);
										copyFormattedTranscript();
									}}
									className="block w-full px-3 py-2 text-left transition-colors hover:bg-gray-2"
								>
									<span className="block text-xs font-medium text-gray-12">
										Formatted text
									</span>
									<span className="mt-0.5 block text-[10px] text-gray-9">
										Clean paragraphs for docs
									</span>
								</button>
								<button
									type="button"
									onClick={() => {
										setShowCopyMenu(false);
										copyTimestampedTranscript();
									}}
									className="block w-full px-3 py-2 text-left transition-colors hover:bg-gray-2"
								>
									<span className="block text-xs font-medium text-gray-12">
										With timestamps
									</span>
									<span className="mt-0.5 block text-[10px] text-gray-9">
										[0:12] caption lines
									</span>
								</button>
							</div>
						)}
					</div>
					<div className="relative" ref={downloadMenuRef}>
						<button
							type="button"
							aria-label="Download transcript"
							title="Download transcript"
							onClick={() => setShowDownloadMenu((value) => !value)}
							disabled={transcriptData.length === 0}
							className="inline-flex size-7 items-center justify-center rounded-full text-gray-9 transition hover:bg-gray-3 hover:text-gray-12 disabled:pointer-events-none disabled:opacity-40"
						>
							{downloadPressed ? (
								<Check className="size-3.5 text-blue-500" />
							) : (
								<Download className="size-3.5" />
							)}
						</button>
						{showDownloadMenu && (
							<div className="absolute right-0 top-full z-50 mt-1 w-52 rounded-xl border border-gray-4 bg-gray-1 py-1 shadow-[0_12px_32px_-12px_rgba(15,23,42,0.25)]">
								<button
									type="button"
									onClick={() => {
										setShowDownloadMenu(false);
										downloadFormattedTranscript();
									}}
									className="block w-full px-3 py-2 text-left transition-colors hover:bg-gray-2"
								>
									<span className="block text-xs font-medium text-gray-12">
										Formatted text
									</span>
									<span className="mt-0.5 block text-[10px] text-gray-9">
										Clean paragraphs for docs — .txt
									</span>
								</button>
								<button
									type="button"
									onClick={() => {
										setShowDownloadMenu(false);
										downloadTranscriptFile();
									}}
									className="block w-full px-3 py-2 text-left transition-colors hover:bg-gray-2"
								>
									<span className="block text-xs font-medium text-gray-12">
										Captions file
									</span>
									<span className="mt-0.5 block text-[10px] text-gray-9">
										Timestamped subtitles — .vtt
									</span>
								</button>
							</div>
						)}
					</div>
				</div>
			</div>

			<div className="overflow-y-auto flex-1 relative">
				{isTranslating && (
					<div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-1/80 backdrop-blur-[2px]">
						<div className="text-center">
							<LoaderCircle className="mx-auto size-5 animate-spin text-gray-9" />
							<p className="mt-3 text-[11px] text-gray-9">
								Translating transcript…
							</p>
						</div>
					</div>
				)}
				<div className="px-3 py-3">
					{transcriptData.map((entry) => (
						<div
							key={entry.id}
							className={`group flex items-start gap-1 rounded-lg px-2 transition-colors ${
								editingEntry === entry.id
									? "bg-gray-2"
									: selectedEntry === entry.id
										? "bg-gray-3"
										: "hover:bg-gray-2"
							}`}
						>
							{editingEntry === entry.id ? (
								<div className="min-w-0 flex-1 py-2">
									<textarea
										value={editText}
										onChange={(e) => setEditText(e.target.value)}
										className="w-full resize-none rounded-lg border border-gray-4 bg-gray-1 p-2.5 text-[13px] leading-[22px] text-gray-12 outline-none transition placeholder:text-gray-8 focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20"
										rows={Math.max(2, Math.ceil(editText.length / 60))}
										onClick={(e) => e.stopPropagation()}
										placeholder="Edit transcript text..."
									/>
									<div className="mt-2 flex justify-end gap-1.5">
										<button
											type="button"
											onClick={(e) => {
												e.stopPropagation();
												cancelEditing();
											}}
											disabled={isSaving}
											className="inline-flex h-7 items-center rounded-full px-3 text-[11px] font-medium text-gray-11 transition hover:bg-gray-3 hover:text-gray-12 disabled:opacity-50"
										>
											Cancel
										</button>
										<button
											type="button"
											onClick={(e) => {
												e.stopPropagation();
												saveEdit();
											}}
											disabled={isSaving || !editText.trim()}
											className="inline-flex h-7 items-center gap-1.5 rounded-full bg-gray-12 px-3 text-[11px] font-semibold text-white transition hover:bg-gray-11 disabled:pointer-events-none disabled:opacity-50"
										>
											{isSaving && (
												<LoaderCircle className="size-3 animate-spin" />
											)}
											Save
										</button>
									</div>
								</div>
							) : (
								<>
									<button
										className="flex min-w-0 flex-1 items-baseline gap-2.5 py-1.5 text-left"
										onClick={() => handleTranscriptClick(entry)}
										type="button"
									>
										<span className="w-9 shrink-0 font-mono text-[10px] leading-[22px] tabular-nums text-gray-8">
											{entry.timestamp}
										</span>
										<span className="min-w-0 flex-1 text-[13px] leading-[22px] text-gray-11">
											{entry.text}
										</span>
									</button>
									{canEdit && (
										<button
											onClick={(e) => {
												e.stopPropagation();
												startEditing(entry);
											}}
											type="button"
											aria-label="Edit transcript entry"
											title="Edit transcript entry"
											className="mt-1.5 flex size-6 shrink-0 items-center justify-center rounded-md text-gray-9 opacity-0 transition-all hover:bg-gray-4 hover:text-gray-12 focus-visible:opacity-100 group-hover:opacity-100"
										>
											<Edit3 className="size-3" />
										</button>
									)}
								</>
							)}
						</div>
					))}
				</div>
			</div>
		</div>
	);
};
