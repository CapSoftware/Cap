import { createEventListener } from "@solid-primitives/event-listener";
import { makePersisted } from "@solid-primitives/storage";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { cx } from "cva";
import {
	batch,
	createEffect,
	createMemo,
	createSignal,
	Index,
	Match,
	on,
	Show,
	Switch,
} from "solid-js";
import { produce } from "solid-js/store";
import { Portal } from "solid-js/web";
import toast from "solid-toast";
import { defaultCaptionSettings } from "~/store/captions";
import { commands, type TranscriptCut } from "~/utils/tauri";
import {
	getCaptionTextFromWords,
	mapEditedTimeToSource,
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
import { routeEditorPlaybackIntent } from "./playback-intent-routing";
import {
	AUTO_CLEAN_SILENCE_THRESHOLD,
	commitTranscriptCutEdit,
	cutClaim,
	cutPaddingLimits,
	cutPaddingRoom,
	fillerTokens,
	flattenCaptionWords,
	type PaddingRoom,
	planAutoClean,
	planPauseCut,
	planWordCuts,
	recordingAudio,
	type SourceRange,
	type TranscriptCutEdit,
	type TranscriptItem,
	transcriptPlanContext,
} from "./transcript-cuts";
import {
	deleteTranscriptWords,
	type FlatWord,
	transcriptKeyAction,
	transcriptSeekPosition,
} from "./transcript-edits";

function formatTimePrecise(secs: number) {
	const minutes = Math.floor(secs / 60);
	const whole = Math.floor(secs % 60);
	const hundredths = Math.floor((secs % 1) * 100);
	return `${minutes}:${whole.toString().padStart(2, "0")}.${hundredths.toString().padStart(2, "0")}`;
}

const TEXT_SIZES = [
	{ label: "S", value: "text-xs leading-normal" },
	{ label: "M", value: "text-sm leading-normal" },
	{ label: "L", value: "text-base leading-snug" },
	{ label: "XL", value: "text-lg leading-snug" },
] as const;

const MIN_SILENCE_THRESHOLD = 0.5;
const MAX_SILENCE_THRESHOLD = 5;

function plural(count: number, word: string) {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

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
		playbackIntent,
		requestHandoffPlayback,
		micWaveforms,
		systemAudioWaveforms,
	} = useEditorContext();

	const recordingSegments = () => editorInstance.recordings.segments;

	const recordedAudio = createMemo(() => {
		const mic = micWaveforms();
		const system = systemAudioWaveforms();
		return recordingAudio(
			recordingSegments(),
			recordingSegments().map((_, index) => {
				const offsets = project.clips?.find(
					(clip) => clip.index === index,
				)?.offsets;
				return [
					{ levels: mic?.[index] ?? [], offset: offsets?.mic ?? 0 },
					{
						levels: system?.[index] ?? [],
						offset: offsets?.system_audio ?? 0,
					},
				];
			}),
		);
	});

	const [textSizeIndex, setTextSizeIndex] = makePersisted(createSignal(1), {
		name: "editorTranscriptTextSize",
	});
	const [storedSilenceThreshold, setSilenceThreshold] = makePersisted(
		createSignal(AUTO_CLEAN_SILENCE_THRESHOLD),
		{ name: "editorAutoCleanThreshold" },
	);
	const silenceThreshold = () => {
		const value = storedSilenceThreshold();
		return Number.isFinite(value)
			? Math.min(MAX_SILENCE_THRESHOLD, Math.max(MIN_SILENCE_THRESHOLD, value))
			: AUTO_CLEAN_SILENCE_THRESHOLD;
	};
	const [exportingFormat, setExportingFormat] =
		createSignal<CaptionExportFormat | null>(null);

	const exportableCues = createMemo(() =>
		createCaptionExportCues(
			project.captions?.segments ?? [],
			project.timeline?.segments ?? [],
			recordingSegments(),
			project.timeline?.transitions ?? [],
			project.timeline?.textSegments,
		),
	);

	const allWords = createMemo((): FlatWord[] =>
		flattenCaptionWords(project.captions?.segments ?? []),
	);

	const transcript = createMemo(() =>
		transcriptPlanContext(
			project,
			recordingSegments(),
			allWords(),
			recordedAudio(),
		),
	);

	const transcriptItems = () => transcript().items;

	const tokenCount = createMemo(
		() =>
			transcriptItems().filter(
				(item) => item.type === "word" || item.type === "cut-word",
			).length,
	);

	const fillers = createMemo(() => fillerTokens(transcriptItems()));

	const fillerCount = () => fillers().size;

	const longPauseCount = createMemo(
		() =>
			transcriptItems().filter(
				(item) =>
					item.type === "pause" && item.end - item.start >= silenceThreshold(),
			).length,
	);

	const canAutoClean = () => fillerCount() > 0 || longPauseCount() > 0;

	const autoCleanSummary = () => {
		const parts = [
			fillerCount() > 0 ? plural(fillerCount(), "filler word") : null,
			longPauseCount() > 0
				? `${plural(longPauseCount(), "pause")} over ${silenceThreshold().toFixed(1)}s`
				: null,
		].filter(Boolean);
		return parts.length > 0
			? `Cuts ${parts.join(" and ")}`
			: "Nothing to clean";
	};

	const updateWordText = (target: FlatWord, rawText: string) => {
		const tokens = rawText
			.trim()
			.split(/\s+/)
			.map((token) => token.trim())
			.filter((token) => token.length > 0);

		setProject(
			produce((p) => {
				if (tokens.length === 0) {
					deleteTranscriptWords(p, [target]);
					return;
				}

				const segment = p.captions?.segments?.[target.segmentIndex];
				if (!segment?.words) return;

				const existing = segment.words[target.wordIndex];
				if (!existing) return;

				if (tokens.length === 1) {
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

				segment.text = getCaptionTextFromWords(segment.words);
				segment.start = segment.words[0].start;
				segment.end = segment.words[segment.words.length - 1].end;
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
				project.timeline?.transitions ?? [],
				undefined,
				"incoming",
				project.timeline?.textSegments,
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
					styleSegments: [],
					imageSegments: [],
					captionSegments: [],
					keyboardSegments: [],
					camera3dSegments: [],
					transitions: [],
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
			const path = await commands.saveFileDialog(
				captionExportDefaultPath(meta().prettyName, format),
				format,
			);
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

	const outputToSource = (outputTime: number) =>
		mapEditedTimeToSource(
			outputTime,
			project.timeline?.segments ?? [],
			recordingSegments(),
			project.timeline?.transitions ?? [],
			undefined,
			"incoming",
			project.timeline?.textSegments,
		);

	const sourceToOutput = (sourceTime: number) =>
		mapSourceTimeToEdited(
			sourceTime,
			project.timeline?.segments ?? [],
			recordingSegments(),
			project.timeline?.transitions ?? [],
			project.timeline?.textSegments,
		);

	const activeWord = createMemo(() => {
		const words = allWords();
		if (words.length === 0) return null;

		const sourceTime = outputToSource(editorState.playbackTime);
		if (sourceTime === null) return null;

		let lo = 0;
		let hi = words.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			if (sourceTime >= words[mid].end) {
				lo = mid + 1;
			} else if (sourceTime < words[mid].start) {
				hi = mid - 1;
			} else {
				return words[mid];
			}
		}
		return null;
	});

	const seekToOutputTime = async (outputTime: number) => {
		try {
			const accepted = await routeEditorPlaybackIntent(
				requestHandoffPlayback,
				{ playing: false, seconds: outputTime },
				async () => {
					if (editorState.playing) {
						await commands.stopPlayback();
						setEditorState("playing", false);
					}
					const frame = Math.max(Math.floor(outputTime * FPS), 0);
					await commands.seekTo(frame);
				},
			);
			if (!accepted) return;
			batch(() => {
				setEditorState("previewTime", null);
				setEditorState("playbackTime", outputTime);
				editorState.timeline.transform.setPosition(
					transcriptSeekPosition(
						outputTime,
						editorState.timeline.transform.position,
						editorState.timeline.transform.zoom,
					),
				);
			});
		} catch (error) {
			console.error("Failed to seek to word:", error);
		}
	};

	const seekToItem = (item: TranscriptItem) => {
		let outputTime: number | null = null;
		if (item.type === "word") {
			outputTime = sourceToOutput(item.word.start);
		} else if (item.type === "cut-word" || item.type === "cut-pause") {
			const claim = cutClaim(item.cut);
			outputTime =
				(claim && (sourceToOutput(claim.end) ?? sourceToOutput(claim.start))) ??
				null;
		}
		if (outputTime !== null) void seekToOutputTime(outputTime);
	};

	const keepPlayheadOnContent = (sourceTime: number | null) => {
		if (editorState.playing) return;
		const total = totalDuration();
		const mapped = sourceTime === null ? null : sourceToOutput(sourceTime);
		const target = Math.min(
			mapped ?? editorState.playbackTime,
			Math.max(total - 0.01, 0),
		);
		if (Math.abs(target - editorState.playbackTime) > 1 / FPS) {
			void seekToOutputTime(target);
		}
	};

	const commitCutEdit = (
		edit: TranscriptCutEdit | null,
		action: "cut" | "restore" | "adjust",
	) => {
		if (!edit) return false;
		const playheadSource = editorState.playing
			? null
			: outputToSource(editorState.playbackTime);
		const outcome = {
			result: "empty" as ReturnType<typeof commitTranscriptCutEdit>,
		};
		setProject(
			produce((p) => {
				outcome.result = commitTranscriptCutEdit(p, edit, recordingSegments());
			}),
		);

		if (outcome.result === "transition") {
			toast.error(
				action === "restore"
					? "Remove the nearby transition before restoring this transcript range."
					: "Remove the nearby transition before cutting this transcript range.",
			);
			return false;
		}
		if (outcome.result === "failed") {
			toast.error("That cut would remove the whole video.");
			return false;
		}
		if (outcome.result !== "applied") return false;

		batch(() => {
			setEditorState("styleEditIndex", null);
			setEditorState("timeline", "selection", null);
			setEditorState("captions", "isStale", false);
		});
		keepPlayheadOnContent(playheadSource);
		return true;
	};

	const deleteWordsFromCaptions = (words: FlatWord[]) => {
		if (words.length === 0) return;
		setProject(
			produce((p) => {
				deleteTranscriptWords(p, words);
			}),
		);
		if (editorState.timeline.selection?.type === "caption") {
			setEditorState("styleEditIndex", null);
			setEditorState("timeline", "selection", null);
		}
		setEditorState("captions", "isStale", false);
	};

	const cutTokens = (tokens: number[]) =>
		commitCutEdit(planWordCuts(transcript(), tokens), "cut");

	const restoreCuts = (ids: string[]) =>
		commitCutEdit(ids.length > 0 ? { restore: ids } : null, "restore");

	const cutPause = (pause: SourceRange) =>
		commitCutEdit(planPauseCut(transcript(), pause), "cut");

	const adjustCutPadding = (
		cut: TranscriptCut,
		bufferStart: number,
		bufferEnd: number,
	) =>
		commitCutEdit(
			{ padding: [{ id: cut.id, bufferStart, bufferEnd }] },
			"adjust",
		);

	const autoClean = () => {
		const { edit, skipped } = planAutoClean(transcript(), silenceThreshold());
		if (!edit) {
			if (skipped > 0)
				toast.error(
					"Everything Auto Clean found sits next to a clip transition.",
				);
			return false;
		}
		const applied = commitCutEdit(edit, "cut");
		if (applied && skipped > 0) {
			toast(
				`Left ${plural(skipped, "cut")} next to clip transitions untouched.`,
			);
		}
		return applied;
	};

	const isAtEnd = () => {
		const total = totalDuration();
		return total > 0 && total - editorState.playbackTime <= 0.1;
	};

	const handlePlayPause = async () => {
		try {
			await routeEditorPlaybackIntent(
				requestHandoffPlayback,
				{
					playing: isAtEnd() || !playbackIntent(),
					seconds: isAtEnd() ? 0 : editorState.playbackTime,
				},
				async () => {
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
				},
			);
		} catch (error) {
			console.error("Error handling play/pause:", error);
			setEditorState("playing", false);
		}
	};

	createEffect(() => {
		if (isAtEnd() && playbackIntent()) {
			void routeEditorPlaybackIntent(
				requestHandoffPlayback,
				{ playing: false },
				async () => {
					await commands.stopPlayback();
					setEditorState("playing", false);
				},
			).catch((error) => {
				console.error("Error stopping playback:", error);
				setEditorState("playing", false);
			});
		}
	});

	createEventListener(window, "keydown", (e) => {
		if (e.defaultPrevented || e.code !== "Space") return;
		const el = document.activeElement;
		if (el) {
			const tag = el.tagName.toLowerCase();
			if (tag === "input" || tag === "textarea") return;
		}
		e.preventDefault();
		handlePlayPause();
	});

	const [autoCleanOpen, setAutoCleanOpen] = createSignal(false);
	let autoCleanRef: HTMLDivElement | undefined;

	createEventListener(document, "mousedown", (e) => {
		if (
			autoCleanOpen() &&
			autoCleanRef &&
			!autoCleanRef.contains(e.target as Node)
		) {
			setAutoCleanOpen(false);
		}
	});

	createEventListener(window, "keydown", (e) => {
		if (autoCleanOpen() && e.key === "Escape") setAutoCleanOpen(false);
	});

	return (
		<div class="flex overflow-hidden flex-col min-h-0 h-full rounded-xl">
			<div class="px-3 py-2 border-b border-ed-line flex flex-wrap items-center justify-between gap-x-2 gap-y-1 shrink-0">
				<span class="text-xs font-medium text-ed-text-1">Captions</span>
				<div class="flex flex-wrap items-center justify-end gap-1">
					<div class="relative" ref={autoCleanRef}>
						<div class="flex">
							<button
								type="button"
								class="flex items-center gap-1 rounded-l-sm px-2 h-6 hover:bg-gray-3 text-gray-9 hover:text-gray-12 transition-colors text-xs disabled:opacity-30 disabled:pointer-events-none"
								title={autoCleanSummary()}
								disabled={!canAutoClean()}
								onClick={() => autoClean()}
							>
								<IconLucideSparkles class="size-3" />
								Auto Clean
							</button>
							<button
								type="button"
								class="flex items-center justify-center rounded-r-sm w-5 h-6 hover:bg-gray-3 text-gray-9 hover:text-gray-12 transition-colors disabled:opacity-30 disabled:pointer-events-none"
								title="Auto Clean settings"
								aria-expanded={autoCleanOpen()}
								disabled={tokenCount() === 0}
								onClick={() => setAutoCleanOpen(!autoCleanOpen())}
							>
								<IconLucideChevronDown class="size-3" />
							</button>
						</div>
						<Show when={autoCleanOpen()}>
							<div class="absolute left-0 top-full mt-1 z-50 w-56 rounded-lg border border-gray-4 bg-gray-2 p-3 shadow-lg">
								<div class="flex items-center justify-between text-xs text-gray-11">
									<span>Cut pauses longer than</span>
									<span class="tabular-nums text-gray-12">
										{silenceThreshold().toFixed(1)}s
									</span>
								</div>
								<input
									type="range"
									min={MIN_SILENCE_THRESHOLD}
									max={MAX_SILENCE_THRESHOLD}
									step="0.1"
									value={silenceThreshold()}
									onInput={(e) =>
										setSilenceThreshold(
											Number.parseFloat(e.currentTarget.value),
										)
									}
									class="mt-2 w-full h-1 accent-blue-9"
								/>
								<p class="mt-2 text-[11px] leading-snug text-gray-10">
									{autoCleanSummary()}. Filler words are cut with the silence
									around them.
								</p>
								<button
									type="button"
									class="mt-3 w-full rounded-md bg-blue-9 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-blue-10 disabled:opacity-30 disabled:pointer-events-none"
									disabled={!canAutoClean()}
									onClick={() => {
										if (autoClean()) setAutoCleanOpen(false);
									}}
								>
									Clean now
								</button>
							</div>
						</Show>
					</div>
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
				items={transcriptItems()}
				hasContent={
					(project.captions?.segments.length ?? 0) > 0 || tokenCount() > 0
				}
				tokenCount={tokenCount()}
				fillers={fillers()}
				activeWord={activeWord()}
				textSizeClass={
					TEXT_SIZES[textSizeIndex()]?.value ?? TEXT_SIZES[1].value
				}
				onSeek={seekToItem}
				onDeleteWords={deleteWordsFromCaptions}
				onCutTokens={cutTokens}
				onRestoreCuts={restoreCuts}
				onCutPause={cutPause}
				onAdjustCut={adjustCutPadding}
				paddingRoom={(cut) => cutPaddingRoom(project.captions, cut)}
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
	isFiller: boolean;
	selectedCount: number;
	textSizeClass: string;
	onClick: (e: MouseEvent) => void;
	onStartEdit: () => void;
	onCommitEdit: (text: string) => void;
	onCancelEdit: () => void;
	onDelete: () => void;
	onCut: () => void;
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
					data-active-word={props.isActive || undefined}
					class={cx(
						"transition-colors duration-100 rounded-xs relative",
						props.isFiller &&
							"underline decoration-dotted decoration-amber-500",
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
							<Show when={props.isFiller && !props.isSelected}>
								<span class="text-xs text-amber-7">Filler</span>
							</Show>
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
									title="Delete from captions"
									aria-label="Delete from captions"
									onClick={(e) => {
										e.stopPropagation();
										props.onDelete();
									}}
								>
									<IconCapTrash class="size-3.5" />
								</button>
								<button
									type="button"
									class="flex items-center justify-center gap-1 h-6 px-1.5 rounded-md bg-gray-11 text-white hover:bg-gray-10 transition-colors text-xs"
									title="Cut selected words and their video from the timeline (Shift+Delete)"
									aria-keyshortcuts="Shift+Delete Shift+Backspace"
									onClick={(e) => {
										e.stopPropagation();
										props.onCut();
									}}
								>
									Cut video
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

function CutTranscriptWord(props: {
	cut: TranscriptCut;
	isSelected: boolean;
	selectedCount: number;
	onClick: (e: MouseEvent) => void;
	onRestore: () => void;
	onAdjust: (e: MouseEvent) => void;
}) {
	const [hovering, setHovering] = createSignal(false);
	let hoverTimer: number | undefined;

	const showTip = () =>
		hovering() || (props.isSelected && props.selectedCount === 1);

	return (
		<span
			class={cx(
				"transition-colors duration-100 rounded-xs relative line-through decoration-red-9/70",
				props.isSelected
					? "bg-red-4/40 text-red-11"
					: "text-red-9 hover:text-red-11",
			)}
			title="Cut from the video. Right-click to adjust the cut."
			onClick={(e) => props.onClick(e)}
			onContextMenu={(e) => {
				e.preventDefault();
				props.onAdjust(e);
			}}
			onMouseEnter={() => {
				hoverTimer = window.setTimeout(() => setHovering(true), 350);
			}}
			onMouseLeave={() => {
				clearTimeout(hoverTimer);
				setHovering(false);
			}}
		>
			{props.cut.text}
			<Show when={showTip()}>
				<span
					class="absolute left-1/2 -translate-x-1/2 top-full mt-1 flex items-center gap-2 whitespace-nowrap border border-gray-3 bg-gray-12 rounded-lg shadow-lg animate-in fade-in slide-in-from-top-1 duration-100 z-50 px-2 py-1.5 no-underline"
					style={{ "pointer-events": props.isSelected ? "auto" : "none" }}
				>
					<span class="text-xs tabular-nums text-gray-1">
						{formatTimePrecise(props.cut.start)}
					</span>
					<Show when={props.isSelected}>
						<button
							type="button"
							class="flex items-center justify-center gap-1 h-6 px-1.5 rounded-md bg-emerald-9 text-white hover:bg-emerald-10 transition-colors text-xs"
							title="Restore this word and its video (Delete)"
							onClick={(e) => {
								e.stopPropagation();
								props.onRestore();
							}}
						>
							<IconLucideRotateCcw class="size-3" />
							Restore
						</button>
					</Show>
				</span>
			</Show>
		</span>
	);
}

function PauseBadge(props: {
	duration: number;
	cut: boolean;
	onToggle: () => void;
	onAdjust?: (e: MouseEvent) => void;
}) {
	return (
		<span
			class={cx(
				"group relative inline-flex items-center gap-0.5 self-center rounded border border-dashed px-1 text-[10px] leading-4 tabular-nums select-none",
				props.cut
					? "border-gray-4 text-red-9 line-through decoration-red-9/70"
					: "border-gray-6 text-gray-9",
			)}
			title={
				props.cut
					? "Pause cut from the video. Right-click to adjust the cut."
					: "Pause"
			}
			onContextMenu={(e) => {
				if (!props.onAdjust) return;
				e.preventDefault();
				props.onAdjust(e);
			}}
		>
			<IconLucidePause class="size-2.5" />
			{props.duration.toFixed(1)}s
			<button
				type="button"
				class={cx(
					"absolute -top-2 -right-2 z-10 hidden size-4 items-center justify-center rounded-full text-white shadow-sm transition-colors group-hover:flex",
					props.cut
						? "bg-emerald-9 hover:bg-emerald-10"
						: "bg-gray-11 hover:bg-gray-10",
				)}
				title={props.cut ? "Restore pause" : "Cut pause from the video"}
				aria-label={props.cut ? "Restore pause" : "Cut pause from the video"}
				onClick={(e) => {
					e.stopPropagation();
					props.onToggle();
				}}
			>
				<Show when={props.cut} fallback={<IconCapScissors class="size-2.5" />}>
					<IconLucideRotateCcw class="size-2.5" />
				</Show>
			</button>
		</span>
	);
}

function CutPaddingPopover(props: {
	cut: TranscriptCut;
	room: PaddingRoom;
	position: { x: number; y: number };
	onClose: () => void;
	onChange: (bufferStart: number, bufferEnd: number) => boolean;
	onRestore: () => void;
}) {
	const [start, setStart] = createSignal(props.cut.bufferStart ?? 0);
	const [end, setEnd] = createSignal(props.cut.bufferEnd ?? 0);
	const room = createMemo(() => props.room);
	const limits = () =>
		cutPaddingLimits(
			{ ...props.cut, bufferStart: start(), bufferEnd: end() },
			room(),
		);
	let popoverRef: HTMLDivElement | undefined;

	createEffect(
		on(
			() => [props.cut.bufferStart ?? 0, props.cut.bufferEnd ?? 0] as const,
			([bufferStart, bufferEnd]) => {
				setStart(bufferStart);
				setEnd(bufferEnd);
			},
			{ defer: true },
		),
	);

	createEventListener(document, "mousedown", (e) => {
		if (popoverRef && !popoverRef.contains(e.target as Node)) props.onClose();
	});

	const commit = (bufferStart: number, bufferEnd: number) => {
		if (props.onChange(bufferStart, bufferEnd)) return;
		setStart(props.cut.bufferStart ?? 0);
		setEnd(props.cut.bufferEnd ?? 0);
	};

	const slider = (
		label: string,
		value: () => number,
		range: () => { min: number; max: number },
		stored: () => number,
		set: (value: number) => void,
		onCommit: (value: number) => void,
	) => {
		const clampPadding = (input: number) =>
			Math.max(range().min, Number.isFinite(input) ? input : 0);
		return (
			<div>
				<div class="flex items-center justify-between text-xs text-gray-11">
					<span>{label}</span>
					<span class="tabular-nums text-gray-12">
						{value() >= 0 ? "+" : ""}
						{value().toFixed(2)}s
					</span>
				</div>
				<input
					type="range"
					min={range().min}
					max={Math.max(range().max, stored())}
					step="0.01"
					value={value()}
					onInput={(e) =>
						set(clampPadding(Number.parseFloat(e.currentTarget.value)))
					}
					onChange={(e) =>
						onCommit(clampPadding(Number.parseFloat(e.currentTarget.value)))
					}
					class="mt-1 w-full h-1 accent-blue-9"
				/>
			</div>
		);
	};

	return (
		<div
			ref={popoverRef}
			class="fixed z-50 w-56 rounded-lg border border-gray-4 bg-gray-2 p-3 shadow-xl animate-in fade-in zoom-in-95 duration-100"
			style={{
				left: `${Math.max(8, Math.min(props.position.x, window.innerWidth - 232))}px`,
				top: `${Math.max(8, Math.min(props.position.y, window.innerHeight - 220))}px`,
			}}
			onClick={(e) => e.stopPropagation()}
			onKeyDown={(e) => {
				e.stopPropagation();
				if (e.key === "Escape") props.onClose();
			}}
		>
			<div class="flex items-center justify-between">
				<span class="text-xs font-medium text-gray-12">
					{props.cut.kind === "pause" ? "Pause cut" : `Cut "${props.cut.text}"`}
				</span>
				<button
					type="button"
					class="flex items-center justify-center size-5 rounded-sm text-gray-9 hover:bg-gray-4 hover:text-gray-12"
					aria-label="Close"
					onClick={() => props.onClose()}
				>
					<IconLucideX class="size-3" />
				</button>
			</div>
			<p class="mt-1 mb-3 text-[11px] leading-snug text-gray-10">
				Extend the cut to remove breaths, or shrink it to keep the start or end
				of the sound.
			</p>
			<div class="space-y-3">
				{slider(
					"Before",
					start,
					() => limits().before,
					() => props.cut.bufferStart ?? 0,
					setStart,
					(value) => commit(value, end()),
				)}
				{slider(
					"After",
					end,
					() => limits().after,
					() => props.cut.bufferEnd ?? 0,
					setEnd,
					(value) => commit(start(), value),
				)}
			</div>
			<button
				type="button"
				class="mt-3 flex w-full items-center justify-center gap-1 rounded-md bg-emerald-9 px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-emerald-10"
				onClick={() => props.onRestore()}
			>
				<IconLucideRotateCcw class="size-3" />
				{props.cut.kind === "pause" ? "Restore pause" : "Restore word"}
			</button>
		</div>
	);
}

function itemOfType<T extends TranscriptItem["type"]>(
	item: TranscriptItem,
	type: T,
) {
	return item.type === type
		? (item as Extract<TranscriptItem, { type: T }>)
		: undefined;
}

function TranscriptEditor(props: {
	items: readonly TranscriptItem[];
	hasContent: boolean;
	tokenCount: number;
	fillers: ReadonlySet<number>;
	activeWord: FlatWord | null;
	textSizeClass: string;
	onSeek: (item: TranscriptItem) => void;
	onDeleteWords: (words: FlatWord[]) => void;
	onCutTokens: (tokens: number[]) => boolean;
	onRestoreCuts: (ids: string[]) => boolean;
	onCutPause: (pause: SourceRange) => boolean;
	onAdjustCut: (
		cut: TranscriptCut,
		bufferStart: number,
		bufferEnd: number,
	) => boolean;
	paddingRoom: (cut: TranscriptCut) => PaddingRoom;
	onEditWord: (word: FlatWord, text: string) => void;
	onAddCaption: () => void;
}) {
	const [selectedIndices, setSelectedIndices] = createSignal<Set<number>>(
		new Set(),
	);
	const [anchorIndex, setAnchorIndex] = createSignal<number>(-1);
	const [editingIndex, setEditingIndex] = createSignal<number>(-1);
	const [padding, setPadding] = createSignal<{
		id: string;
		position: { x: number; y: number };
	} | null>(null);
	let scrollContainerRef: HTMLDivElement | undefined;

	const tokenItems = createMemo(() =>
		props.items.flatMap((item) =>
			item.type === "word" || item.type === "cut-word" ? [item] : [],
		),
	);

	const paddingCut = createMemo(() => {
		const open = padding();
		if (!open) return null;
		for (const item of props.items) {
			if (
				(item.type === "cut-word" || item.type === "cut-pause") &&
				item.cut.id === open.id
			)
				return item.cut;
		}
		return null;
	});

	createEffect(() => {
		if (padding() && !paddingCut()) setPadding(null);
	});

	const selectedCount = () => selectedIndices().size;

	const clearSelection = () => {
		setSelectedIndices(new Set<number>());
		setAnchorIndex(-1);
	};

	createEffect(
		on(
			() => props.tokenCount,
			() => {
				clearSelection();
				setEditingIndex(-1);
			},
			{ defer: true },
		),
	);

	createEffect(
		on(
			() => props.activeWord,
			(word) => {
				const el =
					scrollContainerRef?.querySelector<HTMLElement>("[data-active-word]");
				if (word && el && scrollContainerRef) {
					const container = scrollContainerRef;
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

	const selectedTokens = () =>
		[...selectedIndices()]
			.sort((a, b) => a - b)
			.flatMap((index) => {
				const item = tokenItems()[index];
				return item ? [item] : [];
			});

	const removeSelection = (mode: "captions" | "video") => {
		const tokens = selectedTokens();
		const live = tokens.flatMap((item) => (item.type === "word" ? [item] : []));
		if (live.length > 0) {
			if (mode === "video") props.onCutTokens(live.map((item) => item.token));
			else props.onDeleteWords(live.map((item) => item.word));
		} else {
			props.onRestoreCuts(
				tokens.flatMap((item) =>
					item.type === "cut-word" ? [item.cut.id] : [],
				),
			);
		}
		clearSelection();
	};

	const handleKeyDown = (e: KeyboardEvent) => {
		if (editingIndex() !== -1) return;
		const selected = selectedIndices();
		const fromContainer = e.target === scrollContainerRef;
		const action = transcriptKeyAction(e, selected.size, fromContainer);
		if (!action) return;
		e.preventDefault();
		e.stopPropagation();
		if (!fromContainer) scrollContainerRef?.focus({ preventScroll: true });

		if (action === "edit") {
			const item = tokenItems()[[...selected][0]];
			if (item?.type === "word") startEditing(item.token);
		} else if (action === "delete" || action === "cut") {
			removeSelection(action === "cut" ? "video" : "captions");
		} else {
			const target =
				action === "previous"
					? Math.max(Math.min(...selected) - 1, 0)
					: Math.min(Math.max(...selected) + 1, tokenItems().length - 1);
			setSelectedIndices(new Set([target]));
			setAnchorIndex(target);
			const item = tokenItems()[target];
			if (item) props.onSeek(item);
		}
	};

	const handleContainerClick = (e: MouseEvent) => {
		if (e.target === scrollContainerRef) clearSelection();
	};

	const handleTokenSelect = (
		item: TranscriptItem,
		idx: number,
		e: MouseEvent,
	) => {
		scrollContainerRef?.focus({ preventScroll: true });
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

		props.onSeek(item);
	};

	const removeToken = (idx: number, mode: "captions" | "video") => {
		if (!selectedIndices().has(idx) || selectedIndices().size <= 1) {
			setSelectedIndices(new Set([idx]));
		}
		removeSelection(mode);
		scrollContainerRef?.focus({ preventScroll: true });
	};

	const restoreToken = (idx: number) => {
		const tokens = selectedIndices().has(idx)
			? selectedTokens()
			: tokenItems().filter((item) => item.token === idx);
		props.onRestoreCuts(
			tokens.flatMap((item) => (item.type === "cut-word" ? [item.cut.id] : [])),
		);
		clearSelection();
		scrollContainerRef?.focus({ preventScroll: true });
	};

	const startEditing = (idx: number) => {
		setSelectedIndices(new Set([idx]));
		setAnchorIndex(idx);
		setEditingIndex(idx);
	};

	const commitEditing = (word: FlatWord, text: string) => {
		if (editingIndex() === -1) return;
		setEditingIndex(-1);
		props.onEditWord(word, text);
	};

	const cancelEditing = () => {
		setEditingIndex(-1);
	};

	const openPadding = (cut: TranscriptCut, e: MouseEvent) => {
		setPadding({ id: cut.id, position: { x: e.clientX, y: e.clientY } });
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
				when={props.hasContent}
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
					<Index each={props.items}>
						{(item) => (
							<Switch>
								<Match when={itemOfType(item(), "word")}>
									{(word) => {
										const isActive = () => props.activeWord === word().word;
										const isSelected = () =>
											selectedIndices().has(word().token);
										const isEditing = () => editingIndex() === word().token;
										return (
											<TranscriptWord
												word={word().word}
												isActive={isActive()}
												isSelected={isSelected()}
												isEditing={isEditing()}
												isFiller={props.fillers.has(word().token)}
												selectedCount={selectedCount()}
												textSizeClass={props.textSizeClass}
												onClick={(e: MouseEvent) =>
													handleTokenSelect(word(), word().token, e)
												}
												onStartEdit={() => startEditing(word().token)}
												onCommitEdit={(text: string) =>
													commitEditing(word().word, text)
												}
												onCancelEdit={cancelEditing}
												onDelete={() => removeToken(word().token, "captions")}
												onCut={() => removeToken(word().token, "video")}
											/>
										);
									}}
								</Match>
								<Match when={itemOfType(item(), "cut-word")}>
									{(cut) => (
										<CutTranscriptWord
											cut={cut().cut}
											isSelected={selectedIndices().has(cut().token)}
											selectedCount={selectedCount()}
											onClick={(e: MouseEvent) =>
												handleTokenSelect(cut(), cut().token, e)
											}
											onRestore={() => restoreToken(cut().token)}
											onAdjust={(e: MouseEvent) => openPadding(cut().cut, e)}
										/>
									)}
								</Match>
								<Match when={itemOfType(item(), "pause")}>
									{(pause) => (
										<PauseBadge
											duration={pause().end - pause().start}
											cut={false}
											onToggle={() =>
												props.onCutPause({
													start: pause().start,
													end: pause().end,
												})
											}
										/>
									)}
								</Match>
								<Match when={itemOfType(item(), "cut-pause")}>
									{(pause) => (
										<PauseBadge
											duration={pause().cut.end - pause().cut.start}
											cut
											onToggle={() => props.onRestoreCuts([pause().cut.id])}
											onAdjust={(e: MouseEvent) => openPadding(pause().cut, e)}
										/>
									)}
								</Match>
							</Switch>
						)}
					</Index>
				</div>
			</Show>
			<Show when={padding() && paddingCut()}>
				{(cut) => (
					<Portal>
						<CutPaddingPopover
							cut={cut()}
							room={props.paddingRoom(cut())}
							position={padding()?.position ?? { x: 0, y: 0 }}
							onClose={() => setPadding(null)}
							onChange={(bufferStart, bufferEnd) =>
								props.onAdjustCut(cut(), bufferStart, bufferEnd)
							}
							onRestore={() => {
								if (props.onRestoreCuts([cut().id])) setPadding(null);
							}}
						/>
					</Portal>
				)}
			</Show>
		</div>
	);
}
