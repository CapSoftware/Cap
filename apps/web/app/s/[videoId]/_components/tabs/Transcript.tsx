"use client";

import { Button } from "@cap/ui";
import { useMutation } from "@tanstack/react-query";
import { useInvalidateTranscript, useTranscript } from "hooks/use-transcript";
import {
	Check,
	ChevronDown,
	Copy,
	Download,
	Edit3,
	Globe,
	MessageSquare,
	X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { editTranscriptEntry } from "@/actions/videos/edit-transcript";
import {
	type LanguageCode,
	SUPPORTED_LANGUAGES,
} from "@/actions/videos/translate-transcript";
import { useCurrentUser } from "@/app/Layout/AuthContext";
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

		return {
			mm_ss: `${minutesStr}:${secondsPart}`,
			totalSeconds,
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
			if (startTimestamp) {
				currentEntry = {
					id: currentId,
					timestamp: startTimestamp.mm_ss,
					startTime: startTimestamp.totalSeconds,
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
	const languageMenuRef = useRef<HTMLDivElement>(null);

	const selectedLanguage =
		captionContext.selectedLanguage === "off"
			? "original"
			: captionContext.selectedLanguage;
	const isTranslating = captionContext.isTranslating;
	const translatedContent = captionContext.translatedVttContent;

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

	const {
		data: transcriptContent,
		isLoading: isTranscriptLoading,
		error: transcriptError,
	} = useTranscript(data.id, data.transcriptionStatus);

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
		},
		onError: (error) => {
			console.error("Failed to retry transcription:", error);
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
		if (!editingEntry || !editText.trim()) {
			return;
		}

		const _originalEntry = transcriptData.find(
			(entry) => entry.id === editingEntry,
		);

		setIsSaving(true);
		try {
			const result = await editTranscriptEntry(data.id, editingEntry, editText);

			if (result.success) {
				setTranscriptData((prev) =>
					prev.map((entry) =>
						entry.id === editingEntry
							? { ...entry, text: editText.trim() }
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

	const copyTranscriptToClipboard = async () => {
		if (transcriptData.length === 0) return;

		setIsCopying(true);
		try {
			const formattedTranscript = formatTranscriptForClipboard(transcriptData);
			await navigator.clipboard.writeText(formattedTranscript);
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

	const downloadTranscriptFile = () => {
		if (transcriptData.length === 0) return;

		const vttContent = formatTranscriptAsVTT(transcriptData);
		const blob = new Blob([vttContent], { type: "text/vtt" });
		const url = URL.createObjectURL(blob);

		const langSuffix =
			selectedLanguage === "original" ? "" : `.${selectedLanguage}`;
		const link = document.createElement("a");
		link.href = url;
		link.download = `transcript-${data.id}${langSuffix}.vtt`;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);

		URL.revokeObjectURL(url);

		setDownloadPressed(true);
		setTimeout(() => {
			setDownloadPressed(false);
		}, 2000);
	};

	const canEdit = user?.id === data.owner.id && selectedLanguage === "original";

	if (isTranscriptionProcessing && !hasTimedOut) {
		return (
			<div className="flex justify-center items-center h-full text-gray-1">
				<div className="text-center">
					<div className="mb-3">
						<svg
							xmlns="http://www.w3.org/2000/svg"
							className="mx-auto w-8 h-8"
							viewBox="0 0 24 24"
						>
							<style>
								{"@keyframes spinner_AtaB{to{transform:rotate(360deg)}}"}
							</style>
							<path
								fill="#9CA3AF"
								d="M12 1a11 11 0 1 0 11 11A11 11 0 0 0 12 1Zm0 19a8 8 0 1 1 8-8 8 8 0 0 1-8 8Z"
								opacity={0.25}
							/>
							<path
								fill="#9CA3AF"
								d="M10.14 1.16a11 11 0 0 0-9 8.92A1.59 1.59 0 0 0 2.46 12a1.52 1.52 0 0 0 1.65-1.3 8 8 0 0 1 6.66-6.61A1.42 1.42 0 0 0 12 2.69a1.57 1.57 0 0 0-1.86-1.53Z"
								style={{
									transformOrigin: "center",
									animation: "spinner_AtaB .75s infinite linear",
								}}
							/>
						</svg>
					</div>
					<p>Transcription in progress...</p>
				</div>
			</div>
		);
	}

	if (isQueryLoading) {
		return (
			<div className="flex justify-center items-center h-full">
				<svg
					xmlns="http://www.w3.org/2000/svg"
					className="w-8 h-8"
					viewBox="0 0 24 24"
				>
					<style>
						{"@keyframes spinner_AtaB{to{transform:rotate(360deg)}}"}
					</style>
					<path
						fill="#4B5563"
						d="M12 1a11 11 0 1 0 11 11A11 11 0 0 0 12 1Zm0 19a8 8 0 1 1 8-8 8 8 0 0 1-8 8Z"
						opacity={0.25}
					/>
					<path
						fill="#4B5563"
						d="M10.14 1.16a11 11 0 0 0-9 8.92A1.59 1.59 0 0 0 2.46 12a1.52 1.52 0 0 0 1.65-1.3 8 8 0 0 1 6.66-6.61A1.42 1.42 0 0 0 12 2.69a1.57 1.57 0 0 0-1.86-1.53Z"
						style={{
							transformOrigin: "center",
							animation: "spinner_AtaB .75s infinite linear",
						}}
					/>
				</svg>
			</div>
		);
	}

	if (data.transcriptionStatus === "NO_AUDIO") {
		return (
			<div className="flex justify-center items-center h-full text-gray-1">
				<div className="text-center">
					<MessageSquare className="mx-auto mb-2 w-8 h-8 text-gray-300" />
					<p className="text-sm font-medium text-gray-12">
						No audio track detected
					</p>
					<p className="mt-1 text-xs text-gray-9">
						This video doesn't contain audio for transcription
					</p>
				</div>
			</div>
		);
	}

	if (data.transcriptionStatus === "SKIPPED") {
		return (
			<div className="flex justify-center items-center h-full text-gray-1">
				<div className="text-center">
					<MessageSquare className="mx-auto mb-2 w-8 h-8 text-gray-300" />
					<p className="text-sm font-medium text-gray-12">
						Transcription disabled
					</p>
					<p className="mt-1 text-xs text-gray-9">
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
			<div className="flex justify-center items-center h-full text-gray-1">
				<div className="text-center">
					<MessageSquare className="mx-auto mb-2 w-8 h-8 text-gray-300" />
					<p className="mb-4 text-sm font-medium text-gray-12">
						{data.transcriptionStatus === "ERROR"
							? "Transcript not available"
							: "No transcript available"}
					</p>
					{canEdit && (
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
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col h-full">
			<div className="p-4 border-b border-gray-3">
				<div className="flex gap-2 justify-between items-center">
					<div className="relative" ref={languageMenuRef}>
						<button
							onClick={() => setShowLanguageMenu(!showLanguageMenu)}
							disabled={isTranslating || transcriptData.length === 0}
							className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-gray-3 bg-gray-1 hover:bg-gray-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
							type="button"
						>
							<Globe className="w-3 h-3 text-gray-9" />
							<span className="text-gray-12">
								{isTranslating
									? "Translating..."
									: selectedLanguage === "original"
										? "Original"
										: SUPPORTED_LANGUAGES[selectedLanguage]}
							</span>
							<ChevronDown className="w-3 h-3 text-gray-9" />
						</button>
						{showLanguageMenu && (
							<div className="absolute left-0 top-full mt-1 z-50 w-48 py-1 bg-gray-1 border border-gray-3 rounded-lg shadow-lg max-h-64 overflow-y-auto">
								<button
									onClick={() => handleLanguageChange("original")}
									className={`w-full px-3 py-1.5 text-left text-xs hover:bg-gray-2 transition-colors ${
										selectedLanguage === "original"
											? "text-blue-500 font-medium"
											: "text-gray-12"
									}`}
									type="button"
								>
									Original
								</button>
								<div className="my-1 border-t border-gray-3" />
								{(
									Object.entries(SUPPORTED_LANGUAGES) as [
										LanguageCode,
										string,
									][]
								).map(([code, name]) => (
									<button
										key={code}
										onClick={() => handleLanguageChange(code)}
										className={`w-full px-3 py-1.5 text-left text-xs hover:bg-gray-2 transition-colors ${
											selectedLanguage === code
												? "text-blue-500 font-medium"
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
					<div className="flex gap-2">
						<Button
							onClick={copyTranscriptToClipboard}
							disabled={isCopying || transcriptData.length === 0}
							variant="white"
							size="xs"
							spinner={isCopying}
						>
							{!copyPressed ? (
								<Copy className="mr-1 w-3 h-3" />
							) : (
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="12"
									height="12"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
									className="mr-1 w-3 h-3 svgpathanimation"
								>
									<path d="M20 6 9 17l-5-5" />
								</svg>
							)}
							{copyPressed ? "Copied" : "Copy Transcript"}
						</Button>
						<Button
							onClick={downloadTranscriptFile}
							disabled={transcriptData.length === 0}
							variant="white"
							size="xs"
						>
							{!downloadPressed ? (
								<Download className="mr-1 w-3 h-3" />
							) : (
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="12"
									height="12"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
									className="mr-1 w-3 h-3 svgpathanimation"
								>
									<path d="M20 6 9 17l-5-5" />
								</svg>
							)}
							{downloadPressed ? "Downloaded" : "Download"}
						</Button>
					</div>
				</div>
			</div>

			<div className="overflow-y-auto flex-1 relative">
				{isTranslating && (
					<div className="absolute inset-0 bg-gray-1/80 flex items-center justify-center z-10">
						<div className="text-center">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								className="mx-auto w-8 h-8"
								viewBox="0 0 24 24"
							>
								<style>
									{"@keyframes spinner_AtaB{to{transform:rotate(360deg)}}"}
								</style>
								<path
									fill="#9CA3AF"
									d="M12 1a11 11 0 1 0 11 11A11 11 0 0 0 12 1Zm0 19a8 8 0 1 1 8-8 8 8 0 0 1-8 8Z"
									opacity={0.25}
								/>
								<path
									fill="#9CA3AF"
									d="M10.14 1.16a11 11 0 0 0-9 8.92A1.59 1.59 0 0 0 2.46 12a1.52 1.52 0 0 0 1.65-1.3 8 8 0 0 1 6.66-6.61A1.42 1.42 0 0 0 12 2.69a1.57 1.57 0 0 0-1.86-1.53Z"
									style={{
										transformOrigin: "center",
										animation: "spinner_AtaB .75s infinite linear",
									}}
								/>
							</svg>
							<p className="mt-2 text-sm text-gray-11">
								Translating transcript...
							</p>
						</div>
					</div>
				)}
				<div className="p-4 space-y-3">
					{transcriptData.map((entry) => (
						<div
							key={entry.id}
							className={`group rounded-lg transition-colors ${
								editingEntry === entry.id
									? "bg-gray-1 border border-gray-4 p-3"
									: selectedEntry === entry.id
										? "bg-gray-2 p-3"
										: "hover:bg-gray-2 p-3"
							} ${editingEntry === entry.id ? "" : "cursor-pointer"}`}
							onClick={() => handleTranscriptClick(entry)}
						>
							<div className="flex justify-between items-start mb-2">
								<div className="text-xs font-medium text-gray-8">
									{entry.timestamp}
								</div>
								{canEdit && editingEntry !== entry.id && (
									<button
										onClick={(e) => {
											e.stopPropagation();
											startEditing(entry);
										}}
										type="button"
										className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-gray-3 rounded-md transition-all duration-200"
										title="Edit transcript"
									>
										<Edit3 className="w-3.5 h-3.5 text-gray-9" />
									</button>
								)}
							</div>

							{editingEntry === entry.id ? (
								<div className="space-y-3">
									<div className="p-3 rounded-lg border bg-gray-1 border-gray-4">
										<textarea
											value={editText}
											onChange={(e) => setEditText(e.target.value)}
											className="w-full text-sm leading-relaxed bg-transparent resize-none text-gray-12 placeholder:text-gray-8 focus:outline-none"
											rows={Math.max(2, Math.ceil(editText.length / 60))}
											onClick={(e) => e.stopPropagation()}
											placeholder="Edit transcript text..."
										/>
									</div>
									<div className="flex gap-2 justify-end">
										<Button
											onClick={(e) => {
												e.stopPropagation();
												cancelEditing();
											}}
											disabled={isSaving}
											variant="white"
											size="xs"
											className="min-w-[70px]"
										>
											<X className="mr-1 w-3 h-3" />
											Cancel
										</Button>
										<Button
											onClick={(e) => {
												e.stopPropagation();
												saveEdit();
											}}
											disabled={isSaving || !editText.trim()}
											variant="primary"
											size="xs"
											className="min-w-[70px]"
											spinner={isSaving}
										>
											<Check className="mr-1 w-3 h-3" />
											Save
										</Button>
									</div>
								</div>
							) : (
								<div className="text-sm leading-relaxed text-gray-12">
									{entry.text}
								</div>
							)}
						</div>
					))}
				</div>
			</div>
		</div>
	);
};
