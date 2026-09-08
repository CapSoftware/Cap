import { Popover } from "@kobalte/core/popover";
import { createEventListenerMap } from "@solid-primitives/event-listener";
import { cx } from "cva";
import {
	batch,
	type ComponentProps,
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	For,
	Index,
	Match,
	onCleanup,
	onMount,
	Show,
	Switch,
} from "solid-js";
import { produce } from "solid-js/store";

import type { ClipSpeedAudioMode, TimelineSegment } from "~/utils/tauri";
import {
	clampTransitionDuration,
	clipTimelineDuration,
	clipTimelineOffsets,
	clipTransitionMap,
	DEFAULT_CLIP_TRANSITION_DURATION,
	getClipTransition,
	MIN_CLIP_TRANSITION_DURATION,
	maxTransitionDuration,
} from "../clip-transitions";
import { useEditorContext } from "../context";
import { effectiveToOutput, holdWindows } from "../timeline-holds";
import { useSegmentContext, useTimelineContext } from "./context";
import { getSectionMarker } from "./sectionMarker";
import { SPLIT_SNAP_PX, snapSplitTime } from "./split-snapping";
import {
	SegmentContent,
	SegmentHandle,
	SegmentLabel,
	SegmentRoot,
	TrackRoot,
	useSegmentTranslateX,
	useSegmentWidth,
	useSetPreviewTime,
} from "./Track";

const CANVAS_HEIGHT = 52;
const WAVEFORM_MIN_DB = -60;
const WAVEFORM_SAMPLE_STEP = 0.1;
const WAVEFORM_CONTROL_STEP = 0.05;
const WAVEFORM_PADDING_SECONDS = 0.3;

const WAVEFORM_MUTE_DB = -30;
const MIN_CLIP_SEGMENT_PIXEL_WIDTH = 100;

function gainToScale(gain?: number) {
	if (!Number.isFinite(gain)) return 1;
	const value = gain as number;
	if (value <= WAVEFORM_MUTE_DB) return 0;
	return Math.max(0, (value - WAVEFORM_MUTE_DB) / -WAVEFORM_MUTE_DB);
}

const MAX_WAVEFORM_SAMPLES = 6000;

// `range` is in output (timeline) time; `sourceTimeAt` maps an output time to
// recording time, or null while a fullscreen-text hold has the clock paused —
// the mixer renders silence there, so the waveform drops to the baseline.
function createWaveformPath(
	range: { start: number; end: number },
	waveform: number[] | undefined,
	targetSamples: number,
	sourceTimeAt: (outputTime: number) => number | null,
) {
	if (typeof Path2D === "undefined") return;
	if (!waveform || waveform.length === 0) return;

	const duration = Math.max(range.end - range.start, WAVEFORM_SAMPLE_STEP);
	if (!Number.isFinite(duration) || duration <= 0) return;

	const nativeSamples = Math.ceil(duration / WAVEFORM_SAMPLE_STEP) + 1;
	const numSamples = Math.min(
		Math.max(targetSamples, 50),
		MAX_WAVEFORM_SAMPLES,
		nativeSamples,
	);

	const timeStep = duration / numSamples;

	const path = new Path2D();
	path.moveTo(0, 1);

	const amplitudeAt = (outputTime: number) => {
		const time = sourceTimeAt(outputTime);
		if (time === null) return 0;
		const index = Math.floor(time * 10);
		const sample = waveform[index];
		const db =
			typeof sample === "number" && Number.isFinite(sample)
				? sample
				: WAVEFORM_MIN_DB;
		const clamped = Math.max(db, WAVEFORM_MIN_DB);
		const amplitude = 1 + clamped / -WAVEFORM_MIN_DB;
		return Math.min(Math.max(amplitude, 0), 1);
	};

	const controlStep = Math.min(WAVEFORM_CONTROL_STEP / duration, 0.25);

	for (let i = 0; i <= numSamples; i++) {
		const time = range.start + i * timeStep;
		const normalizedX = (time - range.start) / duration;
		const prevTime = time - timeStep;
		const prevX = Math.max(0, (prevTime - range.start) / duration);
		const y = 1 - amplitudeAt(time);
		const prevY = 1 - amplitudeAt(prevTime);
		const cpX1 = prevX + controlStep / 2;
		const cpX2 = normalizedX - controlStep / 2;
		path.bezierCurveTo(cpX1, prevY, cpX2, y, normalizedX, y);
	}

	const closingX =
		(range.end + WAVEFORM_PADDING_SECONDS - range.start) / duration;
	path.lineTo(closingX, 1);
	path.closePath();

	return path;
}

function formatTime(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = Math.floor(totalSeconds % 60);

	if (hours > 0) {
		return `${hours}h ${minutes}m ${seconds}s`;
	} else if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	} else {
		return `${seconds}s`;
	}
}

const MAX_CANVAS_WIDTH = 2000;
const SAMPLES_PER_PIXEL = 2;

