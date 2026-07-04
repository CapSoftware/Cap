import { createEventListener } from "@solid-primitives/event-listener";
import { makePersisted } from "@solid-primitives/storage";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
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
import toast from "solid-toast";
import { defaultCaptionSettings } from "~/store/captions";
import { commands } from "~/utils/tauri";
import {
	getCaptionTextFromWords,
	mapEditedTimeToSource,
	mapSourceRangeToEdited,
	mapSourceTimeToEdited,
	syncCaptionWordsWithText,
} from "./captions";
import {
	type CaptionExportFormat,
	captionExportDefaultPath,
	createCaptionExportCues,
	formatCaptionCues,
} from "./captions-export";
import { FPS, useEditorContext } from "./context";
import { rippleDeleteAllTracks } from "./timeline-utils";

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
		editorInstance,
		meta,
		totalDuration,
		previewResolutionBase,
	} = useEditorContext();

	const recordingSegments = () => editorInstance.recordings.segments;

	const [textSizeIndex, setTextSizeIndex] = makePersisted(createSignal(1), {
		name: "editorTranscriptTextSize",
	});
	const [exportingFormat, setExportingFormat] =
		createSignal<CaptionExportFormat | null>(null);

	const exportableCues = createMemo(() =>
		createCaptionExportCues(
			project.captions?.segments ?? [],
			project.timeline?.segments ?? [],
			recordingSegments(),
		),
	);

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
		const flatWords = allWords();
		return (project.captions?.segments ?? []).map((_segment, segmentIndex) => ({
			segmentIndex,
			words: flatWords.filter((word) => word.segmentIndex === segmentIndex),
		}));
	});

	const updateWordText = (flatIndex: number, rawText: string) => {
		const target = allWords()[flatIndex];
		if (!target) return;

		const tokens = rawText
			.trim()
			.split(/\s+/)
			.map((token) => token.trim())
			.filter((token) => token.length > 0);

		setProject(
			produce((p) => {
				const segment = p.captions?.segments?.[target.segmentIndex];
				if (!segment?.words) return;

				const existing = segment.words[target.wordIndex];
				if (!existing) return;

				if (tokens.length === 0) {
					segment.words.splice(target.wordIndex, 1);
				} else if (tokens.length === 1) {
					existing.text = tokens[0];
				} else {
					const start = existing.start;
					const end = existing.end;
					const step = (end - start) / tokens.length;
					const replacements = tokens.map((token, index) => ({
						text: token,
						start: start + step * index,
						end: index === tokens.length - 1 ? end : start + step * (index + 1),
					}));
					segment.words.splice(target.wordIndex, 1, ...replacements);
				}

				if (!p.captions?.segments) return;
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
			}),
		);
		setEditorState("captions", "isStale", false);
	};

	const addCaptionAtPlayhead = () => {
		const total = totalDuration();
		const defaultDuration = 2;
		const outputStart =
			total > 0
				? Math.min(
						Math.max(editorState.playbackTime, 0),
						Math.max(total - 0.25, 0),
					)
				: Math.max(editorState.playbackTime, 0);
		const start =
			mapEditedTimeToSource(
				outputStart,
				project.timeline?.segments ?? [],
				recordingSegments(),
			) ?? outputStart;
		const end = start + defaultDuration;
		const text = "New caption";

		setProject(
			produce((p) => {
				p.captions ??= {
					segments: [],
					settings: { ...defaultCaptionSettings, enabled: true },
					sourceTimed: true,
				};
				p.captions.settings = {
					...defaultCaptionSettings,
					...p.captions.settings,
					enabled: true,
				};
				p.captions.sourceTimed = true;
				p.timeline ??= {
					segments: [{ start: 0, end: total || end, timescale: 1 }],
					zoomSegments: [],
					sceneSegments: [],
					maskSegments: [],
					textSegments: [],
					captionSegments: [],
					keyboardSegments: [],
				};

				p.captions.segments.push({
					id: `caption-${Date.now()}-${Math.random().toString(36).slice(2)}`,
					start,
					end,
					text,
					words: syncCaptionWordsWithText(text, undefined, start, end),
				});
				p.captions.segments.sort((a, b) => a.start - b.start);
			}),
		);
		setEditorState("timeline", "tracks", "caption", true);
		setEditorState("captions", "isStale", false);
	};

	const handleExportCaptions = async (format: CaptionExportFormat) => {
		const cues = exportableCues();
		if (cues.length === 0) {
			toast.error("No captions to download");
			return;
		}

		setExportingFormat(format);
		try {
			const path = await save({
				defaultPath: captionExportDefaultPath(meta().prettyName, format),
				filters: [
					{
						name: format === "srt" ? "SubRip Subtitle" : "WebVTT",
						extensions: [format],
					},
				],
			});
			if (!path) return;

			await writeTextFile(path, formatCaptionCues(cues, format));
			toast.success(`Captions saved as ${format.toUpperCase()}`);
		} catch (error) {
			console.error("Failed to save captions:", error);
			toast.error("Failed to save captions");
		} finally {
			setExportingFormat(null);
		}
	};

	const activeWordIndex = createMemo(() => {
		const words = allWords();
		if (words.length === 0) return -1;

		const sourceTime = mapEditedTimeToSource(
			editorState.playbackTime,
			project.timeline?.segments ?? [],
			recordingSegments(),
		);
		if (sourceTime === null) return -1;

		let lo = 0;
		let hi = words.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			if (sourceTime >= words[mid].end) {
				lo = mid + 1;
			} else if (sourceTime < words[mid].start) {
				hi = mid - 1;
			} else {
				return mid;
			}
		}
		return -1;
	});

	const handleWordClick = async (word: FlatWord) => {
		try {
			const outputTime = mapSourceTimeToEdited(
				word.start,
				project.timeline?.segments ?? [],
				recordingSegments(),
			);
			if (outputTime === null) return;
			if (editorState.playing) {
				await commands.stopPlayback();
				setEditorState("playing", false);
			}
			const frame = Math.max(Math.floor(outputTime * FPS), 0);
			await commands.seekTo(frame);
			batch(() => {
				setEditorState("previewTime", null);
				setEditorState("playbackTime", outputTime);
				editorState.timeline.transform.setPosition(
					outputTime - editorState.timeline.transform.zoom / 2,
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

		const sourceRanges = wordsToDelete
			.map((w) => ({ start: w.start, end: w.end }))
			.sort((a, b) => a.start - b.start);

		const mergedSourceRanges: { start: number; end: number }[] = [];
		for (const range of sourceRanges) {
			const last = mergedSourceRanges[mergedSourceRanges.length - 1];
			if (last && range.start <= last.end) {
				last.end = Math.max(last.end, range.end);
			} else {
				mergedSourceRanges.push({ ...range });
			}
		}

		// Deleting transcript words also removes the matching span of video. The
		// caption master is source-timed, so translate the deleted source ranges
		// into the output-time ranges they currently occupy and ripple those out
		// of every output-time track (clips + zoom/mask/text/keyboard).
		const outputRanges = mergedSourceRanges
			.flatMap((range) =>
				mapSourceRangeToEdited(
					range.start,
					range.end,
					project.timeline?.segments ?? [],
					recordingSegments(),
				),
			)
			.sort((a, b) => a.start - b.start);

		const mergedOutputRanges: { start: number; end: number }[] = [];
		for (const range of outputRanges) {
			const last = mergedOutputRanges[mergedOutputRanges.length - 1];
			if (last && range.start <= last.end + 0.0001) {
				last.end = Math.max(last.end, range.end);
			} else {
				mergedOutputRanges.push({ ...range });
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

				if (p.timeline) {
					for (const range of [...mergedOutputRanges].reverse()) {
						if (range.end - range.start <= 0.001) continue;
						rippleDeleteAllTracks(p.timeline, range.start, range.end);
					}
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
				<span class="text-xs font-medium text-gray-12">Captions</span>
				<div class="flex items-center gap-1">
					<button
						type="button"
						class="flex items-center gap-1 rounded-sm px-2 h-6 hover:bg-gray-3 text-gray-9 hover:text-gray-12 transition-colors text-xs"
						onClick={addCaptionAtPlayhead}
					>
						<IconLucidePlus class="size-3" />
						Add
					</button>
					<button
						type="button"
						class="flex items-center gap-1 rounded-sm px-2 h-6 hover:bg-gray-3 text-gray-9 hover:text-gray-12 transition-colors text-xs disabled:opacity-30 disabled:pointer-events-none"
						disabled={
							exportableCues().length === 0 || exportingFormat() !== null
						}
						onClick={() => void handleExportCaptions("srt")}
					>
						<IconCapDownload class="size-3" />
						SRT
					</button>
					<button
						type="button"
						class="flex items-center gap-1 rounded-sm px-2 h-6 hover:bg-gray-3 text-gray-9 hover:text-gray-12 transition-colors text-xs disabled:opacity-30 disabled:pointer-events-none"
						disabled={
							exportableCues().length === 0 || exportingFormat() !== null
						}
						onClick={() => void handleExportCaptions("vtt")}
					>
						<IconCapDownload class="size-3" />
						VTT
					</button>
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
				onEditWord={updateWordText}
				onAddCaption={addCaptionAtPlayhead}
			/>
		</div>
	);
}

function TranscriptWord(props: {
	word: FlatWord;
	isActive: boolean;
	isSelected: boolean;
	isEditing: boolean;
	selectedCount: number;
	textSizeClass: string;
	ref: (el: HTMLSpanElement) => void;
	onClick: (e: MouseEvent) => void;
	onStartEdit: () => void;
	onCommitEdit: (text: string) => void;
	onCancelEdit: () => void;
	onDelete: () => void;
}) {
	const [hovering, setHovering] = createSignal(false);
	let hoverTimer: number | undefined;
	let inputRef: HTMLInputElement | undefined;

	const onEnter = () => {
		hoverTimer = window.setTimeout(() => setHovering(true), 350);
	};
	const onLeave = () => {
		clearTimeout(hoverTimer);
		setHovering(false);
	};

	const showTip = () =>
		!props.isEditing &&
		(hovering() || (props.isSelected && props.selectedCount === 1));

	const sizeInput = (value: string) => {
		if (inputRef) {
			inputRef.style.width = `${Math.max(value.length, 1) + 1}ch`;
		}
	};

	createEffect(() => {
		if (props.isEditing && inputRef) {
			sizeInput(inputRef.value);
			inputRef.focus();
			inputRef.select();
		}
	});

	const commit = () => {
		if (inputRef) props.onCommitEdit(inputRef.value);
	};

	return (
		<Show
			when={props.isEditing}
			fallback={
				<span
					ref={props.ref}
					class={cx(
						"transition-colors duration-100 rounded-xs relative",
						props.isSelected && "bg-blue-4/50",
						props.isActive
							? "text-blue-11"
							: props.isSelected
								? "text-blue-11"
								: "text-gray-9 hover:text-gray-12",
					)}
					onClick={(e) => props.onClick(e)}
					onDblClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						props.onStartEdit();
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
								<button
									type="button"
									class="flex items-center justify-center size-6 rounded-md bg-blue-9 text-white hover:bg-blue-10 transition-colors"
									onClick={(e) => {
										e.stopPropagation();
										props.onStartEdit();
									}}
								>
									<IconLucidePencil class="size-3.5" />
								</button>
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
			}
		>
			<input
				ref={inputRef}
				class={cx(
					"rounded-xs bg-blue-4/40 text-gray-12 ring-1 ring-blue-9 outline-hidden px-0.5",
					props.textSizeClass,
				)}
				value={props.word.text}
				onInput={(e) => sizeInput(e.currentTarget.value)}
				onKeyDown={(e) => {
					e.stopPropagation();
					if (e.key === "Enter") {
						e.preventDefault();
						commit();
					} else if (e.key === "Escape") {
						e.preventDefault();
						props.onCancelEdit();
					}
				}}
				onBlur={commit}
			/>
		</Show>
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
	onEditWord: (flatIndex: number, text: string) => void;
	onAddCaption: () => void;
}) {
	const [selectedIndices, setSelectedIndices] = createSignal<Set<number>>(
		new Set(),
	);
	const [anchorIndex, setAnchorIndex] = createSignal<number>(-1);
	const [editingIndex, setEditingIndex] = createSignal<number>(-1);
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

		if (e.key === "Enter" && selected.size === 1 && editingIndex() === -1) {
			e.preventDefault();
			const word = props.allWords[[...selected][0]];
			if (word) startEditing(word);
		} else if (e.key === "Backspace" || e.key === "Delete") {
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

	const startEditing = (word: FlatWord) => {
		const idx = flatIndexOf(word);
		setSelectedIndices(new Set([idx]));
		setAnchorIndex(idx);
		setEditingIndex(idx);
	};

	const commitEditing = (word: FlatWord, text: string) => {
		if (editingIndex() === -1) return;
		setEditingIndex(-1);
		props.onEditWord(flatIndexOf(word), text);
	};

	const cancelEditing = () => {
		setEditingIndex(-1);
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
						<span class="text-sm">No captions available</span>
						<span class="text-xs mt-1">
							Generate captions in the editor first
						</span>
						<button
							type="button"
							class="mt-4 flex items-center gap-1 rounded-md border border-gray-3 bg-gray-2 px-3 py-1.5 text-xs text-gray-12 hover:bg-gray-3 transition-colors"
							onClick={props.onAddCaption}
						>
							<IconLucidePlus class="size-3.5" />
							Add caption at playhead
						</button>
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
									const isEditing = () => editingIndex() === flatIdx();

									return (
										<TranscriptWord
											word={word}
											isActive={isActive()}
											isSelected={isSelected()}
											isEditing={isEditing()}
											selectedCount={selectedCount()}
											textSizeClass={props.textSizeClass}
											ref={(el: HTMLSpanElement) => {
												if (isActive()) activeWordRef = el;
											}}
											onClick={(e: MouseEvent) => handleWordSelect(word, e)}
											onStartEdit={() => startEditing(word)}
											onCommitEdit={(text: string) => commitEditing(word, text)}
											onCancelEdit={cancelEditing}
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
