import { createEventListener } from "@solid-primitives/event-listener";
import { makePersisted } from "@solid-primitives/storage";
import { cx } from "cva";
import {
	batch,
	createEffect,
	createMemo,
	createSignal,
	For,
	on,
	Show,
} from "solid-js";
import { produce } from "solid-js/store";
import { commands } from "~/utils/tauri";
import {
	createCaptionTrackSegments,
	getCaptionTextFromWords,
} from "./captions";
import { FPS, useEditorContext } from "./context";
import {
	rippleDeleteAllTracks,
	shiftCaptionTimesAfterCut,
} from "./timeline-utils";

function formatTimePrecise(secs: number) {
	const minutes = Math.floor(secs / 60);
	const whole = Math.floor(secs % 60);
	const hundredths = Math.floor((secs % 1) * 100);
	return `${minutes}:${whole.toString().padStart(2, "0")}.${hundredths.toString().padStart(2, "0")}`;
}

interface FlatWord {
	text: string;
	start: number;
	end: number;
	segmentIndex: number;
	wordIndex: number;
}

interface TranscriptSegmentGroup {
	segmentIndex: number;
	startTime: number;
	words: FlatWord[];
}

const TEXT_SIZES = [
	{ label: "S", value: "text-xs leading-normal" },
	{ label: "M", value: "text-sm leading-normal" },
	{ label: "L", value: "text-base leading-snug" },
	{ label: "XL", value: "text-lg leading-snug" },
] as const;