function WaveformCanvas(props: {
	systemWaveform?: number[];
	micWaveform?: number[];
	segment: { start: number; end: number };
	segmentOffset: number;
	holds: ReadonlyArray<[number, number]>;
}) {
	const { project, editorState } = useEditorContext();
	const { width } = useSegmentContext();
	const { timelineBounds } = useTimelineContext();

	let canvas: HTMLCanvasElement | undefined;
	let rafId: number | null = null;
	let lastRenderKey = "";

	const renderCanvas = () => {
		rafId = null;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		// Hold windows relative to the clip's box; the box is stretched across
		// them, so the canvas spans output time, not source time.
		const holds = props.holds.map(([start, end]): [number, number] => [
			start - props.segmentOffset,
			end - props.segmentOffset,
		]);
		const heldDuration = holds.reduce(
			(sum, [start, end]) => sum + end - start,
			0,
		);
		const outputDuration =
			props.segment.end - props.segment.start + heldDuration;
		const fullSegmentWidth = width();

		if (fullSegmentWidth < 1 || outputDuration <= 0) {
			return;
		}

		const sourceTimeAt = (outputTime: number): number | null => {
			let held = 0;
			for (const [start, end] of holds) {
				if (outputTime >= end) held += end - start;
				else if (outputTime > start) return null;
				else break;
			}
			return props.segment.start + outputTime - held;
		};

		const useVirtualization = fullSegmentWidth > MAX_CANVAS_WIDTH;

		let canvasWidth: number;
		let leftOffsetPx: number;
		let renderWidth: number;
		let renderRange: { start: number; end: number };

		if (useVirtualization) {
			const viewportWidth = timelineBounds.width ?? 800;
			const transform = editorState.timeline.transform;
			const viewStart = transform.position;
			const viewEnd = viewStart + transform.zoom;

			const segStart = props.segmentOffset;
			const segEnd = segStart + outputDuration;

			const visibleStart = Math.max(viewStart, segStart);
			const visibleEnd = Math.min(viewEnd, segEnd);

			if (visibleEnd <= visibleStart) {
				canvas.width = 1;
				canvas.style.left = "0px";
				canvas.style.width = "1px";
				return;
			}

			const visibleStartInSegment = visibleStart - segStart;
			const visibleEndInSegment = visibleEnd - segStart;

			const pxPerSec = fullSegmentWidth / outputDuration;
			const visibleWidthPx = Math.min(
				(visibleEndInSegment - visibleStartInSegment) * pxPerSec,
				viewportWidth + 200,
			);

			canvasWidth = Math.min(
				Math.max(Math.ceil(visibleWidthPx), 1),
				MAX_CANVAS_WIDTH,
			);
			leftOffsetPx = visibleStartInSegment * pxPerSec;
			renderWidth = visibleWidthPx;
			renderRange = {
				start: visibleStartInSegment,
				end: visibleEndInSegment,
			};
		} else {
			canvasWidth = Math.max(Math.ceil(fullSegmentWidth), 1);
			leftOffsetPx = 0;
			renderWidth = fullSegmentWidth;
			renderRange = { start: 0, end: outputDuration };
		}

		const micScale = gainToScale(project.audio.micVolumeDb);
		const systemScale = gainToScale(project.audio.systemVolumeDb);

		const holdsKey = holds
			.map(([start, end]) => `${start.toFixed(2)}:${end.toFixed(2)}`)
			.join(",");
		const renderKey = `${canvasWidth}-${props.segment.start.toFixed(2)}-${renderRange.start.toFixed(2)}-${renderRange.end.toFixed(2)}-${holdsKey}-${micScale.toFixed(2)}-${systemScale.toFixed(2)}`;
		if (renderKey === lastRenderKey) {
			return;
		}
		lastRenderKey = renderKey;

		canvas.width = canvasWidth;
		canvas.style.left = `${leftOffsetPx}px`;
		canvas.style.width = `${renderWidth}px`;

		const canvasHeight = canvas.height;
		ctx.clearRect(0, 0, canvasWidth, canvasHeight);

		const numSamples = Math.min(
			Math.ceil(canvasWidth * SAMPLES_PER_PIXEL),
			MAX_WAVEFORM_SAMPLES,
		);

		const drawWaveform = (
			waveform: number[] | undefined,
			color: string,
			gain?: number,
		) => {
			const path = createWaveformPath(
				renderRange,
				waveform,
				numSamples,
				sourceTimeAt,
			);
			if (!path) return;
			const scale = gainToScale(gain);
			if (scale <= 0) return;
			ctx.save();
			ctx.translate(0, canvasHeight * (1 - scale));
			ctx.scale(canvasWidth, canvasHeight * scale);
			ctx.fillStyle = color;
			ctx.fill(path);
			ctx.restore();
		};

		drawWaveform(
			props.micWaveform,
			"rgba(255,255,255,0.4)",
			project.audio.micVolumeDb,
		);
		drawWaveform(
			props.systemWaveform,
			"rgba(255,150,0,0.5)",
			project.audio.systemVolumeDb,
		);
	};

	createEffect(() => {
		width();
		timelineBounds.width;
		editorState.timeline.transform.position;
		editorState.timeline.transform.zoom;
		props.segment.start;
		props.segment.end;
		props.segmentOffset;
		props.holds;
		props.micWaveform;
		props.systemWaveform;
		project.audio.micVolumeDb;
		project.audio.systemVolumeDb;

		if (rafId !== null) {
			cancelAnimationFrame(rafId);
		}
		rafId = requestAnimationFrame(renderCanvas);
	});

	onMount(() => {
		setTimeout(() => {
			lastRenderKey = "";
			if (rafId !== null) {
				cancelAnimationFrame(rafId);
			}
			rafId = requestAnimationFrame(renderCanvas);
		}, 300);
	});

	onCleanup(() => {
		if (rafId !== null) {
			cancelAnimationFrame(rafId);
		}
	});

	return (
		<canvas
			ref={(el) => {
				canvas = el;
			}}
			class="absolute top-0 h-full pointer-events-none"
			style={{ left: "0px" }}
			height={CANVAS_HEIGHT}
		/>
	);
}

