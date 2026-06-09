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
import type { CaptionWordExtended } from "./caption-types";
import {
	createCaptionTrackSegments,
	getCaptionTextFromWords,
} from "./captions";
import { FPS, useEditorContext } from "./context";
import {
	AUTO_CLEAN_SILENCE_THRESHOLD,
	DEFAULT_PAUSE_BUFFER,
	isFillerWord,
} from "./filler-detection";
import {
	rippleDeleteAllTracks,
	rippleInsertAllTracks,
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
	storedEnd: number;
	segmentIndex: number;
	wordIndex: number;
	deleted: boolean;
	isFiller: boolean;
	isPause: boolean;
	bufferStart: number;
	bufferEnd: number;
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
			const words = (seg.words ?? []) as CaptionWordExtended[];
			for (let wordIdx = 0; wordIdx < words.length; wordIdx++) {
				const w = words[wordIdx];

				const start = w.start;
				let end = w.end;
				if (!w.isPause) {
					const duration = w.end - w.start;
					const maxDuration = Math.max(0.5, Math.min(1.5, w.text.length * 0.1));
					if (duration > maxDuration + 0.3) {
						// Parakeet TDT attaches trailing silence to the END of the word.
						// We must cap w.end so the spoken word is preserved at the beginning of the timestamp block,
						// exposing the silence AFTER the word.
						end = w.start + maxDuration;
					}
				}

				result.push({
					text: w.text,
					start,
					end,
					storedEnd: w.end,
					segmentIndex: segIdx,
					wordIndex: wordIdx,
					deleted: w.deleted ?? false,
					isFiller: w.isFiller || isFillerWord(w.text),
					isPause: w.isPause ?? false,
					bufferStart: w.bufferStart ?? 0,
					bufferEnd: w.bufferEnd ?? 0,
				});
			}
		}
		return result;
	});

	const fillerCount = createMemo(
		() => allWords().filter((w) => w.isFiller && !w.deleted).length,
	);

	const pauseCount = createMemo(
		() => allWords().filter((w) => w.isPause && !w.deleted).length,
	);

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
		return words.findIndex(
			(w) => !w.deleted && time >= w.start && time < w.end,
		);
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
			.filter((w): w is FlatWord => !!w && !w.deleted);

		if (wordsToDelete.length === 0) return;

		const timeRanges = wordsToDelete
			.map((w) => ({
				start: Math.max(0, w.start - (w.bufferStart || 0)),
				end: w.storedEnd + (w.bufferEnd || 0),
			}))
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

				for (const word of wordsToDelete) {
					const seg = p.captions.segments[word.segmentIndex];
					if (seg?.words) {
						const w = seg.words[word.wordIndex] as CaptionWordExtended;
						if (w) {
							seg.words[word.wordIndex] = { ...w, deleted: true };
						}
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

				for (const seg of p.captions.segments) {
					const extWords = (seg.words ?? []) as CaptionWordExtended[];
					seg.text = getCaptionTextFromWords(extWords);
					if (seg.words && seg.words.length > 0) {
						const visible = extWords.filter((w) => !w.deleted);
						if (visible.length > 0) {
							seg.start = visible[0].start;
							seg.end = visible[visible.length - 1].end;
						}
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

	const restoreWords = (flatIndices: number[]) => {
		const words = allWords();
		const wordsToRestore = flatIndices
			.map((idx) => words[idx])
			.filter((w): w is FlatWord => !!w && w.deleted);

		if (wordsToRestore.length === 0) return;

		setProject(
			produce((p) => {
				if (!p.captions?.segments) return;

				const sortedByIndex = [...wordsToRestore].sort(
					(a, b) =>
						b.segmentIndex - a.segmentIndex || b.wordIndex - a.wordIndex,
				);

				// Process earliest-to-latest so each word's stored position already reflects all prior restorations when we compute insertDuration.
				const chronologicalWords = [...sortedByIndex].reverse();

				for (const word of chronologicalWords) {
					const seg = p.captions.segments[word.segmentIndex];
					if (!seg?.words) continue;
					const w = seg.words[word.wordIndex] as CaptionWordExtended;

					const insertDuration =
						w.end +
						(w.bufferEnd || 0) -
						Math.max(0, w.start - (w.bufferStart || 0));
					if (insertDuration <= 0.001) continue;

					// Shift all words AFTER this word
					for (let i = 0; i < p.captions.segments.length; i++) {
						const s = p.captions.segments[i];
						if (!s.words) continue;
						for (let j = 0; j < s.words.length; j++) {
							if (
								i < word.segmentIndex ||
								(i === word.segmentIndex && j <= word.wordIndex)
							) {
								continue;
							}
							const cw = s.words[j] as CaptionWordExtended;
							cw.start += insertDuration;
							cw.end += insertDuration;
						}
					}

					if (p.timeline) {
						rippleInsertAllTracks(
							p.timeline,
							Math.max(0, w.start - (w.bufferStart || 0)),
							insertDuration,
						);
					}
				}

				for (const word of sortedByIndex) {
					const seg = p.captions.segments[word.segmentIndex];
					if (!seg?.words) continue;
					const w = seg.words[word.wordIndex] as CaptionWordExtended;
					if (w) {
						w.deleted = false;
						w.bufferStart = 0;
						w.bufferEnd = 0;
					}
				}

				for (const seg of p.captions.segments) {
					const extWords = (seg.words ?? []) as CaptionWordExtended[];
					seg.text = getCaptionTextFromWords(extWords);
					if (extWords.length > 0) {
						const visible = extWords.filter((w) => !w.deleted);
						if (visible.length > 0) {
							seg.start = visible[0].start;
							seg.end = visible[visible.length - 1].end;
						}
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
	};

	const handleDeleteWord = (flatIndex: number) => {
		applyWordDeletions([flatIndex]);
	};

	const handleDeleteWords = (flatIndices: number[]) => {
		applyWordDeletions(flatIndices);
	};

	const handleRestoreWord = (flatIndex: number) => {
		restoreWords([flatIndex]);
	};

	const handleRestoreWords = (flatIndices: number[]) => {
		restoreWords(flatIndices);
	};

	const [silenceThreshold, setSilenceThreshold] = makePersisted(
		createSignal(AUTO_CLEAN_SILENCE_THRESHOLD),
		{ name: "editorAutoCleanThreshold" },
	);

	const cleanablePauseCount = createMemo(
		() =>
			allWords().filter(
				(w) =>
					w.isPause &&
					!w.deleted &&
					w.storedEnd - w.start >= silenceThreshold(),
			).length,
	);

	const autoClean = () => {
		const words = allWords();
		const threshold = silenceThreshold();

		const keeperWords = words.filter(
			(w) => !w.deleted && !w.isFiller && !w.isPause,
		);

		if (keeperWords.length === 0) return;

		setProject(
			produce((p) => {
				if (!p.captions?.segments) return;

				for (let segIdx = 0; segIdx < p.captions.segments.length; segIdx++) {
					const seg = p.captions.segments[segIdx];
					if (!seg.words) continue;
					for (let wIdx = 0; wIdx < seg.words.length; wIdx++) {
						const w = seg.words[wIdx] as CaptionWordExtended;
						if (w && !w.deleted && (w.isFiller || isFillerWord(w.text))) {
							seg.words[wIdx] = { ...w, deleted: true };
						}
					}
				}

				for (const kw of keeperWords) {
					const seg = p.captions.segments[kw.segmentIndex];
					if (!seg?.words) continue;
					const w = seg.words[kw.wordIndex];
					if (w && !w.deleted) {
						const duration = w.end - w.start;
						const maxDuration = Math.max(
							0.5,
							Math.min(1.5, w.text.length * 0.1),
						);
						if (duration > maxDuration + 0.3) {
							w.end = w.start + maxDuration;
						}
					}
				}

				const timeRanges: Array<{ start: number; end: number }> = [];
				const pauseInsertions: Array<{
					segmentIndex: number;
					insertIdx: number;
					pauseWord: CaptionWordExtended;
				}> = [];

				for (let i = -1; i < keeperWords.length - 1; i++) {
					const curr = i >= 0 ? keeperWords[i] : null;
					const next = keeperWords[i + 1];

					const currSeg = curr ? p.captions.segments[curr.segmentIndex] : null;
					const currWord =
						currSeg?.words && curr ? currSeg.words[curr.wordIndex] : null;

					const nextSeg = p.captions.segments[next.segmentIndex];
					const nextWord = nextSeg?.words?.[next.wordIndex];

					const gapStart = currWord ? currWord.end : curr ? curr.end : 0;
					const gapEnd = nextWord ? nextWord.start : next.start;
					const gap = gapEnd - gapStart;

					if (gap < 0.001) continue;

					let hasFillerInGap = false;
					for (const w of words) {
						if (w.deleted || w.isPause) continue;
						if (!w.isFiller) continue;
						if (w.start >= gapStart - 0.01 && w.end <= gapEnd + 0.01) {
							hasFillerInGap = true;
							break;
						}
					}

					const shouldCut = hasFillerInGap || gap >= threshold;

					if (shouldCut) {
						timeRanges.push({ start: gapStart, end: gapEnd });

						if (gap >= threshold) {
							const targetSegIdx = curr ? curr.segmentIndex : next.segmentIndex;
							const insertIdx = curr ? curr.wordIndex + 1 : 0;
							pauseInsertions.push({
								segmentIndex: targetSegIdx,
								insertIdx,
								pauseWord: {
									text: `[Pause ${gap.toFixed(1)}s]`,
									start: gapStart,
									end: gapEnd,
									deleted: true,
									isPause: true,
									isFiller: false,
									bufferStart: DEFAULT_PAUSE_BUFFER,
									bufferEnd: DEFAULT_PAUSE_BUFFER,
								},
							});
						}
					}
				}

				pauseInsertions.sort(
					(a, b) =>
						b.segmentIndex - a.segmentIndex || b.insertIdx - a.insertIdx,
				);

				for (const ins of pauseInsertions) {
					const targetSeg = p.captions.segments[ins.segmentIndex];
					if (targetSeg?.words) {
						targetSeg.words.splice(ins.insertIdx, 0, ins.pauseWord);
					}
				}

				timeRanges.sort((a, b) => a.start - b.start);
				const mergedRanges: { start: number; end: number }[] = [];
				for (const range of timeRanges) {
					const last = mergedRanges[mergedRanges.length - 1];
					if (last && range.start <= last.end) {
						last.end = Math.max(last.end, range.end);
					} else {
						mergedRanges.push({ ...range });
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

				for (const seg of p.captions.segments) {
					const extWords = (seg.words ?? []) as CaptionWordExtended[];
					seg.text = getCaptionTextFromWords(extWords);
					if (seg.words && seg.words.length > 0) {
						const visible = extWords.filter((w) => !w.deleted);
						if (visible.length > 0) {
							seg.start = visible[0].start;
							seg.end = visible[visible.length - 1].end;
						}
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

	const [showAutoCleanDropdown, setShowAutoCleanDropdown] = createSignal(false);
	let autoCleanDropdownRef: HTMLDivElement | undefined;

	createEventListener(document, "mousedown", (e: MouseEvent) => {
		if (
			showAutoCleanDropdown() &&
			autoCleanDropdownRef &&
			!autoCleanDropdownRef.contains(e.target as Node)
		) {
			setShowAutoCleanDropdown(false);
		}
	});

	return (
		<div class="flex flex-col min-h-0 h-full">
			<div class="px-3 py-2 border-b border-gray-3 flex items-center justify-between shrink-0">
				<span class="text-xs font-medium text-gray-12">Transcript</span>
				<div class="flex items-center gap-1">
					<Show when={fillerCount() > 0 || pauseCount() > 0}>
						<span class="text-[10px] text-gray-9 mr-1">
							{fillerCount() > 0 &&
								`${fillerCount()} filler${fillerCount() > 1 ? "s" : ""}`}
							{fillerCount() > 0 && pauseCount() > 0 && ", "}
							{pauseCount() > 0 &&
								`${pauseCount()} pause${pauseCount() > 1 ? "s" : ""}`}
						</span>
					</Show>

					<div class="relative" ref={autoCleanDropdownRef}>
						<div class="flex">
							<button
								type="button"
								class="flex items-center gap-1 px-2 py-1 rounded-l-md text-[10px] font-medium bg-blue-9 text-white hover:bg-blue-10 transition-colors disabled:opacity-30 disabled:pointer-events-none"
								disabled={fillerCount() === 0 && cleanablePauseCount() === 0}
								onClick={() => autoClean()}
							>
								<IconLucideSparkles class="size-3" />
								Auto Clean
							</button>
							<button
								type="button"
								class="flex items-center justify-center px-1 py-1 rounded-r-md bg-blue-9 text-white hover:bg-blue-10 transition-colors border-l border-blue-8 disabled:opacity-30 disabled:pointer-events-none"
								disabled={fillerCount() === 0 && pauseCount() === 0}
								onClick={() =>
									setShowAutoCleanDropdown(!showAutoCleanDropdown())
								}
							>
								<IconLucideChevronDown class="size-3" />
							</button>
						</div>
						<Show when={showAutoCleanDropdown()}>
							<div class="absolute right-0 top-full mt-1 z-50 bg-gray-2 border border-gray-4 rounded-lg shadow-lg p-3 w-48">
								<div class="text-[10px] font-medium text-gray-11 mb-2">
									Silence Threshold
								</div>
								<div class="flex items-center gap-2">
									<input
										type="range"
										min="0.5"
										max="5.0"
										step="0.1"
										value={silenceThreshold()}
										onInput={(e) =>
											setSilenceThreshold(
												Number.parseFloat(e.currentTarget.value),
											)
										}
										class="flex-1 h-1 accent-blue-9"
									/>
									<span class="text-[10px] tabular-nums text-gray-11 w-8 text-right">
										{silenceThreshold().toFixed(1)}s
									</span>
								</div>
								<button
									type="button"
									class="mt-2 w-full px-2 py-1 rounded-md text-[10px] font-medium bg-blue-9 text-white hover:bg-blue-10 transition-colors disabled:opacity-30 disabled:pointer-events-none"
									disabled={fillerCount() === 0 && cleanablePauseCount() === 0}
									onClick={() => {
										autoClean();
										setShowAutoCleanDropdown(false);
									}}
								>
									Clean Now
								</button>
							</div>
						</Show>
					</div>
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
				onRestoreWord={handleRestoreWord}
				onRestoreWords={handleRestoreWords}
			/>
		</div>
	);
}

function BufferPopover(props: {
	word: FlatWord;
	position: { x: number; y: number };
	onClose: () => void;
	onBufferChange: (
		segmentIndex: number,
		wordIndex: number,
		bufferStart: number,
		bufferEnd: number,
	) => void;
	onRestore: () => void;
}) {
	const wordDuration = Math.max(0, props.word.end - props.word.start);
	const minBuffer = Number(Math.max(-0.5, -(wordDuration / 2)).toFixed(2));

	const [bufStart, setBufStart] = createSignal(
		Math.max(minBuffer, props.word.bufferStart),
	);
	const [bufEnd, setBufEnd] = createSignal(
		Math.max(minBuffer, props.word.bufferEnd),
	);
	let popoverRef: HTMLDivElement | undefined;

	const handleClickOutside = (e: MouseEvent) => {
		if (popoverRef && !popoverRef.contains(e.target as Node)) {
			props.onClose();
		}
	};

	const handleEscape = (e: KeyboardEvent) => {
		if (e.key === "Escape") props.onClose();
	};

	createEventListener(document, "mousedown", handleClickOutside);
	createEventListener(window, "keydown", handleEscape);

	const updateBuffer = (start: number, end: number) => {
		setBufStart(start);
		setBufEnd(end);
		props.onBufferChange(
			props.word.segmentIndex,
			props.word.wordIndex,
			start,
			end,
		);
	};

	const popoverStyle = () => {
		const x = Math.min(props.position.x, window.innerWidth - 220);
		const y = Math.min(props.position.y, window.innerHeight - 200);
		return {
			position: "fixed" as const,
			left: `${x}px`,
			top: `${y}px`,
			"z-index": "9999",
		};
	};

	return (
		<div ref={popoverRef} style={popoverStyle()}>
			<div class="bg-gray-2 border border-gray-4 rounded-lg shadow-xl p-3 w-52 animate-in fade-in zoom-in-95 duration-100">
				<div class="flex items-center justify-between mb-2">
					<span class="text-[11px] font-medium text-gray-12">
						Adjust Buffer
					</span>
					<button
						type="button"
						class="size-4 flex items-center justify-center rounded hover:bg-gray-4 text-gray-9"
						onClick={props.onClose}
					>
						<IconLucideX class="size-3" />
					</button>
				</div>
				<p class="text-[9px] text-gray-9 mb-3">
					Buffer around deleted word to preserve pronunciations.
				</p>

				<div class="space-y-2">
					<div>
						<div class="flex items-center justify-between mb-1">
							<span class="text-[10px] text-gray-11">Start Buffer</span>
							<span class="text-[10px] tabular-nums text-gray-11">
								{bufStart().toFixed(2)}s
							</span>
						</div>
						<input
							type="range"
							min={minBuffer}
							max="1.0"
							step="0.01"
							value={bufStart()}
							onInput={(e) =>
								setBufStart(Number.parseFloat(e.currentTarget.value))
							}
							onChange={(e) =>
								updateBuffer(Number.parseFloat(e.currentTarget.value), bufEnd())
							}
							class="w-full h-1 accent-blue-9"
						/>
					</div>
					<div>
						<div class="flex items-center justify-between mb-1">
							<span class="text-[10px] text-gray-11">End Buffer</span>
							<span class="text-[10px] tabular-nums text-gray-11">
								{bufEnd().toFixed(2)}s
							</span>
						</div>
						<input
							type="range"
							min={minBuffer}
							max="1.0"
							step="0.01"
							value={bufEnd()}
							onInput={(e) =>
								setBufEnd(Number.parseFloat(e.currentTarget.value))
							}
							onChange={(e) =>
								updateBuffer(
									bufStart(),
									Number.parseFloat(e.currentTarget.value),
								)
							}
							class="w-full h-1 accent-blue-9"
						/>
					</div>
				</div>

				<Show when={props.word.deleted}>
					<button
						type="button"
						class="mt-3 w-full px-2 py-1.5 rounded-md text-[10px] font-medium bg-green-9 text-white hover:bg-green-10 transition-colors flex items-center justify-center gap-1"
						onClick={props.onRestore}
					>
						<IconLucideRotateCcw class="size-3" />
						Restore Word
					</button>
				</Show>
			</div>
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
	onRestore: () => void;
	onContextMenu: (e: MouseEvent) => void;
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
				props.word.deleted
					? "line-through opacity-40 text-red-9 bg-red-3/30"
					: props.word.isFiller
						? "border-b-2 border-dotted border-amber-8/80 bg-amber-3/15"
						: "",
				!props.word.deleted && props.isSelected && "bg-blue-4/50",
				props.word.deleted
					? "hover:opacity-60"
					: props.isActive
						? "text-blue-11"
						: props.isSelected
							? "text-blue-11"
							: "text-gray-9 hover:text-gray-12",
			)}
			onClick={(e) => props.onClick(e)}
			onContextMenu={(e) => {
				e.preventDefault();
				props.onContextMenu(e);
			}}
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
						<Show
							when={props.word.deleted}
							fallback={
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
							}
						>
							<button
								type="button"
								class="flex items-center justify-center size-6 rounded-md bg-green-9 text-white hover:bg-green-10 transition-colors"
								onClick={(e) => {
									e.stopPropagation();
									props.onRestore();
								}}
							>
								<IconLucideRotateCcw class="size-3.5" />
							</button>
						</Show>
					</Show>
				</span>
			</Show>
		</span>
	);
}

function PauseBadge(props: { word: FlatWord; onDelete: () => void }) {
	const duration = props.word.storedEnd - props.word.start;
	return (
		<span
			class={cx(
				"group relative inline-flex items-center px-1.5 py-0.5 mx-0.5 rounded border border-dashed text-[10px] select-none cursor-default",
				props.word.deleted
					? "border-gray-4 text-gray-6 bg-gray-2/30 line-through opacity-40"
					: "border-gray-6 text-gray-8 bg-gray-3/30",
			)}
		>
			⏸ {duration.toFixed(1)}s
			<button
				type="button"
				class="absolute -top-1.5 -right-1.5 hidden group-hover:flex items-center justify-center size-4 rounded-full bg-red-9 text-white hover:bg-red-10 transition-colors z-50 shadow-sm"
				onClick={(e) => {
					e.stopPropagation();
					props.onDelete();
				}}
				title={props.word.deleted ? "Restore pause" : "Delete pause"}
			>
				<Show
					when={!props.word.deleted}
					fallback={<IconLucideRotateCcw class="size-2.5" />}
				>
					<IconCapTrash class="size-2.5" />
				</Show>
			</button>
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
	onRestoreWord: (flatIndex: number) => void;
	onRestoreWords: (flatIndices: number[]) => void;
}) {
	const { editorState, setProject, setEditorState } = useEditorContext();
	const [selectedIndices, setSelectedIndices] = createSignal<Set<number>>(
		new Set(),
	);
	const [anchorIndex, setAnchorIndex] = createSignal<number>(-1);
	const [bufferPopover, setBufferPopover] = createSignal<{
		word: FlatWord;
		flatIndex: number;
		position: { x: number; y: number };
	} | null>(null);
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
			const toDelete = indices.filter((i) => !props.allWords[i]?.deleted);
			const toRestore = indices.filter((i) => props.allWords[i]?.deleted);

			if (toDelete.length > 0) {
				if (toDelete.length === 1) {
					props.onDeleteWord(toDelete[0]);
				} else {
					props.onDeleteWords(toDelete);
				}
			} else if (toRestore.length > 0) {
				if (toRestore.length === 1) {
					props.onRestoreWord(toRestore[0]);
				} else {
					props.onRestoreWords(toRestore);
				}
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

	const handleWordRestore = (word: FlatWord) => {
		const selected = selectedIndices();
		if (selected.size > 1) {
			props.onRestoreWords([...selected]);
		} else {
			props.onRestoreWord(flatIndexOf(word));
		}
		setSelectedIndices(new Set<number>());
		setAnchorIndex(-1);
	};

	const handleContextMenu = (word: FlatWord, e: MouseEvent) => {
		if (word.deleted) {
			setBufferPopover({
				word,
				flatIndex: flatIndexOf(word),
				position: { x: e.clientX, y: e.clientY },
			});
		}
	};

	const handleBufferChange = async (
		segmentIndex: number,
		wordIndex: number,
		bufferStart: number,
		bufferEnd: number,
	) => {
		if (editorState.playing) {
			await commands.stopPlayback();
			setEditorState("playing", false);
		}

		let appliedDelta = 0;
		const currentTime = editorState.playbackTime;

		setProject(
			produce((p) => {
				if (!p.captions?.segments) return;
				const seg = p.captions.segments[segmentIndex];
				if (!seg?.words) return;
				const w = seg.words[wordIndex] as CaptionWordExtended;
				if (!w) return;

				if (w.deleted) {
					const oldCutStart = Math.max(0, w.start - (w.bufferStart || 0));
					const oldCutEnd = w.end + (w.bufferEnd || 0);
					const oldDuration = Math.max(0, oldCutEnd - oldCutStart);

					const newCutStart = Math.max(0, w.start - bufferStart);
					const newCutEnd = w.end + bufferEnd;
					const newDuration = Math.max(0, newCutEnd - newCutStart);

					w.bufferStart = bufferStart;
					w.bufferEnd = bufferEnd;
					if (oldDuration > 0.001) {
						for (let i = 0; i < p.captions.segments.length; i++) {
							const s = p.captions.segments[i];
							if (!s.words) continue;
							for (let j = 0; j < s.words.length; j++) {
								if (
									i < segmentIndex ||
									(i === segmentIndex && j <= wordIndex)
								) {
									continue; // Do not shift words before or equal to the anchor
								}
								const cw = s.words[j] as CaptionWordExtended;
								cw.start += oldDuration;
								cw.end += oldDuration;
							}
						}

						if (p.timeline) {
							rippleInsertAllTracks(p.timeline, oldCutStart, oldDuration);
						}
						if (currentTime > oldCutStart) {
							appliedDelta += oldDuration;
						}
					}

					if (newDuration > 0.001) {
						for (let i = 0; i < p.captions.segments.length; i++) {
							const s = p.captions.segments[i];
							if (!s.words) continue;
							for (let j = 0; j < s.words.length; j++) {
								if (
									i < segmentIndex ||
									(i === segmentIndex && j <= wordIndex)
								) {
									continue; // Do not shift words before or equal to the anchor
								}
								const cw = s.words[j] as CaptionWordExtended;

								cw.start -= newDuration;
								cw.end -= newDuration;
							}
						}

						if (p.timeline) {
							rippleDeleteAllTracks(p.timeline, newCutStart, newCutEnd);
						}
						if (currentTime > newCutStart) {
							appliedDelta -= newDuration;
						}
					}

					for (const s of p.captions.segments) {
						const extWords = (s.words ?? []) as CaptionWordExtended[];
						const visible = extWords.filter((vw) => !vw.deleted);
						if (visible.length > 0) {
							s.start = visible[0].start;
							s.end = visible[visible.length - 1].end;
						}
					}

					if (p.timeline) {
						p.timeline.captionSegments = createCaptionTrackSegments(
							p.captions.segments,
						);
					}
				} else {
					w.bufferStart = bufferStart;
					w.bufferEnd = bufferEnd;
				}
			}),
		);
		setEditorState("captions", "isStale", false);

		if (Math.abs(appliedDelta) > 0.001) {
			const newTime = Math.max(0, currentTime + appliedDelta);
			setEditorState("playbackTime", newTime);
			const frame = Math.max(Math.floor(newTime * FPS), 0);
			await commands.seekTo(frame);
		}
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

									if (word.isPause) {
										return (
											<PauseBadge
												word={word}
												onDelete={() => {
													if (word.deleted) {
														handleWordRestore(word);
													} else {
														handleWordDelete(word);
													}
												}}
											/>
										);
									}

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
											onRestore={() => handleWordRestore(word)}
											onContextMenu={(e: MouseEvent) =>
												handleContextMenu(word, e)
											}
										/>
									);
								}}
							</For>
						)}
					</For>
				</div>
			</Show>
			<Show when={bufferPopover()}>
				{(popover) => (
					<BufferPopover
						word={popover().word}
						position={popover().position}
						onClose={() => setBufferPopover(null)}
						onBufferChange={handleBufferChange}
						onRestore={() => {
							handleWordRestore(popover().word);
							setBufferPopover(null);
						}}
					/>
				)}
			</Show>
		</div>
	);
}