export function TranscriptPanel() {
	const {
		editorState,
		setEditorState,
		project,
		setProject,
		totalDuration,
		previewResolutionBase,
	} = useEditorContext();

	const [textSizeIndex, setTextSizeIndex] = makePersisted(createSignal(1), {
		name: "editorTranscriptTextSize",
	});

	const allWords = createMemo((): FlatWord[] => {
		const segments = project.captions?.segments ?? [];
		const result: FlatWord[] = [];
		for (let segIdx = 0; segIdx < segments.length; segIdx++) {
			const seg = segments[segIdx];
			const words = seg.words ?? [];
			for (let wordIdx = 0; wordIdx < words.length; wordIdx++) {
				const w = words[wordIdx];
				result.push({
					text: w.text,
					start: w.start,
					end: w.end,
					segmentIndex: segIdx,
					wordIndex: wordIdx,
				});
			}
		}
		return result;
	});

	const segmentGroups = createMemo((): TranscriptSegmentGroup[] => {
		const words = allWords();
		const groups: TranscriptSegmentGroup[] = [];
		let currentGroup: TranscriptSegmentGroup | null = null;

		for (const word of words) {
			if (!currentGroup || currentGroup.segmentIndex !== word.segmentIndex) {
				currentGroup = {
					segmentIndex: word.segmentIndex,
					startTime: word.start,
					words: [],
				};
				groups.push(currentGroup);
			}
			currentGroup.words.push(word);
		}

		return groups;
	});

	const activeWordIndex = createMemo(() => {
		const time = editorState.playbackTime;
		const words = allWords();
		if (words.length === 0) return -1;

		let lo = 0;
		let hi = words.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			if (time >= words[mid].end) {
				lo = mid + 1;
			} else if (time < words[mid].start) {
				hi = mid - 1;
			} else {
				return mid;
			}
		}
		return -1;
	});

	const handleWordClick = async (word: FlatWord) => {
		try {
			if (editorState.playing) {
				await commands.stopPlayback();
				setEditorState("playing", false);
			}
			const frame = Math.max(Math.floor(word.start * FPS), 0);
			await commands.seekTo(frame);
			batch(() => {
				setEditorState("previewTime", null);
				setEditorState("playbackTime", word.start);
				editorState.timeline.transform.setPosition(
					word.start - editorState.timeline.transform.zoom / 2,
				);
			});
		} catch (error) {
			console.error("Failed to seek to word:", error);
		}
	};

	const applyWordDeletions = (flatIndices: number[]) => {
		const words = allWords();
		const wordsToDelete = flatIndices
			.map((idx) => words[idx])
			.filter((w): w is FlatWord => !!w);

		if (wordsToDelete.length === 0) return;

		const sorted = [...wordsToDelete].sort((a, b) => {
			if (a.segmentIndex !== b.segmentIndex)
				return b.segmentIndex - a.segmentIndex;
			return b.wordIndex - a.wordIndex;
		});

		const timeRanges = wordsToDelete
			.map((w) => ({ start: w.start, end: w.end }))
			.sort((a, b) => a.start - b.start);

		const mergedRanges: { start: number; end: number }[] = [];
		for (const range of timeRanges) {
			const last = mergedRanges[mergedRanges.length - 1];
			if (last && range.start <= last.end) {
				last.end = Math.max(last.end, range.end);
			} else {
				mergedRanges.push({ ...range });
			}
		}

		setProject(
			produce((p) => {
				if (!p.captions?.segments) return;

				for (const word of sorted) {
					const seg = p.captions.segments[word.segmentIndex];
					if (!seg?.words) continue;
					if (word.wordIndex < seg.words.length) {
						seg.words.splice(word.wordIndex, 1);
					}
				}

				for (let i = p.captions.segments.length - 1; i >= 0; i--) {
					const seg = p.captions.segments[i];
					if (!seg.words || seg.words.length === 0) {
						p.captions.segments.splice(i, 1);
					} else {
						seg.text = getCaptionTextFromWords(seg.words);
						seg.start = seg.words[0].start;
						seg.end = seg.words[seg.words.length - 1].end;
					}
				}

				const reversedRanges = [...mergedRanges].reverse();
				for (const range of reversedRanges) {
					const cutDuration = range.end - range.start;
					if (cutDuration <= 0.001) continue;

					shiftCaptionTimesAfterCut(
						p.captions.segments,
						range.start,
						cutDuration,
					);

					if (p.timeline) {
						rippleDeleteAllTracks(p.timeline, range.start, range.end);
					}
				}

				if (p.timeline && p.captions) {
					p.timeline.captionSegments = createCaptionTrackSegments(
						p.captions.segments,
					);
				}
			}),
		);

		setEditorState("captions", "isStale", false);

		const newDuration = project.timeline?.segments.reduce(
			(acc, s) => acc + (s.end - s.start) / s.timescale,
			0,
		);
		if (newDuration !== undefined && editorState.playbackTime > newDuration) {
			setEditorState("playbackTime", Math.max(newDuration - 0.01, 0));
		}
	};

	const handleDeleteWord = (flatIndex: number) => {
		applyWordDeletions([flatIndex]);
	};

	const handleDeleteWords = (flatIndices: number[]) => {
		applyWordDeletions(flatIndices);
	};

	const isAtEnd = () => {
		const total = totalDuration();
		return total > 0 && total - editorState.playbackTime <= 0.1;
	};

	const handlePlayPause = async () => {
		try {
			if (isAtEnd()) {
				await commands.stopPlayback();
				setEditorState("playbackTime", 0);
				await commands.seekTo(0);
				await commands.startPlayback(FPS, previewResolutionBase());
				setEditorState("playing", true);
			} else if (editorState.playing) {
				await commands.stopPlayback();
				setEditorState("playing", false);
			} else {
				await commands.seekTo(Math.floor(editorState.playbackTime * FPS));
				await commands.startPlayback(FPS, previewResolutionBase());
				setEditorState("playing", true);
			}
			if (editorState.playing) setEditorState("previewTime", null);
		} catch (error) {
			console.error("Error handling play/pause:", error);
			setEditorState("playing", false);
		}
	};

	createEffect(() => {
		if (isAtEnd() && editorState.playing) {
			void commands
				.stopPlayback()
				.then(() => {
					setEditorState("playing", false);
				})
				.catch((error) => {
					console.error("Error stopping playback:", error);
					setEditorState("playing", false);
				});
		}
	});

	createEventListener(window, "keydown", (e) => {
		if (e.code !== "Space") return;
		const el = document.activeElement;
		if (el) {
			const tag = el.tagName.toLowerCase();
			if (tag === "input" || tag === "textarea") return;
		}
		e.preventDefault();
		handlePlayPause();
	});

	return (
		<div class="flex flex-col min-h-0 h-full">
			<div class="px-3 py-2 border-b border-gray-3 flex items-center justify-between shrink-0">
				<span class="text-xs font-medium text-gray-12">Transcript</span>
				<div class="flex items-center gap-1">
					<button
						type="button"
						class="flex items-center justify-center size-5 rounded-sm hover:bg-gray-3 text-gray-9 hover:text-gray-12 transition-colors disabled:opacity-30 disabled:pointer-events-none"
						disabled={textSizeIndex() <= 0}
						onClick={() => setTextSizeIndex(Math.max(0, textSizeIndex() - 1))}
					>
						<IconLucideMinus class="size-3" />
					</button>
					<button
						type="button"
						class="flex items-center justify-center size-5 rounded-sm hover:bg-gray-3 text-gray-9 hover:text-gray-12 transition-colors disabled:opacity-30 disabled:pointer-events-none"
						disabled={textSizeIndex() >= TEXT_SIZES.length - 1}
						onClick={() =>
							setTextSizeIndex(
								Math.min(TEXT_SIZES.length - 1, textSizeIndex() + 1),
							)
						}
					>
						<IconLucidePlus class="size-3" />
					</button>
				</div>
			</div>
			<TranscriptEditor
				segmentGroups={segmentGroups()}
				allWords={allWords()}
				activeWordIndex={activeWordIndex()}
				textSizeClass={
					TEXT_SIZES[textSizeIndex()]?.value ?? TEXT_SIZES[1].value
				}
				onWordClick={handleWordClick}
				onDeleteWord={handleDeleteWord}
				onDeleteWords={handleDeleteWords}
			/>
		</div>
	);
}