// The speed chip is rendered once per label tier so an open popover survives
// the segment shrinking past a tier boundary; the menu itself lives here so
// it isn't duplicated per tier.
function ClipSpeedControl(props: {
	timescale: number;
	speedAudioMode?: ClipSpeedAudioMode | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	triggerClass?: string;
	onSetTimescale: (timescale: number) => void;
	onSetSpeedAudioMode: (mode: ClipSpeedAudioMode) => void;
}) {
	return (
		<Popover
			placement="top"
			gutter={8}
			open={props.open}
			onOpenChange={props.onOpenChange}
		>
			<Popover.Trigger
				class={cx(
					"pointer-events-auto flex items-center gap-0.5 rounded-full bg-black/30 px-1.5 py-0.5 text-[10px] font-medium text-white transition-colors hover:bg-black/50",
					props.triggerClass,
				)}
				aria-label={`Clip speed: ${props.timescale}x`}
				onMouseDown={(event) => event.stopPropagation()}
			>
				<IconLucideFastForward class="size-2.5" />
				{props.timescale}x
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					onMouseDown={(event) => event.stopPropagation()}
					class="z-50 flex w-max flex-col gap-1.5 rounded-xl border border-gray-3 bg-gray-1 p-2 text-gray-12 shadow-xl outline-hidden animate-in fade-in slide-in-from-bottom-2"
				>
					<div class="flex items-center gap-1 rounded-lg bg-gray-2 p-1">
						{[0.25, 0.5, 1, 1.5, 2, 4, 8].map((mult) => (
							<button
								type="button"
								aria-pressed={props.timescale === mult}
								class={cx(
									"rounded-md px-2 py-1 text-xs whitespace-nowrap transition-colors",
									props.timescale === mult
										? "bg-gray-4 text-gray-12"
										: "text-gray-10 hover:text-gray-12",
								)}
								onClick={() => props.onSetTimescale(mult)}
							>
								{mult}x
							</button>
						))}
					</div>
					<Show when={props.timescale !== 1}>
						<div class="flex items-center gap-1 rounded-lg bg-gray-2 p-1">
							{(
								[
									["mute", "Mute"],
									["maintainPitch", "Maintain pitch"],
									["matchSpeed", "Match speed"],
								] as const
							).map(([value, label]) => (
								<button
									type="button"
									aria-pressed={(props.speedAudioMode ?? "mute") === value}
									class={cx(
										"flex-1 rounded-md px-2 py-1 text-xs whitespace-nowrap transition-colors",
										(props.speedAudioMode ?? "mute") === value
											? "bg-gray-4 text-gray-12"
											: "text-gray-10 hover:text-gray-12",
									)}
									onClick={() => props.onSetSpeedAudioMode(value)}
								>
									{label}
								</button>
							))}
						</div>
					</Show>
				</Popover.Content>
			</Popover.Portal>
		</Popover>
	);
}

