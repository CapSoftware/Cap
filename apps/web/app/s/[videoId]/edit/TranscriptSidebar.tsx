"use client";

import type { VideoEditRange } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { useVirtualizer } from "@virtual-grid/react";
import {
	ChevronDown,
	ChevronUp,
	FileText,
	LoaderCircle,
	Search,
	Trash2,
	X,
} from "lucide-react";
import {
	memo,
	type PointerEvent as ReactPointerEvent,
	type RefObject,
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	getEditTranscript,
	requestEditTranscript,
} from "@/actions/videos/get-edit-transcript";
import {
	type EditTranscriptGroup,
	type EditTranscriptWord,
	getDeletedTranscriptWordIds,
	groupEditTranscriptWords,
	isFillerWord,
	normalizeTranscriptSelection,
	planFillerCuts,
	planTranscriptCut,
} from "@/lib/edit-transcript";
import { useActiveTranscriptWordIndex } from "./use-active-transcript-word-index";

type TranscriptResponse = Awaited<ReturnType<typeof getEditTranscript>>;

type TranscriptSidebarProps = {
	videoId: Video.VideoId;
	videoRef: RefObject<HTMLVideoElement | null>;
	keepRanges: VideoEditRange[];
	onDeleteRanges: (ranges: VideoEditRange[]) => void;
};

const SIDEBAR_CLASS_NAME =
	"mx-3 mb-4 flex min-h-[36rem] flex-col overflow-hidden rounded-2xl border border-gray-4 bg-gray-1 shadow-[0_16px_44px_-32px_rgba(15,23,42,0.28)] sm:mx-5 xl:fixed xl:top-20 xl:right-5 xl:mx-0 xl:mb-0 xl:h-[calc(100vh-6rem)] xl:w-[360px] min-[1540px]:right-[calc((100vw-1500px)/2+20px)]";

const SKELETON_LINE_WIDTHS = [
	["w-full", "w-4/5"],
	["w-11/12", "w-2/3"],
	["w-full", "w-3/5", "w-2/3"],
	["w-5/6", "w-1/3"],
	["w-full", "w-3/4"],
	["w-10/12", "w-1/2"],
];