function WordWithTooltip(props: {
	word: FlatWord;
	isActive: boolean;
	isSelected: boolean;
	selectedCount: number;
	ref: (el: HTMLSpanElement) => void;
	onClick: (e: MouseEvent) => void;
	onDelete: () => void;
}) {
	const [hovering, setHovering] = createSignal(false);
	let hoverTimer: number | undefined;

	const onEnter = () => {
		hoverTimer = window.setTimeout(() => setHovering(true), 350);
	};
	const onLeave = () => {
		clearTimeout(hoverTimer);
		setHovering(false);
	};

	const showTip = () =>
		hovering() || (props.isSelected && props.selectedCount === 1);

	return (
		<span
			ref={props.ref}
			class={cx(
				"cursor-pointer transition-colors duration-100 rounded-xs relative",
				props.isSelected && "bg-blue-4/50",
				props.isActive
					? "text-blue-11"
					: props.isSelected
						? "text-blue-11"
						: "text-gray-9 hover:text-gray-12",
			)}
			onClick={(e) => props.onClick(e)}
			onMouseEnter={onEnter}
			onMouseLeave={onLeave}
		>
			{props.word.text}
			<Show when={showTip()}>
				<span
					class="absolute left-1/2 -translate-x-1/2 top-full mt-1 flex items-center gap-2 whitespace-nowrap border border-gray-3 bg-gray-12 rounded-lg shadow-lg animate-in fade-in slide-in-from-top-1 duration-100 z-50 px-2 py-1.5"
					style={{ "pointer-events": props.isSelected ? "auto" : "none" }}
				>
					<span class="text-xs tabular-nums text-gray-1">
						{formatTimePrecise(props.word.start)}
					</span>
					<Show when={props.isSelected}>
						<button
							type="button"
							class="flex items-center justify-center size-6 rounded-md bg-red-9 text-white hover:bg-red-10 transition-colors"
							onClick={(e) => {
								e.stopPropagation();
								props.onDelete();
							}}
						>
							<IconCapTrash class="size-3.5" />
						</button>
					</Show>
				</span>
			</Show>
		</span>
	);
}