export function ClipTrack(
	props: Pick<ComponentProps<"div">, "ref"> & {
		handleUpdatePlayhead: (e: MouseEvent) => void;
	},
) {
	const {
		project,
		setProject,
		projectActions,
		editorInstance,
		projectHistory,
		editorState,
		setEditorState,
		totalDuration,
		micWaveforms,
		systemAudioWaveforms,
	} = useEditorContext();

	const { secsPerPixel, duration, isSegmentVisible } = useTimelineContext();
	const setPreviewTime = useSetPreviewTime();

	const segments = (): Array<TimelineSegment> =>
		project.timeline?.segments ?? [{ start: 0, end: duration(), timescale: 1 }];
	const [transitionDrag, setTransitionDrag] = createSignal<{
		index: number;
		duration: number;
	} | null>(null);
	const selectedClipIndices = createMemo(() => {
		const selection = editorState.timeline.selection;
		if (!selection || selection.type !== "clip") return null;
		return new Set(selection.indices);
	});
	const totalClipTimelineDuration = createMemo(() => {
		return clipTimelineDuration(
			segments(),
			project.timeline?.transitions ?? [],
		);
	});
	const effectiveTransitions = createMemo(() =>
		clipTransitionMap(segments(), project.timeline?.transitions ?? []),
	);

	const segmentOffsets = createMemo(() => {
		const segs = segments();
		const transitions = project.timeline?.transitions ?? [];
		const offsets = clipTimelineOffsets(segs, transitions);
		const drag = transitionDrag();
		if (drag) {
			const committed =
				getClipTransition(segs, transitions, drag.index)?.duration ?? 0;
			const shift = committed - drag.duration;
			for (let index = drag.index; index < offsets.length; index++) {
				offsets[index] += shift;
			}
		}
		return offsets;
	});

	const transitionAt = (index: number) => {
		const drag = transitionDrag();
		const transition = effectiveTransitions()[index] ?? null;
		if (drag?.index !== index) return transition;
		if (drag.duration === 0) return null;
		return {
			segmentIndex: index,
			type: transition?.type ?? ("cross-fade" as const),
			duration: drag.duration,
		};
	};

	// Fullscreen text segments pause the recording clock, stretching the clip
	// that contains them across the held window on the output timeline.
	const heldWindows = createMemo(() =>
		holdWindows(project.timeline?.textSegments),
	);

	const selectedHoldWindows = createMemo(() => {
		const selection = editorState.timeline.selection;
		if (selection?.type !== "text") return null;
		const texts = project.timeline?.textSegments;
		if (!texts) return null;
		const windows = selection.indices
			.map((index) => texts[index])
			.filter(
				(segment) =>
					segment &&
					segment.enabled !== false &&
					segment.layout === "fullscreen",
			)
			.map((segment): [number, number] => [segment.start, segment.end]);
		return windows.length > 0 ? windows : null;
	});

	const visibleSegmentIndices = createMemo(() => {
		const segs = segments();
		const offsets = segmentOffsets();
		const holds = heldWindows();
		const draggedIndex = transitionDrag()?.index;
		const visible: number[] = [];
		for (let i = 0; i < segs.length; i++) {
			const seg = segs[i];
			const segStart = effectiveToOutput(holds, offsets[i]);
			const segEnd = effectiveToOutput(
				holds,
				offsets[i] + (seg.end - seg.start) / seg.timescale,
			);
			if (i === draggedIndex || isSegmentVisible(segStart, segEnd)) {
				visible.push(i);
			}
		}
		return visible;
	});

	function onHandleReleased() {
		projectActions.normalizeClipTransitions();
		const { transform } = editorState.timeline;

		if (transform.position + transform.zoom > totalDuration() + 4) {
			transform.updateZoom(
				totalDuration(),
				editorState.previewTime ?? editorState.playbackTime,
			);
		}
	}

	const hasMultipleRecordingSegments = () =>
		editorInstance.recordings.segments.length > 1;

	const split = () => editorState.timeline.interactMode === "split";

	createEffect(() => {
		if (!split()) setEditorState("timeline", "splitPreview", null);
	});

	function selectClip(currentIndex: number, event: MouseEvent) {
		const selection = editorState.timeline.selection;
		const isMac = navigator.platform.toUpperCase().includes("MAC");
		const isMultiSelect = isMac ? event.metaKey : event.ctrlKey;

		if (event.shiftKey && selection?.type === "clip") {
			const lastIndex = selection.indices.at(-1) ?? currentIndex;
			const start = Math.min(lastIndex, currentIndex);
			const end = Math.max(lastIndex, currentIndex);
			setEditorState("timeline", "selection", {
				type: "clip",
				indices: Array.from({ length: end - start + 1 }, (_, i) => start + i),
			});
		} else if (isMultiSelect && selection?.type === "clip") {
			const indices = selection.indices.includes(currentIndex)
				? selection.indices.filter((index) => index !== currentIndex)
				: [...selection.indices, currentIndex];
			setEditorState(
				"timeline",
				"selection",
				indices.length > 0 ? { type: "clip", indices } : null,
			);
		} else {
			setEditorState("timeline", "selection", {
				type: "clip",
				indices: [currentIndex],
			});
		}

		props.handleUpdatePlayhead(event);
	}

	return (
		<TrackRoot
			ref={props.ref}
			onMouseEnter={() => setEditorState("timeline", "hoveredTrack", "clip")}
			onMouseLeave={() => {
				setEditorState("timeline", "hoveredTrack", null);
				setEditorState("timeline", "splitPreview", null);
			}}
		>
			<Index each={visibleSegmentIndices()}>
				{(segmentIndex) => {
					const i = segmentIndex;
					const segment = () => segments()[i()];
					const [speedOpen, setSpeedOpen] = createSignal(false);

					const clipName = () =>
						hasMultipleRecordingSegments()
							? `Clip ${segment().recordingSegment}`
							: "Clip";

					const clipTitle = () => {
						const seg = segment();
						const parts = [clipName(), formatTime(seg.end - seg.start)];
						if (seg.timescale !== 1) parts.push(`${seg.timescale}x`);
						return parts.join(" · ");
					};

					const [startHandleDrag, setStartHandleDrag] = createSignal<null | {
						offset: number;
						initialStart: number;
					}>(null);

					const prevDuration = createMemo(() => segmentOffsets()[i()] ?? 0);

					const relativeSegment = createMemo(() => {
						const ds = startHandleDrag();
						const offset = ds?.offset ?? 0;
						const seg = segment();
						const holds = heldWindows();

						return {
							start: Math.max(
								effectiveToOutput(holds, prevDuration() + offset),
								0,
							),
							end: effectiveToOutput(
								holds,
								prevDuration() +
									(offset + (seg.end - seg.start)) / seg.timescale,
							),
							timescale: seg.timescale,
							recordingSegment: seg.recordingSegment,
						};
					});

					// Held (paused) windows inside this clip's on-screen box.
					const segmentHolds = createMemo(() => {
						const { start, end } = relativeSegment();
						return heldWindows()
							.map(([holdStart, holdEnd]): [number, number] => [
								Math.max(holdStart, start),
								Math.min(holdEnd, end),
							])
							.filter(([holdStart, holdEnd]) => holdEnd > holdStart);
					});

					const segmentX = useSegmentTranslateX(relativeSegment);
					const segmentWidth = useSegmentWidth(relativeSegment);

					const splitTimeAt = (e: {
						clientX: number;
						altKey: boolean;
						currentTarget: HTMLDivElement;
					}) => {
						const rect = e.currentTarget.getBoundingClientRect();
						const seg = relativeSegment();
						const raw = seg.start + (e.clientX - rect.left) * secsPerPixel();
						if (e.altKey) return { time: raw, snapped: null };
						return snapSplitTime(
							raw,
							seg.start,
							seg.end,
							SPLIT_SNAP_PX * secsPerPixel(),
							project.timeline,
							editorState.playbackTime,
						);
					};

					const segmentRecording = (s = i()) =>
						editorInstance.recordings.segments[
							segments()[s].recordingSegment ?? 0
						];

					const marker = useSectionMarker(() => ({
						segments: segments(),
						i: i(),
						position: "left",
					}));

					const endMarker = useSectionMarker(() => ({
						segments: segments(),
						i: i(),
						position: "right",
					}));

					const isSelected = createMemo(() => {
						const indices = selectedClipIndices();
						if (!indices) return false;
						return indices.has(i());
					});

					const micWaveform = () => {
						if (project.audio.micVolumeDb && project.audio.micVolumeDb < -30)
							return;

						const idx = segment().recordingSegment ?? i();
						return micWaveforms()?.[idx] ?? [];
					};

					const systemAudioWaveform = () => {
						if (
							project.audio.systemVolumeDb &&
							project.audio.systemVolumeDb < -30
						)
							return;

						const idx = segment().recordingSegment ?? i();
						return systemAudioWaveforms()?.[idx] ?? [];
					};

					return (
						<>
							<Show when={marker()}>
								{(marker) => (
									<div
										class="absolute w-0 z-10 h-full *:absolute"
										style={{
											transform: `translateX(${segmentX()}px)`,
										}}
									>
										<div class="w-[2px] bottom-0 -top-2 rounded-full from-red-300 to-transparent bg-linear-to-b -translate-x-1/2" />
										<Switch>
											<Match
												when={(() => {
													const m = marker();
													if (m.type === "single") return m.value;
												})()}
											>
												{(markerValue) => {
													const value = createMemo(() => {
														const m = markerValue();
														return m.type === "time" ? m.time : 0;
													});

													return (
														<div class="overflow-hidden -top-8 z-10 h-7 rounded-full -translate-x-1/2">
															<CutOffsetButton
																value={value()}
																onClick={() => {
																	setProject(
																		"timeline",
																		"segments",
																		produce((s) => {
																			if (markerValue().type === "reset") {
																				s[i() - 1].end = s[i()].end;
																				s.splice(i(), 1);
																			} else {
																				s[i() - 1].end = s[i()].start;
																			}
																		}),
																	);
																}}
															/>
														</div>
													);
												}}
											</Match>
											<Match
												when={(() => {
													const m = marker();
													if (
														m.type === "dual" &&
														m.right &&
														m.right.type === "time"
													)
														return m.right;
												})()}
											>
												{(markerValue) => {
													const value = createMemo(() => {
														const m = markerValue();
														return m.type === "time" ? m.time : 0;
													});

													return (
														<div class="flex absolute -top-8 flex-row w-0 h-7 rounded-full">
															<CutOffsetButton
																value={value()}
																class="-left-px absolute rounded-r-full pl-1.5! rounded-tl-full"
																onClick={() => {
																	setProject(
																		"timeline",
																		"segments",
																		i(),
																		"start",
																		0,
																	);
																}}
															/>
														</div>
													);
												}}
											</Match>
										</Switch>
									</div>
								)}
							</Show>
							<SegmentRoot
								segColor="var(--track-clip)"
								class={cx(
									"border transition-colors duration-200 group",
									isSelected() ? "border-gray-12" : "border-transparent",
								)}
								innerClass="ring-blue-9"
								title={clipTitle()}
								segment={relativeSegment()}
								onMouseMove={(e) => {
									if (editorState.timeline.interactMode !== "split") return;
									const result = splitTimeAt(e);
									setEditorState("timeline", "splitPreview", {
										time: result.time,
										snapped: result.snapped !== null,
									});
								}}
								onMouseLeave={() => {
									if (editorState.timeline.splitPreview)
										setEditorState("timeline", "splitPreview", null);
								}}
								onMouseDown={(e) => {
									e.stopPropagation();
									if (e.button !== 0) return;
									if (
										(e.target as HTMLElement).closest(
											"[data-clip-handle], [data-transition]",
										)
									)
										return;

									if (editorState.timeline.interactMode === "split") {
										// The box is in output time (it stretches across any
										// held windows); splitClipSegment converts back to the
										// recording-flow domain itself.
										projectActions.splitClipSegment(splitTimeAt(e).time, i());
									} else {
										const index = i();
										const initialTransition = getClipTransition(
											segments(),
											project.timeline?.transitions ?? [],
											index,
										);
										const initialDuration = initialTransition?.duration ?? 0;
										const canDrag =
											index > 0 && !e.shiftKey && !e.ctrlKey && !e.metaKey;
										const startX = e.clientX;
										let active = false;
										let nextDuration = initialDuration;
										let pendingX = startX;
										let frame: number | null = null;

										const update = () => {
											frame = null;
											const delta = pendingX - startX;
											if (!active) {
												if (!canDrag || Math.abs(delta) < 4) return;
												if (!initialTransition && delta > 0) return;
												active = true;
											}

											const requested =
												initialDuration - delta * secsPerPixel();
											nextDuration =
												requested < MIN_CLIP_TRANSITION_DURATION / 2
													? 0
													: clampTransitionDuration(
															requested || DEFAULT_CLIP_TRANSITION_DURATION,
															segments()[index - 1],
															segments()[index],
														);
											setTransitionDrag({ index, duration: nextDuration });
										};

										createRoot((dispose) => {
											onCleanup(() => {
												if (frame !== null) cancelAnimationFrame(frame);
											});
											createEventListenerMap(window, {
												mousemove: (event) => {
													pendingX = event.clientX;
													if (frame === null)
														frame = requestAnimationFrame(update);
												},
												mouseup: (event) => {
													pendingX = event.clientX;
													if (frame !== null) {
														cancelAnimationFrame(frame);
														frame = null;
													}
													update();
													if (active) {
														projectActions.setClipTransition(
															index,
															nextDuration > 0
																? {
																		type:
																			initialTransition?.type ?? "cross-fade",
																		duration: nextDuration,
																	}
																: null,
														);
														setEditorState(
															"timeline",
															"selection",
															nextDuration > 0
																? { type: "transition", index }
																: null,
														);
														setTransitionDrag(null);
													} else {
														selectClip(index, event);
													}
													dispose();
												},
												blur: () => {
													setTransitionDrag(null);
													dispose();
												},
											});
										});
									}
								}}
							>
								{segment().timescale === 1 && (
									<WaveformCanvas
										micWaveform={micWaveform()}
										systemWaveform={systemAudioWaveform()}
										segment={segment()}
										segmentOffset={relativeSegment().start}
										holds={segmentHolds()}
									/>
								)}

								<Markings
									segment={segment()}
									prevDuration={relativeSegment().start}
									holds={segmentHolds()}
								/>

								<For each={segmentHolds()}>
									{(hold) => {
										// Light up when the fullscreen text causing this hold
										// is selected, so cause and effect read as one thing.
										const causeSelected = () =>
											selectedHoldWindows()?.some(
												([start, end]) => start < hold[1] && end > hold[0],
											) ?? false;
										const holdWidth = () =>
											(hold[1] - hold[0]) / secsPerPixel();
										return (
											<div
												class={cx(
													"absolute inset-y-0 z-[3] flex items-center justify-center gap-1 overflow-hidden bg-black/45 backdrop-saturate-50 border-x transition-colors",
													causeSelected() ? "border-blue-9" : "border-white/25",
												)}
												style={{
													left: `${(hold[0] - relativeSegment().start) / secsPerPixel()}px`,
													width: `${holdWidth()}px`,
													"background-image":
														"repeating-linear-gradient(-45deg, rgba(255,255,255,0.07) 0px, rgba(255,255,255,0.07) 4px, transparent 4px, transparent 8px)",
												}}
												title="Video paused while the fullscreen text is shown"
											>
												<IconLucidePause
													class={cx(
														"size-3 shrink-0",
														causeSelected() ? "text-blue-9" : "text-white/70",
													)}
												/>
												<Show when={holdWidth() >= 64}>
													<span
														class={cx(
															"text-[10px] font-medium whitespace-nowrap",
															causeSelected() ? "text-blue-9" : "text-white/70",
														)}
													>
														Paused
													</span>
												</Show>
											</div>
										);
									}}
								</For>

								<Show when={i() > 0 && !transitionAt(i())}>
									<button
										type="button"
										data-transition
										class="absolute inset-y-0 left-0 z-[4] grid w-4 -translate-x-1/2 place-items-center bg-blue-9/40 text-xs text-white opacity-0 transition-opacity hover:bg-blue-9/60 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-blue-9"
										aria-label={`Add transition before clip ${i() + 1}`}
										onClick={(event) => {
											event.stopPropagation();
											projectActions.setClipTransition(i(), {
												type: "cross-fade",
												duration: DEFAULT_CLIP_TRANSITION_DURATION,
											});
											setEditorState("timeline", "selection", {
												type: "transition",
												index: i(),
											});
										}}
									>
										+
									</button>
								</Show>

								<Show when={transitionAt(i())}>
									{(transition) => (
										<Popover
											placement="top"
											gutter={8}
											open={
												editorState.timeline.selection?.type === "transition" &&
												editorState.timeline.selection.index === i()
											}
											onOpenChange={(open) =>
												setEditorState(
													"timeline",
													"selection",
													open ? { type: "transition", index: i() } : null,
												)
											}
										>
											<Popover.Trigger
												data-transition
												class={cx(
													"absolute inset-y-0 left-0 z-[5] overflow-hidden border-x border-blue-7/80 bg-blue-9/25 text-white transition-colors hover:bg-blue-9/40",
													editorState.timeline.selection?.type ===
														"transition" &&
														editorState.timeline.selection.index === i() &&
														"bg-blue-9/50 ring-1 ring-inset ring-blue-10",
												)}
												style={{
													width: `${transition().duration / secsPerPixel()}px`,
													"background-image":
														"linear-gradient(135deg, transparent 42%, rgb(96 165 250 / 0.7) 43%, rgb(96 165 250 / 0.7) 57%, transparent 58%)",
												}}
												title={`${transition().type === "cross-fade" ? "Crossfade" : "Fade through black"} · ${transition().duration.toFixed(2)}s`}
												onMouseDown={(event) => event.stopPropagation()}
											>
												<span class="sr-only">Edit clip transition</span>
											</Popover.Trigger>
											<Popover.Portal>
												<Popover.Content
													onMouseDown={(event) => event.stopPropagation()}
													class="z-50 flex w-64 flex-col gap-3 rounded-xl border border-gray-3 bg-gray-1 p-3 text-gray-12 shadow-xl outline-hidden"
												>
													<div class="flex items-center justify-between">
														<span class="text-sm font-medium">
															Clip transition
														</span>
														<span class="text-xs tabular-nums text-gray-10">
															{transition().duration.toFixed(2)}s
														</span>
													</div>
													<div class="grid grid-cols-2 gap-1 rounded-lg bg-gray-2 p-1">
														{(
															[
																["cross-fade", "Crossfade"],
																["fade-through-black", "Fade"],
															] as const
														).map(([type, label]) => (
															<button
																type="button"
																aria-pressed={transition().type === type}
																class={cx(
																	"rounded-md px-2 py-1.5 text-xs transition-colors",
																	transition().type === type
																		? "bg-gray-4 text-gray-12"
																		: "text-gray-10 hover:text-gray-12",
																)}
																onClick={() =>
																	projectActions.setClipTransition(i(), {
																		type,
																		duration: transition().duration,
																	})
																}
															>
																{label}
															</button>
														))}
													</div>
													<input
														type="range"
														aria-label="Transition duration"
														min={MIN_CLIP_TRANSITION_DURATION}
														max={maxTransitionDuration(
															segments()[i() - 1],
															segment(),
														)}
														step={0.05}
														value={transition().duration}
														onChange={(event) =>
															projectActions.setClipTransition(i(), {
																type: transition().type,
																duration: event.currentTarget.valueAsNumber,
															})
														}
													/>
													<button
														type="button"
														class="rounded-lg border border-red-500/30 px-3 py-2 text-xs text-red-400 transition-colors hover:bg-red-500/10"
														onClick={() =>
															projectActions.deleteClipTransition(i())
														}
													>
														Remove transition
													</button>
												</Popover.Content>
											</Popover.Portal>
										</Popover>
									)}
								</Show>

								<SegmentHandle
									position="start"
									data-clip-handle
									class="opacity-0 group-hover:opacity-100"
									onMouseDown={(downEvent) => {
										if (split()) return;
										const seg = segment();
										const minRecordedDuration = Math.max(
											1,
											secsPerPixel() *
												MIN_CLIP_SEGMENT_PIXEL_WIDTH *
												seg.timescale,
											Math.max(
												effectiveTransitions()[i()]?.duration ?? 0,
												effectiveTransitions()[i() + 1]?.duration ?? 0,
											) *
												2 *
												seg.timescale,
										);

										const initialStart = seg.start;
										setStartHandleDrag({
											offset: 0,
											initialStart,
										});

										const maxSegmentDuration =
											editorInstance.recordings.segments[
												seg.recordingSegment ?? 0
											].display.duration;

										const availableTimelineDuration =
											editorInstance.recordingDuration -
											(totalClipTimelineDuration() -
												(seg.end - seg.start) / seg.timescale);

										const maxDuration = Math.min(
											maxSegmentDuration,
											availableTimelineDuration,
										);

										const prevSegment = segments()[i() - 1];
										const prevSegmentIsSameClip =
											prevSegment?.recordingSegment !== undefined
												? prevSegment.recordingSegment === seg.recordingSegment
												: false;

										function update(event: MouseEvent) {
											const newStart =
												initialStart +
												(event.clientX - downEvent.clientX) *
													secsPerPixel() *
													seg.timescale;

											const clampedStart = Math.min(
												Math.max(
													newStart,
													prevSegmentIsSameClip ? prevSegment.end : 0,
													seg.end - maxDuration,
												),
												seg.end - minRecordedDuration,
											);

											setStartHandleDrag({
												offset: clampedStart - initialStart,
												initialStart,
											});

											batch(() => {
												setProject(
													"timeline",
													"segments",
													i(),
													"start",
													clampedStart,
												);
												setPreviewTime(prevDuration());
											});
										}

										const resumeHistory = projectHistory.pause();
										createRoot((dispose) => {
											onCleanup(() => {
												resumeHistory();
												setStartHandleDrag(null);
												onHandleReleased();
											});

											createEventListenerMap(window, {
												mousemove: update,
												mouseup: (e) => {
													update(e);
													dispose();
												},
												blur: () => dispose(),
												mouseleave: () => dispose(),
											});
										});
									}}
								/>
								<SegmentContent class="relative justify-center items-center">
									{(() => {
										const seg = segment();

										const speedControl = (triggerClass?: string) => (
											<ClipSpeedControl
												timescale={seg.timescale}
												speedAudioMode={seg.speedAudioMode}
												open={speedOpen()}
												onOpenChange={setSpeedOpen}
												triggerClass={triggerClass}
												onSetTimescale={(mult) =>
													projectActions.setClipSegmentTimescale(i(), mult)
												}
												onSetSpeedAudioMode={(mode) =>
													projectActions.setClipSegmentSpeedAudioMode(i(), mode)
												}
											/>
										);

										return (
											<SegmentLabel
												full={() => (
													<div class="flex flex-col gap-1 justify-center items-center text-xs whitespace-nowrap text-gray-12">
														<span class="text-white/70">{clipName()}</span>
														<div class="flex gap-1 items-center text-md dark:text-gray-12 text-gray-1">
															<IconLucideClock class="size-3.5" />{" "}
															{formatTime(seg.end - seg.start)}
															{speedControl()}
														</div>
													</div>
												)}
												compact={() => (
													<div class="flex gap-1 items-center text-[10px] whitespace-nowrap dark:text-gray-12 text-gray-1">
														{speedControl("shrink-0")}
														<span class="truncate">
															{formatTime(seg.end - seg.start)}
														</span>
													</div>
												)}
												glyph={
													seg.timescale !== 1
														? () => speedControl("shrink-0")
														: undefined
												}
											/>
										);
									})()}
								</SegmentContent>
								<SegmentHandle
									position="end"
									data-clip-handle
									class="opacity-0 group-hover:opacity-100"
									onMouseDown={(downEvent) => {
										const seg = segment();
										const end = seg.end;
										const minRecordedDuration = Math.max(
											1,
											secsPerPixel() *
												MIN_CLIP_SEGMENT_PIXEL_WIDTH *
												seg.timescale,
											Math.max(
												effectiveTransitions()[i()]?.duration ?? 0,
												effectiveTransitions()[i() + 1]?.duration ?? 0,
											) *
												2 *
												seg.timescale,
										);

										if (split()) return;
										const maxSegmentDuration =
											editorInstance.recordings.segments[
												seg.recordingSegment ?? 0
											].display.duration;

										const availableTimelineDuration =
											editorInstance.recordingDuration -
											(totalClipTimelineDuration() -
												(seg.end - seg.start) / seg.timescale);

										const nextSegment = segments()[i() + 1];
										const nextSegmentIsSameClip =
											nextSegment?.recordingSegment !== undefined
												? nextSegment.recordingSegment === seg.recordingSegment
												: false;

										function update(event: MouseEvent) {
											const deltaRecorded =
												(event.clientX - downEvent.clientX) *
												secsPerPixel() *
												seg.timescale;
											const newEnd = end + deltaRecorded;
											const clampedEnd = Math.max(
												Math.min(
													newEnd,
													end + availableTimelineDuration * seg.timescale,
													nextSegmentIsSameClip
														? nextSegment.start
														: maxSegmentDuration,
												),
												seg.start + minRecordedDuration,
											);

											batch(() => {
												setProject(
													"timeline",
													"segments",
													i(),
													"end",
													clampedEnd,
												);
												setPreviewTime(
													prevDuration() +
														(clampedEnd - seg.start) / seg.timescale,
												);
											});
										}

										const resumeHistory = projectHistory.pause();
										createRoot((dispose) => {
											createEventListenerMap(window, {
												mousemove: update,
												mouseup: (e) => {
													dispose();
													resumeHistory();
													update(e);
													onHandleReleased();
												},
												blur: () => {
													dispose();
													resumeHistory();
													onHandleReleased();
												},
												mouseleave: () => {
													dispose();
													resumeHistory();
													onHandleReleased();
												},
											});
										});
									}}
								/>
							</SegmentRoot>
							<Show
								when={(() => {
									const m = endMarker();
									if (m?.type === "dual" && m.left && m.left.type === "time")
										return m.left;
								})()}
							>
								{(markerValue) => {
									const value = createMemo(() => {
										const m = markerValue();
										return m.type === "time" ? m.time : 0;
									});

									return (
										<div
											class="absolute w-0 z-10 h-full *:absolute"
											style={{
												transform: `translateX(${segmentX() + segmentWidth()}px)`,
											}}
										>
											<div class="w-[2px] bottom-0 -top-2 rounded-full from-red-300 to-transparent bg-linear-to-b -translate-x-1/2" />
											<div class="flex absolute -top-8 flex-row w-0 h-7 rounded-full">
												<CutOffsetButton
													value={value()}
													class="-right-px absolute rounded-l-full pr-1.5! rounded-tr-full"
													onClick={() => {
														setProject(
															"timeline",
															"segments",
															i(),
															"end",
															segmentRecording().display.duration,
														);
													}}
												/>
											</div>
										</div>
									);
								}}
							</Show>
						</>
					);
				}}
			</Index>
		</TrackRoot>
	);
}

