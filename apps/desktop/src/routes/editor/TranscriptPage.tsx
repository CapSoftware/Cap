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
	isFillerWord,
	PAUSE_DETECTION_THRESHOLD,
} from "./filler-detection";
import {
	rippleDeleteAllTracks,
	rippleInsertAllTracks,
	shiftCaptionTimesAfterCut,
	shiftCaptionTimesAfterInsert,
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
	deleted: boolean;
	isFiller: boolean;
	isPause: boolean;
	bufferStart: number;
	bufferEnd: number;
}

interface PauseIndicator {
	type: "pause";
	start: number;
	end: number;
	duration: number;
	afterSegmentIndex: number;
	afterWordIndex: number;
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

const DEFAULT_PAUSE_BUFFER = 0.0;

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
					segmentIndex: segIdx,
					wordIndex: wordIdx,
					deleted: w.deleted ?? false,
					isFiller: w.isFiller ?? isFillerWord(w.text),
					isPause: w.isPause ?? false,
					bufferStart: w.bufferStart ?? 0,
					bufferEnd: w.bufferEnd ?? 0,
				});
			}
		}
		return result;
	});

	const pauses = createMemo((): PauseIndicator[] => {
		const words = allWords();
		const result: PauseIndicator[] = [];
		let lastVisible: (typeof words)[0] | null = null;

		for (let i = 0; i < words.length; i++) {
			const curr = words[i];
			if (curr.deleted) continue;

			if (!lastVisible) {
				const gap = curr.start;
				if (gap >= PAUSE_DETECTION_THRESHOLD) {
					result.push({
						type: "pause",
						start: 0,
						end: curr.start,
						duration: gap,
						afterSegmentIndex: curr.segmentIndex,
						afterWordIndex: -1,
					});
				}
			} else {
				const gap = curr.start - lastVisible.end;
				if (gap >= PAUSE_DETECTION_THRESHOLD) {
					result.push({
						type: "pause",
						start: lastVisible.end,
						end: curr.start,
						duration: gap,
						afterSegmentIndex: lastVisible.segmentIndex,
						afterWordIndex: lastVisible.wordIndex,
					});
				}
			}
			lastVisible = curr;
		}
		return result;
	});

	const fillerCount = createMemo(
		() => allWords().filter((w) => w.isFiller && !w.deleted).length,
	);

	const pauseCount = createMemo(() => pauses().length);

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
			.filter((w): w is FlatWord => !!w && !w.deleted);

		if (wordsToDelete.length === 0) return;

		const timeRanges = wordsToDelete
			.map((w) => ({
				start: Math.max(0, w.start - (w.bufferStart || 0)),
				end: w.end + (w.bufferEnd || 0),
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

				const reversedRanges = [...mergedRanges].reverse();
				for (const range of reversedRanges) {
					const cutDuration = range.end - range.start;
					if (cutDuration <= 0.001) continue;

					shiftCaptionTimesAfterCut(
						p.captions.segments,
						range.start,
						cutDuration,
						wordsToDelete.map((w) => ({
							segmentIndex: w.segmentIndex,
							wordIndex: w.wordIndex,
						})),
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

	const restoreWords = (flatIndices: number[]) => {
		const words = allWords();
		const wordsToRestore = flatIndices
			.map((idx) => words[idx])
			.filter((w): w is FlatWord => !!w && w.deleted);

		if (wordsToRestore.length === 0) return;

		const timeRanges = wordsToRestore
			.map((w) => ({
				start: Math.max(0, w.start - (w.bufferStart || 0)),
				end: w.end + (w.bufferEnd || 0),
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

				for (const range of mergedRanges) {
					const insertDuration = range.end - range.start;
					if (insertDuration <= 0.001) continue;

					shiftCaptionTimesAfterInsert(
						p.captions.segments,
						range.start,
						insertDuration,
						wordsToRestore.map((w) => ({
							segmentIndex: w.segmentIndex,
							wordIndex: w.wordIndex,
						})),
					);

					if (p.timeline) {
						rippleInsertAllTracks(p.timeline, range.start, insertDuration);
					}
				}

				for (const word of wordsToRestore) {
					const seg = p.captions.segments[word.segmentIndex];
					if (!seg?.words) continue;
					const w = seg.words[word.wordIndex] as CaptionWordExtended;
					if (w) {
						if (w.isPause) {
							w._markForRemoval = true;
						} else {
							w.deleted = false;
						}
					}
				}

				for (const seg of p.captions.segments) {
					const extWords = (seg.words ?? []) as CaptionWordExtended[];

					const filteredWords = extWords.filter((w) => !w._markForRemoval);
					if (filteredWords.length !== extWords.length) {
						seg.words = filteredWords;
					}

					seg.text = getCaptionTextFromWords(filteredWords);
					if (filteredWords && filteredWords.length > 0) {
						const visible = filteredWords.filter((w) => !w.deleted);
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

	const autoClean = () => {
		const words = allWords();
		const ps = pauses();
		const threshold = silenceThreshold();

		const fillerWords = words.filter((w) => !w.deleted && w.isFiller);
		const pausesToClean = ps.filter((p) => p.duration >= threshold);

		if (fillerWords.length === 0 && pausesToClean.length === 0) return;

		setProject(
			produce((p) => {
				if (!p.captions?.segments) return;

				const timeRanges: Array<{ start: number; end: number }> = [];

				// 1. Mark fillers as deleted and collect their ranges
				for (const fw of fillerWords) {
					const seg = p.captions.segments[fw.segmentIndex];
					if (seg?.words) {
						const w = seg.words[fw.wordIndex] as CaptionWordExtended;
						if (w) {
							seg.words[fw.wordIndex] = { ...w, deleted: true };
						}
					}
					timeRanges.push({
						start: Math.max(0, fw.start - (fw.bufferStart || 0)),
						end: fw.end + (fw.bufferEnd || 0),
					});
				}

				// 2. Insert pause words and collect their ranges
				const sortedPauses = [...pausesToClean].sort((a, b) => {
					if (a.afterSegmentIndex !== b.afterSegmentIndex) {
						return b.afterSegmentIndex - a.afterSegmentIndex;
					}
					return b.afterWordIndex - a.afterWordIndex;
				});

				for (const pInfo of sortedPauses) {
					const seg = p.captions.segments[pInfo.afterSegmentIndex];
					if (seg?.words) {
						const pauseWord: CaptionWordExtended = {
							text: `[Pause ${pInfo.duration.toFixed(1)}s]`,
							start: pInfo.start,
							end: pInfo.end,
							deleted: true,
							isPause: true,
							isFiller: false,
							bufferStart: DEFAULT_PAUSE_BUFFER,
							bufferEnd: DEFAULT_PAUSE_BUFFER,
						};
						seg.words.splice(pInfo.afterWordIndex + 1, 0, pauseWord);
					}
					timeRanges.push({
						start: Math.max(0, pInfo.start - DEFAULT_PAUSE_BUFFER),
						end: pInfo.end + DEFAULT_PAUSE_BUFFER,
					});
				}

				// 3. Recalculate seg.start and seg.end
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

				// 4. Merge time ranges and apply cuts
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
						fillerWords.map((w) => ({
							segmentIndex: w.segmentIndex,
							wordIndex: w.wordIndex,
						})),
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
					<div class="relative">
						<div class="flex">
							<button
								type="button"
								class="flex items-center gap-1 px-2 py-1 rounded-l-md text-[10px] font-medium bg-blue-9 text-white hover:bg-blue-10 transition-colors disabled:opacity-30 disabled:pointer-events-none"
								disabled={fillerCount() === 0 && pauseCount() === 0}
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
									class="mt-2 w-full px-2 py-1 rounded-md text-[10px] font-medium bg-blue-9 text-white hover:bg-blue-10 transition-colors"
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
				pauses={pauses()}
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
	const [bufStart, setBufStart] = createSignal(props.word.bufferStart);
	const [bufEnd, setBufEnd] = createSignal(props.word.bufferEnd);
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
							min="-0.5"
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
							min="-0.5"
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

function PauseBadge(props: { pause: PauseIndicator; onDelete: () => void }) {
	return (
		<span class="group relative inline-flex items-center px-1.5 py-0.5 mx-0.5 rounded border border-dashed border-gray-6 text-[10px] text-gray-8 bg-gray-3/30 select-none cursor-default">
			⏸ {props.pause.duration.toFixed(1)}s
			<button
				type="button"
				class="absolute -top-1.5 -right-1.5 hidden group-hover:flex items-center justify-center size-4 rounded-full bg-red-9 text-white hover:bg-red-10 transition-colors z-50 shadow-sm"
				onClick={(e) => {
					e.stopPropagation();
					props.onDelete();
				}}
				title="Delete pause"
			>
				<IconCapTrash class="size-2.5" />
			</button>
		</span>
	);
}

function TranscriptEditor(props: {
	segmentGroups: TranscriptSegmentGroup[];
	allWords: FlatWord[];
	pauses: PauseIndicator[];
	activeWordIndex: number;
	textSizeClass: string;
	onWordClick: (word: FlatWord) => void;
	onDeleteWord: (flatIndex: number) => void;
	onDeleteWords: (flatIndices: number[]) => void;
	onRestoreWord: (flatIndex: number) => void;
	onRestoreWords: (flatIndices: number[]) => void;
}) {
	const { setProject, setEditorState } = useEditorContext();
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

	const pauseAfterWord = createMemo(() => {
		const map = new Map<string, PauseIndicator>();
		for (const p of props.pauses) {
			map.set(`${p.afterSegmentIndex}:${p.afterWordIndex}`, p);
		}
		return map;
	});

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
			const firstWord = props.allWords[indices[0]];
			if (firstWord?.deleted) {
				if (indices.length === 1) {
					props.onRestoreWord(indices[0]);
				} else {
					props.onRestoreWords(indices);
				}
			} else {
				if (indices.length === 1) {
					props.onDeleteWord(indices[0]);
				} else {
					props.onDeleteWords(indices);
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

	const handleBufferChange = (
		segmentIndex: number,
		wordIndex: number,
		bufferStart: number,
		bufferEnd: number,
	) => {
		setProject(
			produce((p) => {
				if (!p.captions?.segments) return;
				const seg = p.captions.segments[segmentIndex];
				if (!seg?.words) return;
				const w = seg.words[wordIndex] as CaptionWordExtended;
				if (!w) return;

				if (w.deleted) {
					// 1. Undo the old cut
					const oldCutStart = Math.max(0, w.start - (w.bufferStart || 0));
					const oldCutEnd = w.end + (w.bufferEnd || 0);
					const oldDuration = oldCutEnd - oldCutStart;

					if (oldDuration > 0.001) {
						shiftCaptionTimesAfterInsert(
							p.captions.segments,
							oldCutStart,
							oldDuration,
							[{ segmentIndex, wordIndex }],
						);
						if (p.timeline) {
							rippleInsertAllTracks(p.timeline, oldCutStart, oldDuration);
						}
					}

					// 2. Update buffers
					w.bufferStart = bufferStart;
					w.bufferEnd = bufferEnd;

					// 3. Apply the new cut
					const newCutStart = Math.max(0, w.start - w.bufferStart);
					const newCutEnd = w.end + w.bufferEnd;
					const newDuration = newCutEnd - newCutStart;

					if (newDuration > 0.001) {
						shiftCaptionTimesAfterCut(
							p.captions.segments,
							newCutStart,
							newDuration,
							[{ segmentIndex, wordIndex }],
						);
						if (p.timeline) {
							rippleDeleteAllTracks(p.timeline, newCutStart, newCutEnd);
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
	};

	const handleDeletePause = (pause: PauseIndicator) => {
		setProject(
			produce((p) => {
				if (!p.captions?.segments) return;
				const seg = p.captions.segments[pause.afterSegmentIndex];
				if (seg?.words) {
					const pauseWord: CaptionWordExtended = {
						text: `[Pause ${pause.duration.toFixed(1)}s]`,
						start: pause.start,
						end: pause.end,
						deleted: true,
						isPause: true,
						isFiller: false,
						bufferStart: DEFAULT_PAUSE_BUFFER,
						bufferEnd: DEFAULT_PAUSE_BUFFER,
					};
					seg.words.splice(pause.afterWordIndex + 1, 0, pauseWord);
				}

				const cutStart = Math.max(0, pause.start - DEFAULT_PAUSE_BUFFER);
				const cutEnd = pause.end + DEFAULT_PAUSE_BUFFER;
				const cutDuration = cutEnd - cutStart;

				if (cutDuration > 0.001) {
					shiftCaptionTimesAfterCut(
						p.captions.segments,
						cutStart,
						cutDuration,
						[
							{
								segmentIndex: pause.afterSegmentIndex,
								wordIndex: pause.afterWordIndex + 1,
							},
						],
					);
				}

				if (p.timeline) {
					rippleDeleteAllTracks(p.timeline, cutStart, cutEnd);
					p.timeline.captionSegments = createCaptionTrackSegments(
						p.captions.segments,
					);
				}
			}),
		);
		setEditorState("captions", "isStale", false);
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
									const pauseBefore = () =>
										word.wordIndex === 0
											? pauseAfterWord().get(`${word.segmentIndex}:-1`)
											: undefined;

									const pause = () =>
										pauseAfterWord().get(
											`${word.segmentIndex}:${word.wordIndex}`,
										);

									return (
										<>
											<Show when={pauseBefore()}>
												{(p) => (
													<PauseBadge
														pause={p()}
														onDelete={() => handleDeletePause(p())}
													/>
												)}
											</Show>
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
											<Show when={pause()}>
												{(p) => (
													<PauseBadge
														pause={p()}
														onDelete={() => handleDeletePause(p())}
													/>
												)}
											</Show>
										</>
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