function TranscriptEditor(props: {
	segmentGroups: TranscriptSegmentGroup[];
	allWords: FlatWord[];
	activeWordIndex: number;
	textSizeClass: string;
	onWordClick: (word: FlatWord) => void;
	onDeleteWord: (flatIndex: number) => void;
	onDeleteWords: (flatIndices: number[]) => void;
}) {
	const [selectedIndices, setSelectedIndices] = createSignal<Set<number>>(
		new Set(),
	);
	const [anchorIndex, setAnchorIndex] = createSignal<number>(-1);
	let scrollContainerRef: HTMLDivElement | undefined;
	let activeWordRef: HTMLSpanElement | undefined;

	const flatIndexMap = createMemo(() => {
		const map = new Map<string, number>();
		for (let i = 0; i < props.allWords.length; i++) {
			const w = props.allWords[i];
			map.set(`${w.segmentIndex}:${w.wordIndex}`, i);
		}
		return map;
	});

	const flatIndexOf = (word: FlatWord) =>
		flatIndexMap().get(`${word.segmentIndex}:${word.wordIndex}`) ?? -1;

	const selectedCount = () => selectedIndices().size;

	createEffect(
		on(
			() => props.activeWordIndex,
			(idx) => {
				if (idx >= 0 && activeWordRef && scrollContainerRef) {
					const container = scrollContainerRef;
					const el = activeWordRef;
					const containerRect = container.getBoundingClientRect();
					const elRect = el.getBoundingClientRect();

					if (
						elRect.top < containerRect.top + 40 ||
						elRect.bottom > containerRect.bottom - 40
					) {
						el.scrollIntoView({
							behavior: "smooth",
							block: "center",
						});
					}
				}
			},
		),
	);

	const handleKeyDown = (e: KeyboardEvent) => {
		const selected = selectedIndices();
		if (selected.size === 0) return;

		if (e.key === "Backspace" || e.key === "Delete") {
			e.preventDefault();
			const indices = [...selected];
			if (indices.length === 1) {
				props.onDeleteWord(indices[0]);
			} else {
				props.onDeleteWords(indices);
			}
			setSelectedIndices(new Set<number>());
			setAnchorIndex(-1);
		} else if (e.key === "ArrowLeft") {
			e.preventDefault();
			const minIdx = Math.min(...selected);
			const prev = Math.max(minIdx - 1, 0);
			setSelectedIndices(new Set([prev]));
			setAnchorIndex(prev);
			const word = props.allWords[prev];
			if (word) props.onWordClick(word);
		} else if (e.key === "ArrowRight") {
			e.preventDefault();
			const maxIdx = Math.max(...selected);
			const next = Math.min(maxIdx + 1, props.allWords.length - 1);
			setSelectedIndices(new Set([next]));
			setAnchorIndex(next);
			const word = props.allWords[next];
			if (word) props.onWordClick(word);
		}
	};

	const handleContainerClick = (e: MouseEvent) => {
		if (e.target === scrollContainerRef) {
			setSelectedIndices(new Set<number>());
			setAnchorIndex(-1);
		}
	};

	const handleWordSelect = (word: FlatWord, e: MouseEvent) => {
		const idx = flatIndexOf(word);
		const isCtrlOrCmd = e.ctrlKey || e.metaKey;
		const isShift = e.shiftKey;

		if (isShift && anchorIndex() >= 0) {
			const anchor = anchorIndex();
			const start = Math.min(anchor, idx);
			const end = Math.max(anchor, idx);

			if (isCtrlOrCmd) {
				setSelectedIndices((prev) => {
					const next = new Set(prev);
					for (let i = start; i <= end; i++) {
						next.add(i);
					}
					return next;
				});
			} else {
				const next = new Set<number>();
				for (let i = start; i <= end; i++) {
					next.add(i);
				}
				setSelectedIndices(next);
			}
		} else if (isCtrlOrCmd) {
			setSelectedIndices((prev) => {
				const next = new Set(prev);
				if (next.has(idx)) {
					next.delete(idx);
				} else {
					next.add(idx);
				}
				return next;
			});
			setAnchorIndex(idx);
		} else {
			setSelectedIndices(new Set([idx]));
			setAnchorIndex(idx);
		}

		props.onWordClick(word);
	};

	const handleWordDelete = (word: FlatWord) => {
		const selected = selectedIndices();
		if (selected.size > 1) {
			props.onDeleteWords([...selected]);
		} else {
			props.onDeleteWord(flatIndexOf(word));
		}
		setSelectedIndices(new Set<number>());
		setAnchorIndex(-1);
	};

	return (
		<div
			ref={scrollContainerRef}
			class="flex-1 overflow-y-auto overflow-x-hidden px-4 py-3 pb-8 focus:outline-hidden w-full"
			tabIndex={0}
			onKeyDown={handleKeyDown}
			onClick={handleContainerClick}
		>
			<Show
				when={props.segmentGroups.length > 0}
				fallback={
					<div class="flex flex-col items-center justify-center h-full text-gray-9">
						<IconCapCaptions class="size-10 mb-3 text-gray-7" />
						<span class="text-sm">No transcript available</span>
						<span class="text-xs mt-1">
							Generate captions in the editor first
						</span>
					</div>
				}
			>
				<div
					class={cx("flex flex-wrap gap-x-1 gap-y-0.5", props.textSizeClass)}
				>
					<For each={props.segmentGroups}>
						{(group) => (
							<For each={group.words}>
								{(word) => {
									const flatIdx = () => flatIndexOf(word);
									const isActive = () => props.activeWordIndex === flatIdx();
									const isSelected = () => selectedIndices().has(flatIdx());

									return (
										<WordWithTooltip
											word={word}
											isActive={isActive()}
											isSelected={isSelected()}
											selectedCount={selectedCount()}
											ref={(el: HTMLSpanElement) => {
												if (isActive()) activeWordRef = el;
											}}
											onClick={(e: MouseEvent) => handleWordSelect(word, e)}
											onDelete={() => handleWordDelete(word)}
										/>
									);
								}}
							</For>
						)}
					</For>
				</div>
			</Show>
		</div>
	);
}