function formatTimestamp(milliseconds: number) {
	const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function isTimeKept(timeMs: number, keepRanges: readonly VideoEditRange[]) {
	const timeSeconds = timeMs / 1000;
	return keepRanges.some(
		(range) => timeSeconds >= range.start && timeSeconds <= range.end,
	);
}

function toVideoRanges(
	ranges: readonly { startMs: number; endMs: number }[],
): VideoEditRange[] {
	return ranges.map((range) => ({
		start: range.startMs / 1000,
		end: range.endMs / 1000,
	}));
}

function TranscriptSkeleton() {
	return (
		<div
			aria-hidden
			className="min-h-0 flex-1 space-y-6 overflow-hidden px-4 py-5"
		>
			{SKELETON_LINE_WIDTHS.map((lineWidths, rowIndex) => (
				<div
					key={lineWidths.join("-")}
					className="flex animate-pulse gap-2.5"
					style={{ animationDelay: `${rowIndex * 120}ms` }}
				>
					<div className="mt-2 h-2 w-9 shrink-0 rounded-full bg-gray-4" />
					<div className="min-w-0 flex-1 space-y-2.5 pt-2">
						{lineWidths.map((width) => (
							<div
								key={width}
								className={`h-2 rounded-full bg-gray-4 ${width}`}
							/>
						))}
					</div>
				</div>
			))}
		</div>
	);
}

const TranscriptGroupRow = memo(function TranscriptGroupRow({
	group,
	words,
	activeWordIndex,
	selectionStartIndex,
	selectionEndIndex,
	deletedWordIds,
	searchMatchSet,
	previewFillers,
	wordElementsRef,
	onSeek,
	onWordPointerDown,
	onWordPointerEnter,
}: {
	group: EditTranscriptGroup;
	words: readonly EditTranscriptWord[];
	activeWordIndex: number;
	selectionStartIndex: number;
	selectionEndIndex: number;
	deletedWordIds: ReadonlySet<string>;
	searchMatchSet: ReadonlySet<number>;
	previewFillers: boolean;
	wordElementsRef: RefObject<Map<number, HTMLButtonElement>>;
	onSeek: (index: number) => void;
	onWordPointerDown: (
		index: number,
		event: ReactPointerEvent<HTMLButtonElement>,
	) => void;
	onWordPointerEnter: (
		index: number,
		event: ReactPointerEvent<HTMLButtonElement>,
	) => void;
}) {
	return (
		<div
			className="flex items-baseline gap-2.5"
			style={{
				contentVisibility: "auto",
				containIntrinsicSize: "0 96px",
			}}
		>
			<button
				type="button"
				onClick={() => onSeek(group.startIndex)}
				title={`Play from ${formatTimestamp(group.startMs)}`}
				className="w-9 shrink-0 text-left font-mono text-[10px] leading-none tabular-nums text-gray-8 transition-colors hover:text-blue-500"
			>
				{formatTimestamp(group.startMs)}
			</button>
			<p className="min-w-0 flex-1 select-none text-[13.5px] leading-[26px] text-gray-11">
				{words
					.slice(group.startIndex, group.endIndex + 1)
					.map((word, groupWordIndex) => {
						const index = group.startIndex + groupWordIndex;
						const isSelected =
							index >= selectionStartIndex && index <= selectionEndIndex;
						const isSelectionStart =
							isSelected && index === selectionStartIndex;
						const isSelectionEnd = isSelected && index === selectionEndIndex;
						const isActive = activeWordIndex === index;
						const isDeleted = deletedWordIds.has(word.id);
						const isFiller = isFillerWord(word.text);
						const isSearchMatch = searchMatchSet.has(index);
						const willRemoveAsFiller = previewFillers && isFiller && !isDeleted;

						let stateClassName: string;
						if (isSelected) {
							stateClassName = [
								"bg-blue-500 text-white",
								isSelectionStart ? "rounded-l-[5px]" : "",
								isSelectionEnd ? "rounded-r-[5px]" : "",
							].join(" ");
						} else if (isActive) {
							stateClassName = "rounded-[5px] bg-blue-500/15";
						} else if (isSearchMatch) {
							stateClassName = isDeleted
								? "rounded-[5px] bg-amber-100/60"
								: "rounded-[5px] bg-amber-100 text-amber-900";
						} else if (willRemoveAsFiller) {
							stateClassName =
								"rounded-[5px] bg-red-50 text-red-400 line-through decoration-red-300/60";
						} else {
							stateClassName = "rounded-[5px] hover:bg-gray-3";
						}

						return (
							<button
								key={word.id}
								ref={(element) => {
									if (element) {
										wordElementsRef.current.set(index, element);
									} else {
										wordElementsRef.current.delete(index);
									}
								}}
								type="button"
								data-word-index={index}
								onPointerDown={(event) => onWordPointerDown(index, event)}
								onPointerEnter={(event) => onWordPointerEnter(index, event)}
								className={[
									"inline py-[3px] pr-[5px] text-left leading-5 transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50",
									stateClassName,
									isDeleted && !isSelected
										? "text-gray-7 line-through decoration-gray-6"
										: "",
								].join(" ")}
							>
								{word.text}
							</button>
						);
					})}
			</p>
		</div>
	);
});

export function TranscriptSidebar({
	videoId,
	videoRef,
	keepRanges,
	onDeleteRanges,
}: TranscriptSidebarProps) {
	const [response, setResponse] = useState<TranscriptResponse | null>(null);
	const [isRequesting, setIsRequesting] = useState(false);
	const [selection, setSelection] = useState<{
		startIndex: number;
		endIndex: number;
	} | null>(null);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchMatchIndex, setSearchMatchIndex] = useState(0);
	const [previewFillers, setPreviewFillers] = useState(false);
	const deferredSearchQuery = useDeferredValue(searchQuery);
	const dragAnchorRef = useRef<number | null>(null);
	const selectionRef = useRef(selection);
	const transcriptScrollRef = useRef<HTMLDivElement>(null);
	const wordElementsRef = useRef(new Map<number, HTMLButtonElement>());
	const transcript = response?.status === "ready" ? response.transcript : null;
	const activeWordIndex = useActiveTranscriptWordIndex(
		videoRef,
		transcript?.words ?? null,
	);

	const loadTranscript = useCallback(async () => {
		setResponse(await getEditTranscript(videoId));
	}, [videoId]);

	useEffect(() => {
		void loadTranscript();
	}, [loadTranscript]);

	useEffect(() => {
		if (response?.status !== "processing") return;
		let cancelled = false;
		let timeout: number;
		const poll = async () => {
			try {
				const nextResponse = await getEditTranscript(videoId);
				if (cancelled) return;
				setResponse(nextResponse);
				if (nextResponse.status === "processing") {
					timeout = window.setTimeout(() => void poll(), 2_000);
				}
			} catch {
				if (!cancelled) {
					timeout = window.setTimeout(() => void poll(), 2_000);
				}
			}
		};
		timeout = window.setTimeout(() => void poll(), 2_000);
		return () => {
			cancelled = true;
			window.clearTimeout(timeout);
		};
	}, [response?.status, videoId]);

	useEffect(() => {
		const handlePointerUp = () => {
			dragAnchorRef.current = null;
		};
		window.addEventListener("pointerup", handlePointerUp);
		window.addEventListener("pointercancel", handlePointerUp);
		return () => {
			window.removeEventListener("pointerup", handlePointerUp);
			window.removeEventListener("pointercancel", handlePointerUp);
		};
	}, []);

	const groups = useMemo(
		() => (transcript ? groupEditTranscriptWords(transcript.words) : []),
		[transcript],
	);
	const deletedWordIds = useMemo(
		() =>
			transcript
				? getDeletedTranscriptWordIds(transcript.words, keepRanges)
				: new Set<string>(),
		[keepRanges, transcript],
	);
	const availableFillerCount = useMemo(
		() =>
			transcript?.words.filter(
				(word) => isFillerWord(word.text) && !deletedWordIds.has(word.id),
			).length ?? 0,
		[deletedWordIds, transcript],
	);
	const searchMatches = useMemo(() => {
		const query = deferredSearchQuery.trim().toLocaleLowerCase();
		if (!transcript || !query) return [];
		return transcript.words.flatMap((word, index) =>
			word.text.toLocaleLowerCase().includes(query) ? [index] : [],
		);
	}, [deferredSearchQuery, transcript]);
	const searchMatchSet = useMemo(() => new Set(searchMatches), [searchMatches]);
	const groupVirtualizer = useVirtualizer({
		count: groups.length,
		getScrollElement: () => transcriptScrollRef.current,
		estimateSize: () => 116,
		getItemKey: (index) => groups[index]?.id ?? index,
		overscan: 6,
	});

	const seekToWord = useCallback(
		(index: number) => {
			const word = transcript?.words[index];
			const video = videoRef.current;
			if (!word || !video) return;
			video.currentTime = word.startMs / 1000;
		},
		[transcript, videoRef],
	);

	const updateSelection = useCallback(
		(firstIndex: number, secondIndex: number) => {
			if (!transcript) return;
			const nextSelection = normalizeTranscriptSelection(
				firstIndex,
				secondIndex,
				transcript.words.length,
			);
			selectionRef.current = nextSelection;
			setSelection(nextSelection);
		},
		[transcript],
	);

	const clearSelection = useCallback(() => {
		selectionRef.current = null;
		setSelection(null);
	}, []);

	const handleWordPointerDown = useCallback(
		(index: number, event: ReactPointerEvent<HTMLButtonElement>) => {
			if (event.button !== 0) return;
			event.stopPropagation();

			const currentSelection = selectionRef.current;
			const anchor =
				event.shiftKey && currentSelection
					? currentSelection.startIndex
					: index;
			dragAnchorRef.current = anchor;
			updateSelection(anchor, index);
			seekToWord(index);
		},
		[seekToWord, updateSelection],
	);

	const handleWordPointerEnter = useCallback(
		(index: number, event: ReactPointerEvent<HTMLButtonElement>) => {
			if (dragAnchorRef.current === null || event.buttons !== 1) return;
			updateSelection(dragAnchorRef.current, index);
		},
		[updateSelection],
	);

	const deleteSelection = useCallback(() => {
		if (!transcript || !selection) return;
		const plan = planTranscriptCut(
			transcript.words,
			selection.startIndex,
			selection.endIndex,
			transcript.durationMs,
		);
		if (!plan) return;
		if (!plan.safe) {
			toast.error(
				plan.reason === "overlapping-speech"
					? "This selection overlaps other speech and cannot be cut safely."
					: "An edit must keep some playable video.",
			);
			return;
		}

		onDeleteRanges(toVideoRanges([plan]));
		clearSelection();
		const nextWord = transcript.words[selection.endIndex + 1];
		if (nextWord) seekToWord(selection.endIndex + 1);
	}, [clearSelection, onDeleteRanges, seekToWord, selection, transcript]);

	const deleteFillers = useCallback(() => {
		if (!transcript) return;
		const plan = planFillerCuts(transcript.words, transcript.durationMs);
		const activeRanges = plan.ranges.filter((range) =>
			isTimeKept((range.startMs + range.endMs) / 2, keepRanges),
		);
		if (activeRanges.length === 0) {
			toast.info("No safe filler words remain.");
			return;
		}

		onDeleteRanges(toVideoRanges(activeRanges));
		let activeRangeIndex = 0;
		let removedCount = 0;
		for (const word of transcript.words) {
			if (!isFillerWord(word.text) || deletedWordIds.has(word.id)) continue;
			const midpointMs = (word.startMs + word.endMs) / 2;
			while (
				activeRangeIndex < activeRanges.length &&
				(activeRanges[activeRangeIndex]?.endMs ?? 0) < midpointMs
			) {
				activeRangeIndex++;
			}
			const activeRange = activeRanges[activeRangeIndex];
			if (
				activeRange &&
				midpointMs >= activeRange.startMs &&
				midpointMs <= activeRange.endMs
			) {
				removedCount++;
			}
		}
		const skippedCount = availableFillerCount - removedCount;
		clearSelection();
		if (skippedCount > 0) {
			toast.info(
				`Removed ${removedCount} fillers and skipped ${skippedCount} unsafe cuts.`,
			);
		} else {
			toast.success(
				`Removed ${removedCount} filler${removedCount === 1 ? "" : "s"}.`,
			);
		}
	}, [
		availableFillerCount,
		clearSelection,
		deletedWordIds,
		keepRanges,
		onDeleteRanges,
		transcript,
	]);

	const moveSearchMatch = useCallback(
		(direction: -1 | 1) => {
			if (searchMatches.length === 0) return;
			const next =
				(searchMatchIndex + direction + searchMatches.length) %
				searchMatches.length;
			setSearchMatchIndex(next);
			const wordIndex = searchMatches[next];
			if (wordIndex === undefined) return;
			const groupIndex = groups.findIndex(
				(group) => wordIndex >= group.startIndex && wordIndex <= group.endIndex,
			);
			if (groupIndex >= 0) {
				groupVirtualizer.scrollToIndex(groupIndex, {
					align: "center",
					behavior: "smooth",
				});
			}
			window.requestAnimationFrame(() => {
				wordElementsRef.current
					.get(wordIndex)
					?.scrollIntoView({ block: "center", behavior: "smooth" });
			});
			updateSelection(wordIndex, wordIndex);
			seekToWord(wordIndex);
		},
		[
			groupVirtualizer,
			groups,
			searchMatchIndex,
			searchMatches,
			seekToWord,
			updateSelection,
		],
	);

	const handleRequest = useCallback(async () => {
		setIsRequesting(true);
		const nextResponse = await requestEditTranscript(videoId);
		setResponse(nextResponse);
		setIsRequesting(false);
	}, [videoId]);

	// The verbatim pass only exists to serve this editor, so kick it off the
	// moment we learn it hasn't run yet instead of asking the user to.
	const autoRequestedRef = useRef(false);
	useEffect(() => {
		if (response?.status !== "missing" || autoRequestedRef.current) return;
		autoRequestedRef.current = true;
		void handleRequest();
	}, [response?.status, handleRequest]);

	if (response === null) {
		return (
			<aside className={SIDEBAR_CLASS_NAME}>
				<div className="border-b border-gray-3 px-4 pt-4 pb-3">
					<h2 className="text-[13px] font-semibold text-gray-12">Transcript</h2>
					<div className="mt-1.5 h-2.5 w-24 animate-pulse rounded-full bg-gray-3" />
				</div>
				<TranscriptSkeleton />
			</aside>
		);
	}

	if (response.status === "missing" || response.status === "processing") {
		return (
			<aside className={SIDEBAR_CLASS_NAME}>
				<div className="border-b border-gray-3 px-4 pt-4 pb-3">
					<div className="flex items-center justify-between gap-3">
						<div className="min-w-0">
							<h2 className="text-[13px] font-semibold text-gray-12">
								Transcript
							</h2>
							<p className="mt-0.5 text-[11px] text-gray-9">
								Preparing word-level timings
							</p>
						</div>
						<span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-blue-500/10 px-2.5 text-[10px] font-semibold text-blue-600">
							<LoaderCircle className="size-3 animate-spin" />
							Preparing
						</span>
					</div>
				</div>
				<TranscriptSkeleton />
				<div className="border-t border-gray-3 p-3">
					<p className="flex h-9 items-center justify-center text-center text-[11px] leading-4 text-gray-9">
						You can keep editing while precise word timings are generated.
					</p>
				</div>
			</aside>
		);
	}

	if (response.status === "error") {
		return (
			<aside
				className={`${SIDEBAR_CLASS_NAME} items-center justify-center p-7 text-center`}
			>
				<div className="mb-4 flex size-10 items-center justify-center rounded-full bg-gray-3 text-gray-9">
					<FileText className="size-[18px]" />
				</div>
				<h2 className="text-[13px] font-semibold text-gray-12">
					Transcript unavailable
				</h2>
				<p className="mt-1.5 max-w-60 text-[11px] leading-[18px] text-gray-9">
					{response.message}
				</p>
				<button
					type="button"
					onClick={() => void handleRequest()}
					disabled={isRequesting}
					className="mt-5 inline-flex h-9 items-center justify-center gap-2 rounded-full border border-gray-5 px-4 text-xs font-semibold text-gray-12 transition hover:bg-gray-3 active:bg-gray-4 disabled:pointer-events-none disabled:opacity-50"
				>
					{isRequesting && <LoaderCircle className="size-3.5 animate-spin" />}
					Try again
				</button>
			</aside>
		);
	}

	if (!transcript) return null;

	if (transcript.words.length === 0) {
		return (
			<aside
				className={`${SIDEBAR_CLASS_NAME} items-center justify-center p-7 text-center`}
			>
				<div className="mb-4 flex size-10 items-center justify-center rounded-full bg-gray-3 text-gray-9">
					<FileText className="size-[18px]" />
				</div>
				<h2 className="text-[13px] font-semibold text-gray-12">
					No speech detected
				</h2>
				<p className="mt-1.5 max-w-60 text-[11px] leading-[18px] text-gray-9">
					The timeline editor is still available for manual edits.
				</p>
			</aside>
		);
	}

	const selectedWordCount = selection
		? selection.endIndex - selection.startIndex + 1
		: 0;

	return (
		<aside
			onKeyDown={(event) => {
				const target = event.target;
				if (
					target instanceof HTMLElement &&
					(target.matches("input, textarea, select") ||
						target.isContentEditable)
				) {
					return;
				}
				if (!selection) return;
				if (event.key === "Backspace" || event.key === "Delete") {
					event.preventDefault();
					event.stopPropagation();
					deleteSelection();
					return;
				}
				if (event.key === "Escape") {
					event.preventDefault();
					clearSelection();
				}
			}}
			className={SIDEBAR_CLASS_NAME}
		>
			<div className="border-b border-gray-3 px-4 pt-4 pb-3">
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0">
						<h2 className="text-[13px] font-semibold text-gray-12">
							Transcript
						</h2>
						<p className="mt-0.5 text-[11px] tabular-nums text-gray-9">
							{formatTimestamp(transcript.durationMs)} ·{" "}
							{transcript.words.length} words
						</p>
					</div>
					{availableFillerCount > 0 && (
						<button
							type="button"
							onClick={deleteFillers}
							onMouseEnter={() => setPreviewFillers(true)}
							onMouseLeave={() => setPreviewFillers(false)}
							onFocus={() => setPreviewFillers(true)}
							onBlur={() => setPreviewFillers(false)}
							className="group inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-gray-4 bg-gray-1 pl-2.5 pr-1 text-[11px] font-medium text-gray-11 transition hover:border-red-100 hover:bg-red-50 hover:text-red-400"
						>
							Remove fillers
							<span className="rounded-full bg-gray-3 px-1.5 py-px text-[10px] font-semibold tabular-nums text-gray-11 transition group-hover:bg-red-300/15 group-hover:text-red-400">
								{availableFillerCount}
							</span>
						</button>
					)}
				</div>

				<div className="mt-3 flex h-8 items-center gap-2 rounded-lg bg-gray-3 px-2.5 ring-1 ring-transparent transition focus-within:bg-gray-1 focus-within:ring-blue-500/50">
					<Search className="size-3.5 shrink-0 text-gray-9" />
					<input
						value={searchQuery}
						onChange={(event) => {
							setSearchQuery(event.target.value);
							setSearchMatchIndex(0);
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								moveSearchMatch(event.shiftKey ? -1 : 1);
								return;
							}
							if (event.key === "Escape" && searchQuery) {
								event.preventDefault();
								event.stopPropagation();
								setSearchQuery("");
								setSearchMatchIndex(0);
							}
						}}
						placeholder="Search transcript"
						className="min-w-0 flex-1 bg-transparent text-xs text-gray-12 outline-none placeholder:text-gray-9"
					/>
					{searchQuery && (
						<>
							<span className="shrink-0 text-[10px] font-medium tabular-nums text-gray-9">
								{searchMatches.length === 0 ? 0 : searchMatchIndex + 1}/
								{searchMatches.length}
							</span>
							<button
								type="button"
								aria-label="Previous search result"
								onClick={() => moveSearchMatch(-1)}
								disabled={searchMatches.length === 0}
								className="inline-flex size-5 shrink-0 items-center justify-center rounded text-gray-9 transition hover:bg-gray-4 hover:text-gray-12 disabled:pointer-events-none disabled:opacity-30"
							>
								<ChevronUp className="size-3.5" />
							</button>
							<button
								type="button"
								aria-label="Next search result"
								onClick={() => moveSearchMatch(1)}
								disabled={searchMatches.length === 0}
								className="inline-flex size-5 shrink-0 items-center justify-center rounded text-gray-9 transition hover:bg-gray-4 hover:text-gray-12 disabled:pointer-events-none disabled:opacity-30"
							>
								<ChevronDown className="size-3.5" />
							</button>
						</>
					)}
				</div>
			</div>

			<div className="relative min-h-0 flex-1">
				<div
					ref={transcriptScrollRef}
					className="h-full overflow-y-auto overscroll-contain px-4 py-4"
					style={{
						scrollbarWidth: "thin",
						scrollbarColor: "var(--gray-5) transparent",
					}}
				>
					<div
						className="relative w-full"
						style={{ height: `${groupVirtualizer.getTotalSize()}px` }}
					>
						{groupVirtualizer.getVirtualItems().map((virtualGroup) => {
							const group = groups[virtualGroup.index];
							if (!group) return null;
							const groupActiveWordIndex =
								activeWordIndex >= group.startIndex &&
								activeWordIndex <= group.endIndex
									? activeWordIndex
									: -1;
							const groupSelectionStartIndex =
								selection &&
								selection.endIndex >= group.startIndex &&
								selection.startIndex <= group.endIndex
									? selection.startIndex
									: -1;
							const groupSelectionEndIndex =
								groupSelectionStartIndex === -1
									? -1
									: (selection?.endIndex ?? -1);

							return (
								<div
									key={group.id}
									data-index={virtualGroup.index}
									ref={groupVirtualizer.measureElement}
									className="absolute left-0 top-0 w-full pb-6"
									style={{
										transform: `translateY(${virtualGroup.start}px)`,
									}}
								>
									<TranscriptGroupRow
										group={group}
										words={transcript.words}
										activeWordIndex={groupActiveWordIndex}
										selectionStartIndex={groupSelectionStartIndex}
										selectionEndIndex={groupSelectionEndIndex}
										deletedWordIds={deletedWordIds}
										searchMatchSet={searchMatchSet}
										previewFillers={previewFillers}
										wordElementsRef={wordElementsRef}
										onSeek={seekToWord}
										onWordPointerDown={handleWordPointerDown}
										onWordPointerEnter={handleWordPointerEnter}
									/>
								</div>
							);
						})}
					</div>
				</div>
				<div className="pointer-events-none absolute inset-x-0 top-0 h-3 bg-gradient-to-b from-gray-1 to-transparent" />
				<div className="pointer-events-none absolute inset-x-0 bottom-0 h-3 bg-gradient-to-t from-gray-1 to-transparent" />
			</div>

			<div className="border-t border-gray-3 p-3">
				{selection ? (
					<div className="flex animate-fadeIn items-center gap-1.5">
						<button
							type="button"
							onClick={deleteSelection}
							className="inline-flex h-9 min-w-0 flex-1 items-center justify-center gap-2 rounded-full bg-gray-12 px-4 text-xs font-semibold text-white transition hover:bg-gray-11 active:bg-gray-10"
						>
							<Trash2 className="size-3.5" aria-hidden />
							<span className="truncate">
								Delete {selectedWordCount} word
								{selectedWordCount === 1 ? "" : "s"}
							</span>
							<kbd className="rounded-[4px] bg-white/20 px-1 font-sans text-[10px] font-medium">
								⌫
							</kbd>
						</button>
						<button
							type="button"
							aria-label="Clear selection"
							title="Clear selection"
							onClick={clearSelection}
							className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-gray-9 transition hover:bg-gray-3 hover:text-gray-12"
						>
							<X className="size-4" aria-hidden />
						</button>
					</div>
				) : (
					<p className="flex h-9 animate-fadeIn items-center justify-center text-[11px] text-gray-9">
						Select words to remove them from the video
					</p>
				)}
			</div>
		</aside>
	);
}
