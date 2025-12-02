import {
	createEventListener,
	createEventListenerMap,
} from "@solid-primitives/event-listener";
import { cx } from "cva";
import {
	type ComponentProps,
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	For,
	Index,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { produce } from "solid-js/store";

import type { TimelineSegment } from "~/utils/tauri";
import { useEditorContext } from "../context";
import { useSegmentContext, useTimelineContext } from "./context";
import { getSectionMarker } from "./sectionMarker";
import {
	SegmentContent,
	SegmentHandle,
	SegmentRoot,
	TrackRoot,
	useSegmentTranslateX,
	useSegmentWidth,
} from "./Track";

const CANVAS_HEIGHT = 52;
const WAVEFORM_MIN_DB = -60;
const WAVEFORM_SAMPLE_STEP = 0.1;
const WAVEFORM_CONTROL_STEP = 0.05;
const WAVEFORM_PADDING_SECONDS = 0.3;

function gainToScale(gain?: number) {
	if (!Number.isFinite(gain)) return 1;
	const value = gain as number;
	if (value <= WAVEFORM_MIN_DB) return 0;
	return Math.max(0, 1 + value / -WAVEFORM_MIN_DB);
}

function createWaveformPath(
	segment: { start: number; end: number },
	waveform?: number[],
) {
	if (typeof Path2D === "undefined") return;
	if (!waveform || waveform.length === 0) return;

	const duration = Math.max(segment.end - segment.start, WAVEFORM_SAMPLE_STEP);
	if (!Number.isFinite(duration) || duration <= 0) return;

	const path = new Path2D();
	path.moveTo(0, 1);

	const amplitudeAt = (index: number) => {
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

	for (
		let time = segment.start;
		time <= segment.end + WAVEFORM_SAMPLE_STEP;
		time += WAVEFORM_SAMPLE_STEP
	) {
		const index = Math.floor(time * 10);
		const normalizedX = (index / 10 - segment.start) / duration;
		const prevX =
			(index / 10 - WAVEFORM_SAMPLE_STEP - segment.start) / duration;
		const y = 1 - amplitudeAt(index);
		const prevY = 1 - amplitudeAt(index - 1);
		const cpX1 = prevX + controlStep / 2;
		const cpX2 = normalizedX - controlStep / 2;
		path.bezierCurveTo(cpX1, prevY, cpX2, y, normalizedX, y);
	}

	const closingX =
		(segment.end + WAVEFORM_PADDING_SECONDS - segment.start) / duration;
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

function WaveformCanvas(props: {
	systemWaveform?: number[];
	micWaveform?: number[];
	segment: { start: number; end: number };
}) {
	const { project } = useEditorContext();
	const { width } = useSegmentContext();
	const segmentRange = createMemo(() => ({
		start: props.segment.start,
		end: props.segment.end,
	}));
	const micPath = createMemo(() =>
		createWaveformPath(segmentRange(), props.micWaveform),
	);
	const systemPath = createMemo(() =>
		createWaveformPath(segmentRange(), props.systemWaveform),
	);

	let canvas: HTMLCanvasElement | undefined;

	createEffect(() => {
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const canvasWidth = Math.max(width(), 1);
		canvas.width = canvasWidth;
		const canvasHeight = canvas.height;
		ctx.clearRect(0, 0, canvasWidth, canvasHeight);

		const drawPath = (
			path: Path2D | undefined,
			color: string,
			gain?: number,
		) => {
			if (!path) return;
			const scale = gainToScale(gain);
			if (scale <= 0) return;
			ctx.save();
			ctx.translate(0, -1);
			ctx.scale(1, scale);
			ctx.translate(0, 1);
			ctx.scale(canvasWidth, canvasHeight);
			ctx.fillStyle = color;
			ctx.fill(path);
			ctx.restore();
		};

		drawPath(micPath(), "rgba(255,255,255,0.4)", project.audio.micVolumeDb);
		drawPath(systemPath(), "rgba(255,150,0,0.5)", project.audio.systemVolumeDb);
	});

	return (
		<canvas
			ref={(el) => {
				canvas = el;
			}}
			class="absolute inset-0 w-full h-full pointer-events-none"
			height={CANVAS_HEIGHT}
		/>
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

	const segments = (): Array<TimelineSegment> =>
		project.timeline?.segments ?? [{ start: 0, end: duration(), timescale: 1 }];

	const segmentOffsets = createMemo(() => {
		const segs = segments();
		const offsets: number[] = new Array(segs.length);
		let sum = 0;
		for (let idx = 0; idx < segs.length; idx++) {
			offsets[idx] = sum;
			sum += (segs[idx].end - segs[idx].start) / segs[idx].timescale;
		}
		return offsets;
	});

	const visibleSegmentIndices = createMemo(() => {
		const segs = segments();
		const offsets = segmentOffsets();
		const visible: number[] = [];
		for (let i = 0; i < segs.length; i++) {
			const seg = segs[i];
			const segStart = offsets[i];
			const segEnd = segStart + (seg.end - seg.start) / seg.timescale;
			if (isSegmentVisible(segStart, segEnd)) {
				visible.push(i);
			}
		}
		return visible;
	});

	function onHandleReleased() {
		const { transform } = editorState.timeline;

		if (transform.position + transform.zoom > totalDuration() + 4) {
			transform.updateZoom(totalDuration(), editorState.previewTime!);
		}
	}

	const hasMultipleRecordingSegments = () =>
		editorInstance.recordings.segments.length > 1;

	const split = () => editorState.timeline.interactMode === "split";

	return (
		<TrackRoot
			ref={props.ref}
			onMouseEnter={() => setEditorState("timeline", "hoveredTrack", "clip")}
			onMouseLeave={() => setEditorState("timeline", "hoveredTrack", null)}
		>
			<Index each={visibleSegmentIndices()}>
				{(segmentIndex) => {
					const i = segmentIndex;
					const segment = () => segments()[i()];
					const [startHandleDrag, setStartHandleDrag] = createSignal<null | {
						offset: number;
						initialStart: number;
					}>(null);

					const prevDuration = createMemo(() => segmentOffsets()[i()] ?? 0);

					const relativeSegment = createMemo(() => {
						const ds = startHandleDrag();
						const offset = ds?.offset ?? 0;
						const seg = segment();

						return {
							start: Math.max(prevDuration() + offset, 0),
							end:
								prevDuration() +
								(offset + (seg.end - seg.start)) / seg.timescale,
							timescale: seg.timescale,
							recordingSegment: seg.recordingSegment,
						};
					});

					const segmentX = useSegmentTranslateX(relativeSegment);
					const segmentWidth = useSegmentWidth(relativeSegment);

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
						const selection = editorState.timeline.selection;
						if (!selection || selection.type !== "clip") return false;
						const seg = segment();

						const segmentIndex = project.timeline?.segments?.findIndex(
							(s) => s.start === seg.start && s.end === seg.end,
						);

						if (segmentIndex === undefined || segmentIndex === -1) return false;

						return selection.indices.includes(segmentIndex);
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
							project.audio.systemVolumeDb <= -30
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
										<div class="w-[2px] bottom-0 -top-2 rounded-full from-red-300 to-transparent bg-gradient-to-b -translate-x-1/2" />
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
																class="-left-px absolute rounded-r-full !pl-1.5 rounded-tl-full"
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
								class={cx(
									"border transition-colors duration-200 group hover:border-gray-12",
									"bg-gradient-to-r from-[#2675DB] via-[#4FA0FF] to-[#2675DB] shadow-[inset_0_5px_10px_5px_rgba(255,255,255,0.2)]",
									isSelected()
										? "wobble-wrapper border-gray-12"
										: "border-transparent",
								)}
								innerClass="ring-blue-9"
								segment={relativeSegment()}
								onMouseDown={(e) => {
									e.stopPropagation();

									if (editorState.timeline.interactMode === "split") {
										const rect = e.currentTarget.getBoundingClientRect();
										const fraction = (e.clientX - rect.left) / rect.width;
										const seg = segment();

										const splitTime = fraction * (seg.end - seg.start);

										projectActions.splitClipSegment(prevDuration() + splitTime);
									} else {
										createRoot((dispose) => {
											createEventListener(
												e.currentTarget,
												"mouseup",
												(upEvent) => {
													dispose();

													const currentIndex = i();
													const selection = editorState.timeline.selection;
													const isMac =
														navigator.platform.toUpperCase().indexOf("MAC") >=
														0;
													const isMultiSelect = isMac
														? upEvent.metaKey
														: upEvent.ctrlKey;
													const isRangeSelect = upEvent.shiftKey;

													if (
														isRangeSelect &&
														selection &&
														selection.type === "clip"
													) {
														// Range selection: select from last selected to current
														const existingIndices = selection.indices;
														const lastIndex =
															existingIndices[existingIndices.length - 1];
														const start = Math.min(lastIndex, currentIndex);
														const end = Math.max(lastIndex, currentIndex);
														const rangeIndices = Array.from(
															{ length: end - start + 1 },
															(_, idx) => start + idx,
														);

														setEditorState("timeline", "selection", {
															type: "clip" as const,
															indices: rangeIndices,
														});
													} else if (
														isMultiSelect &&
														selection &&
														selection.type === "clip"
													) {
														// Multi-select: toggle current index
														const existingIndices = selection.indices;

														if (existingIndices.includes(currentIndex)) {
															// Remove from selection
															const newIndices = existingIndices.filter(
																(idx) => idx !== currentIndex,
															);
															if (newIndices.length > 0) {
																setEditorState("timeline", "selection", {
																	type: "clip" as const,
																	indices: newIndices,
																});
															} else {
																setEditorState("timeline", "selection", null);
															}
														} else {
															// Add to selection
															setEditorState("timeline", "selection", {
																type: "clip" as const,
																indices: [...existingIndices, currentIndex],
															});
														}
													} else {
														// Normal single selection
														setEditorState("timeline", "selection", {
															type: "clip" as const,
															indices: [currentIndex],
														});
													}

													props.handleUpdatePlayhead(upEvent);
												},
											);
										});
									}
								}}
							>
								{segment().timescale === 1 && (
									<WaveformCanvas
										micWaveform={micWaveform()}
										systemWaveform={systemAudioWaveform()}
										segment={segment()}
									/>
								)}

								<Markings segment={segment()} prevDuration={prevDuration()} />

								<SegmentHandle
									position="start"
									class="opacity-0 group-hover:opacity-100"
									onMouseDown={(downEvent) => {
										if (split()) return;
										const seg = segment();

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
											segments().reduce(
												(acc, s, segmentI) =>
													segmentI === i()
														? acc
														: acc + (s.end - s.start) / s.timescale,
												0,
											);

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
												seg.end - 1,
											);

											setStartHandleDrag({
												offset: clampedStart - initialStart,
												initialStart,
											});

											setProject(
												"timeline",
												"segments",
												i(),
												"start",
												clampedStart,
											);
										}

										const resumeHistory = projectHistory.pause();
										createRoot((dispose) => {
											onCleanup(() => {
												resumeHistory();
												console.log("NUL");
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
										const ctx = useSegmentContext();
										const seg = segment();

										return (
											<Show when={ctx.width() > 100}>
												<div class="flex flex-col gap-1 justify-center items-center text-xs whitespace-nowrap text-gray-12">
													<span class="text-white/70">
														{hasMultipleRecordingSegments()
															? `Clip ${seg.recordingSegment}`
															: "Clip"}
													</span>
													<div class="flex gap-1 items-center text-md dark:text-gray-12 text-gray-1">
														<IconLucideClock class="size-3.5" />{" "}
														{formatTime(seg.end - seg.start)}
														<Show when={seg.timescale !== 1}>
															<div class="w-0.5" />
															<IconLucideFastForward class="size-3" />
															{seg.timescale}x
														</Show>
													</div>
												</div>
											</Show>
										);
									})()}
								</SegmentContent>
								<SegmentHandle
									position="end"
									class="opacity-0 group-hover:opacity-100"
									onMouseDown={(downEvent) => {
										const seg = segment();
										const end = seg.end;

										if (split()) return;
										const maxSegmentDuration =
											editorInstance.recordings.segments[
												seg.recordingSegment ?? 0
											].display.duration;

										const availableTimelineDuration =
											editorInstance.recordingDuration -
											segments().reduce(
												(acc, s, segmentI) =>
													segmentI === i()
														? acc
														: acc + (s.end - s.start) / s.timescale,
												0,
											);

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

											setProject(
												"timeline",
												"segments",
												i(),
												"end",
												Math.max(
													Math.min(
														newEnd,
														end + availableTimelineDuration * seg.timescale,
														nextSegmentIsSameClip
															? nextSegment.start
															: maxSegmentDuration,
													),
													seg.start + 1,
												),
											);
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
											<div class="w-[2px] bottom-0 -top-2 rounded-full from-red-300 to-transparent bg-gradient-to-b -translate-x-1/2" />
											<div class="flex absolute -top-8 flex-row w-0 h-7 rounded-full">
												<CutOffsetButton
													value={value()}
													class="-right-px absolute rounded-l-full !pr-1.5 rounded-tr-full"
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

function Markings(props: { segment: TimelineSegment; prevDuration: number }) {
	const { editorState } = useEditorContext();
	const { secsPerPixel, markingResolution } = useTimelineContext();

	const markings = () => {
		const resolution = markingResolution();

		const { transform } = editorState.timeline;
		const visibleMin =
			transform.position - props.prevDuration + props.segment.start;
		const visibleMax = visibleMin + transform.zoom;

		const start = Math.floor(visibleMin / resolution);

		return Array.from(
			{ length: Math.ceil(visibleMax / resolution) - start },
			(_, i) => (start + i) * resolution,
		);
	};

	return (
		<For each={markings()}>
			{(marking) => (
				<div
					style={{
						transform: `translateX(${
							(marking - props.segment.start) / secsPerPixel()
						}px)`,
					}}
					class="absolute z-10 w-px h-12 bg-gradient-to-b from-transparent to-transparent via-white-transparent-40 dark:via-black-transparent-60"
				/>
			)}
		</For>
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