function Markings(props: {
	segment: TimelineSegment;
	prevDuration: number;
	holds: ReadonlyArray<[number, number]>;
}) {
	const { editorState } = useEditorContext();
	const { secsPerPixel, markingResolution } = useTimelineContext();

	const transform = () => editorState.timeline.transform;

	const markingParams = () => {
		const resolution = markingResolution();
		const visibleMin =
			transform().position - props.prevDuration + props.segment.start;
		const visibleMax = visibleMin + transform().zoom;
		const start = Math.floor(visibleMin / resolution);
		const count = Math.ceil(visibleMax / resolution) - start;
		return { resolution, start, count };
	};

	const getMarkingTime = (index: number) => {
		const { resolution, start } = markingParams();
		return (start + index) * resolution;
	};

	return (
		<Index each={Array.from({ length: markingParams().count })}>
			{(_, index) => {
				const marking = () => getMarkingTime(index);
				// Markings live in recording time; push each past the holds the
				// stretched box inserts before it.
				const translateX = () => {
					const holdsRel = props.holds.map(([start, end]): [number, number] => [
						start - props.prevDuration,
						end - props.prevDuration,
					]);
					const effective = marking() - props.segment.start;
					return effectiveToOutput(holdsRel, effective) / secsPerPixel();
				};

				return (
					<div
						style={{
							transform: `translateX(${translateX()}px)`,
						}}
						class="absolute z-10 w-px h-12 bg-linear-to-b from-transparent to-transparent via-white-transparent-40 dark:via-black-transparent-60"
					/>
				);
			}}
		</Index>
	);
}

function CutOffsetButton(props: {
	value: number;
	class?: string;
	onClick?(): void;
}) {
	return (
		<button
			class={cx(
				"h-7 bg-red-300 text-nowrap hover:bg-red-400 text-xs tabular-nums text-white p-2 flex flex-row items-center transition-colors",
				props.class,
			)}
			onClick={() => props.onClick?.()}
		>
			<Show
				when={props.value !== 0}
				fallback={<IconCapScissors class="size-3.5" />}
			>
				{formatTime(props.value)}
			</Show>
		</button>
	);
}

function useSectionMarker(
	props: () => {
		segments: TimelineSegment[];
		i: number;
		position: "left" | "right";
	},
) {
	const { editorInstance } = useEditorContext();

	return () => getSectionMarker(props(), editorInstance.recordings.segments);
}
