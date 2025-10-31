import { createEventListenerMap } from "@solid-primitives/event-listener";
import { cx } from "cva";
import {
	type ComponentProps,
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	For,
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

function formatTime(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m ${Math.floor(seconds)}s`;
	} else if (minutes > 0) {
		return `${minutes}m ${Math.floor(seconds)}s`;
	} else if (seconds >= 1) {
		return `${Math.floor(seconds)}s`;
	} else {
		// Show one decimal place for sub-second values
		return `${seconds.toFixed(1)}s`;
	}
}

function WaveformCanvas(props: {
	systemWaveform?: number[];
	micWaveform?: number[];
	segment: { start: number; end: number };
	secsPerPixel: number;
}) {
	const { project } = useEditorContext();

	let canvas: HTMLCanvasElement | undefined;
	const { width } = useSegmentContext();
	const { secsPerPixel } = useTimelineContext();

	const render = (
		ctx: CanvasRenderingContext2D,
		h: number,
		waveform: number[],
		color: string,
		gain = 0,
	) => {
		const maxAmplitude = h;

		// yellow please
		ctx.fillStyle = color;
		ctx.beginPath();

		const step = 0.05 / secsPerPixel();

		ctx.moveTo(0, h);

		const norm = (w: number) => {
			const ww = Number.isFinite(w) ? w : -60;
			return 1.0 - Math.max(ww + gain, -60) / -60;
		};

		for (
			let segmentTime = props.segment.start;
			segmentTime <= props.segment.end + 0.1;
			segmentTime += 0.1
		) {
			const index = Math.floor(segmentTime * 10);
			const xTime = index / 10;

			const currentDb =
				typeof waveform[index] === "number" ? waveform[index] : -60;
			const amplitude = norm(currentDb) * maxAmplitude;

			const x = (xTime - props.segment.start) / secsPerPixel();
			const y = h - amplitude;

			const prevX = (xTime - 0.1 - props.segment.start) / secsPerPixel();
			const prevDb =
				typeof waveform[index - 1] === "number" ? waveform[index - 1] : -60;
			const prevAmplitude = norm(prevDb) * maxAmplitude;
			const prevY = h - prevAmplitude;

			const cpX1 = prevX + step / 2;
			const cpX2 = x - step / 2;

			ctx.bezierCurveTo(cpX1, prevY, cpX2, y, x, y);
		}

		ctx.lineTo(
			(props.segment.end + 0.3 - props.segment.start) / secsPerPixel(),
			h,
		);

		ctx.closePath();
		ctx.fill();
	};

	function renderWaveforms() {
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const w = width();
		if (w <= 0) return;

		const h = canvas.height;
		canvas.width = w;
		ctx.clearRect(0, 0, w, h);

		if (props.micWaveform)
			render(
				ctx,
				h,
				props.micWaveform,
				"rgba(255,255,255,0.4)",
				project.audio.micVolumeDb,
			);

		if (props.systemWaveform)
			render(
				ctx,
				h,
				props.systemWaveform,
				"rgba(255,150,0,0.5)",
				project.audio.systemVolumeDb,
			);
	}

	createEffect(() => {
		renderWaveforms();
	});

	return (
		<canvas
			ref={(el) => {
				canvas = el;
				renderWaveforms();
			}}
			class="absolute inset-0 w-full h-full pointer-events-none"
			height={52}
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

	const { secsPerPixel, duration } = useTimelineContext();

	const segments = (): Array<TimelineSegment> =>
		project.timeline?.segments ?? [{ start: 0, end: duration(), timescale: 1 }];

	function onHandleReleased() {
		const { transform } = editorState.timeline;

		if (transform.position + transform.zoom > totalDuration() + 4) {
			transform.updateZoom(totalDuration(), editorState.previewTime!);
		}
	}

	const hasMultipleRecordingSegments = () =>
		editorInstance.recordings.segments.length > 1;

	const split = () => editorState.timeline.interactMode === "split";

	// Drag and drop state for reordering clips
	const [dragState, setDragState] = createSignal<{
		draggedIndex: number;
		hoverIndex: number | null;
		startX: number;
		startY: number;
		currentX: number;
		currentY: number;
		offsetX: number;
		offsetY: number;
		width: number;
		height: number;
	} | null>(null);

	// Function to reorder segments
	const reorderSegments = (fromIndex: number, toIndex: number) => {
		if (fromIndex === toIndex) return;

		setProject(
			"timeline",
			"segments",
			produce((segments) => {
				const [removed] = segments.splice(fromIndex, 1);
				segments.splice(toIndex, 0, removed);
			}),
		);
	};

	// Get visual order of segments accounting for drag state
	const getVisualOrder = (index: number) => {
		const drag = dragState();
		if (!drag) return index;

		const { draggedIndex, hoverIndex } = drag;

		if (hoverIndex === null) return index;

		if (index === draggedIndex) {
			return hoverIndex;
		}

		if (draggedIndex < hoverIndex) {
			if (index > draggedIndex && index <= hoverIndex) {
				return index - 1;
			}
		} else {
			if (index >= hoverIndex && index < draggedIndex) {
				return index + 1;
			}
		}

		return index;
	};

	return (
		<TrackRoot
			ref={props.ref}
			class={dragState() ? "cursor-grabbing" : ""}
			onMouseEnter={() => setEditorState("timeline", "hoveredTrack", "clip")}
			onMouseLeave={() => setEditorState("timeline", "hoveredTrack", null)}
		>
			<For each={segments()}>
				{(segment, i) => {
					const prefixOffsets = createMemo(() => {
						const segs = segments();
						const out: number[] = new Array(segs.length);
						let sum = 0;
						for (let k = 0; k < segs.length; k++) {
							out[k] = sum;
							sum += (segs[k].end - segs[k].start) / segs[k].timescale;
						}
						return out;
					});
					const prevDuration = createMemo(() => prefixOffsets()[i()] ?? 0);

					const relativeSegment = createMemo(() => {
						const duration = (segment.end - segment.start) / segment.timescale;

						return {
							start: prevDuration(),
							end: prevDuration() + duration,
							timescale: segment.timescale,
							recordingSegment: segment.recordingSegment,
						};
					});

					const segmentX = useSegmentTranslateX(relativeSegment);
					const segmentWidth = useSegmentWidth(relativeSegment);

					const segmentRecording = (s = i()) =>
						editorInstance.recordings.segments[
							segments()[s].recordingSegment ?? 0
						];

					const marker = useSectionMarker(segments, i, "left");

					const endMarker = useSectionMarker(segments, i, "right");

					const isSelected = createMemo(() => {
						const selection = editorState.timeline.selection;
						if (!selection || selection.type !== "clip") return false;

						const segmentIndex = project.timeline?.segments?.findIndex(
							(s) => s.start === segment.start && s.end === segment.end,
						);

						if (segmentIndex === undefined || segmentIndex === -1) return false;

						return selection.indices.includes(segmentIndex);
					});

					const isDragging = createMemo(() => {
						const drag = dragState();
						return drag && drag.draggedIndex === i();
					});
					const isHovered = createMemo(() => {
						const drag = dragState();
						return drag && drag.hoverIndex === i();
					});
					const visualOrder = createMemo(() => getVisualOrder(i()));

					// Handle drag start
					const startDrag = (e: MouseEvent, element: HTMLElement) => {
						if (split()) return false;
						if (segments().length <= 1) return false; // Can't reorder a single clip
						if (e.shiftKey || e.metaKey || e.ctrlKey) return false; // Don't drag during selection

						try {
							const rect = element.getBoundingClientRect();
							const currentIndex = i();
							const newDragState = {
								draggedIndex: currentIndex,
								hoverIndex: null,
								startX: e.clientX,
								startY: e.clientY,
								currentX: e.clientX,
								currentY: e.clientY,
								offsetX: e.clientX - rect.left,
								offsetY: e.clientY - rect.top,
								width: rect.width,
								height: rect.height,
							};

							setDragState(newDragState);
							return true;
						} catch (error) {
							console.error("Error starting drag:", error);
							return false;
						}
					};

					const micWaveform = () => {
						if (project.audio.micVolumeDb && project.audio.micVolumeDb < -30)
							return;

						const idx = segment.recordingSegment ?? i();
						return micWaveforms()?.[idx] ?? [];
					};

					const systemAudioWaveform = () => {
						if (
							project.audio.systemVolumeDb &&
							project.audio.systemVolumeDb <= -30
						)
							return;

						const idx = segment.recordingSegment ?? i();
						return systemAudioWaveforms()?.[idx] ?? [];
					};

					return (
						<>
							<Show when={marker()}>
								{(markerAccessor) => (
									<div
										class="absolute w-0 z-10 h-full *:absolute"
										style={{
											transform: `translateX(${segmentX()}px)`,
										}}
									>
										<div class="w-[2px] bottom-0 -top-2 rounded-full from-red-300 to-transparent bg-gradient-to-b -translate-x-1/2" />
										<Switch>
											<Match when={markerAccessor()?.type === "single"}>
												{(() => {
													const timeValue = createMemo(() => {
														const m = markerAccessor();
														if (
															m?.type === "single" &&
															m.value.type === "time"
														) {
															return m.value.time;
														}
														return 0;
													});

													return (
														<div class="overflow-hidden -top-8 z-10 h-7 rounded-full -translate-x-1/2">
															<CutOffsetButton
																value={timeValue()}
																onClick={() => {
																	const currentIdx = i();
																	const segs = segments();
																	const prevSeg = segs[currentIdx - 1];
																	const currentSeg = segs[currentIdx];

																	// Check if clips are from same recording and in chronological order
																	const isSameRecording =
																		prevSeg?.recordingSegment ===
																		currentSeg.recordingSegment;
																	const isChronological =
																		prevSeg && prevSeg.end <= currentSeg.start;

																	if (isSameRecording && isChronological) {
																		// Only allow merging if clips are in chronological order
																		const m = markerAccessor();
																		setProject(
																			"timeline",
																			"segments",
																			produce((s) => {
																				if (
																					m?.type === "single" &&
																					m.value.type === "reset"
																				) {
																					s[currentIdx - 1].end =
																						s[currentIdx].end;
																					s.splice(currentIdx, 1);
																				} else {
																					s[currentIdx - 1].end =
																						s[currentIdx].start;
																				}
																			}),
																		);
																	}
																}}
															/>
														</div>
													);
												})()}
											</Match>
											<Match
												when={
													markerAccessor()?.type === "dual" &&
													(markerAccessor() as any)?.right
												}
											>
												{(() => {
													const timeVal = createMemo(() => {
														const m = markerAccessor();
														if (
															m?.type === "dual" &&
															m.right?.type === "time"
														) {
															return m.right.time;
														}
														return 0;
													});

													const currentIdx = i();
													const wouldOverlap = createMemo(() => {
														const segs = segments();
														const currentSeg = segs[currentIdx];
														const targetStart = Math.max(
															0,
															currentSeg.start - timeVal(),
														);

														// Check if extending by marker value would overlap with other clips
														return segs.some(
															(seg, idx) =>
																idx !== currentIdx &&
																seg.recordingSegment ===
																	currentSeg.recordingSegment &&
																seg.start < currentSeg.end &&
																seg.end > targetStart,
														);
													});

													return (
														<div class="flex absolute -top-8 flex-row w-0 h-7 rounded-full">
															<CutOffsetButton
																value={timeVal()}
																class="-left-px absolute rounded-r-full !pl-1.5 rounded-tl-full"
																onClick={() => {
																	if (wouldOverlap()) return;
																	const currentSeg = segments()[i()];
																	const newStart = Math.max(
																		0,
																		currentSeg.start - timeVal(),
																	);
																	setProject(
																		"timeline",
																		"segments",
																		i(),
																		"start",
																		newStart,
																	);
																}}
															/>
														</div>
													);
												})()}
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
									isDragging() && "opacity-20 pointer-events-none",
									isHovered() &&
										!isDragging() &&
										"ring-4 ring-yellow-500/60 scale-[1.02]",
									dragState() &&
										!isDragging() &&
										segments().length > 1 &&
										"cursor-copy",
								)}
								style={{
									transition: isDragging()
										? "none"
										: "all 200ms cubic-bezier(0.4, 0, 0.2, 1)",
									order: `${visualOrder()}`,
								}}
								innerClass="ring-blue-9"
								segment={relativeSegment()}
								onMouseEnter={() => {
									try {
										const drag = dragState();
										if (drag && drag.draggedIndex !== i()) {
											setDragState({
												...drag,
												hoverIndex: i(),
											});
										}
									} catch (error) {
										console.error("Error in onMouseEnter:", error);
									}
								}}
								onMouseDown={(e) => {
									e.stopPropagation();

									if (editorState.timeline.interactMode === "split") {
										const rect = e.currentTarget.getBoundingClientRect();
										const fraction = (e.clientX - rect.left) / rect.width;

										const splitTime = fraction * (segment.end - segment.start);

										projectActions.splitClipSegment(prevDuration() + splitTime);
									} else {
										let hasMoved = false;
										let dragStarted = false;
										const startX = e.clientX;
										const startY = e.clientY;

										createRoot((dispose) => {
											const handleMouseMove = (moveEvent: MouseEvent) => {
												try {
													const deltaX = Math.abs(moveEvent.clientX - startX);
													const deltaY = Math.abs(moveEvent.clientY - startY);

													if (!dragStarted && (deltaX > 5 || deltaY > 5)) {
														dragStarted = startDrag(moveEvent, e.currentTarget);
														hasMoved = true;
													}

													if (dragStarted) {
														setDragState((prev) => {
															if (!prev) return null;
															return {
																...prev,
																currentX: moveEvent.clientX,
																currentY: moveEvent.clientY,
															};
														});
													}
												} catch (error) {
													console.error("Error in handleMouseMove:", error);
												}
											};

											const handleMouseUp = (upEvent: MouseEvent) => {
												dispose();

												if (dragStarted) {
													const drag = dragState();
													if (drag && drag.hoverIndex !== null) {
														reorderSegments(drag.draggedIndex, drag.hoverIndex);
													}
													setDragState(null);
												} else if (!hasMoved) {
													// Handle selection only if there was no drag
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
												}
											};

											createEventListenerMap(window, {
												mousemove: handleMouseMove,
												mouseup: handleMouseUp,
												blur: () => {
													dispose();
													setDragState(null);
												},
											});
										});
									}
								}}
							>
								<WaveformCanvas
									micWaveform={micWaveform()}
									systemWaveform={systemAudioWaveform()}
									segment={segment}
									secsPerPixel={secsPerPixel()}
								/>

								<Markings segment={segment} prevDuration={prevDuration()} />

								<SegmentHandle
									position="start"
									class="opacity-0 group-hover:opacity-100"
									onMouseDown={(downEvent) => {
										downEvent.stopPropagation();
										if (split()) return;

										const initialStart = segment.start;

										const maxSegmentDuration =
											editorInstance.recordings.segments[
												segment.recordingSegment ?? 0
											].display.duration;

										const availableTimelineDuration =
											editorInstance.recordingDuration -
											segments().reduce(
												(acc, segment, segmentI) =>
													segmentI === i()
														? acc
														: acc +
															(segment.end - segment.start) / segment.timescale,
												0,
											);

										const maxDuration = Math.min(
											maxSegmentDuration,
											availableTimelineDuration,
										);

										const prevSegment = segments()[i() - 1];
										const prevSegmentIsSameClip =
											prevSegment?.recordingSegment !== undefined
												? prevSegment.recordingSegment ===
													segment.recordingSegment
												: false;

										// Check if prev segment is chronologically before current (not reordered)
										const prevSegmentIsChronological =
											prevSegmentIsSameClip && prevSegment.end <= segment.start;

										// Check if other clips from same recording exist (prevents extending beyond split boundaries)
										const hasOtherClipsFromSameRecording = segments().some(
											(seg, idx) =>
												idx !== i() &&
												seg.recordingSegment === segment.recordingSegment,
										);

										function update(event: MouseEvent) {
											const delta =
												(event.clientX - downEvent.clientX) *
												secsPerPixel() *
												segment.timescale;

											const newStart = initialStart + delta;

											// Calculate minimum allowed start position
											// If other clips exist, prevent extending before original start
											const minStart = Math.max(
												prevSegmentIsChronological
													? prevSegment.end
													: hasOtherClipsFromSameRecording
														? initialStart
														: 0,
												segment.end - maxDuration,
											);

											// Calculate maximum allowed start position
											const maxStart = segment.end - 1;

											// Clamp the new start value
											const clampedStart = Math.max(
												minStart,
												Math.min(newStart, maxStart),
											);

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
												onHandleReleased();
											});

											createEventListenerMap(window, {
												mousemove: update,
												mouseup: (e) => {
													update(e);
													dispose();
												},
											});
										});
									}}
								/>
								<SegmentContent class="relative justify-center items-center">
									{(() => {
										const ctx = useSegmentContext();

										return (
											<Show when={ctx.width() > 100}>
												<div class="flex flex-col gap-1 justify-center items-center text-xs whitespace-nowrap text-gray-12">
													<span class="text-white/70">
														{hasMultipleRecordingSegments()
															? `Clip ${segment.recordingSegment}`
															: "Clip"}
													</span>
													<div class="flex gap-1 items-center text-md dark:text-gray-12 text-gray-1">
														<IconLucideClock class="size-3.5" />{" "}
														{formatTime(segment.end - segment.start)}
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
										downEvent.stopPropagation();
										const end = segment.end;
										const initialEnd = segment.end;

										if (split()) return;
										const maxSegmentDuration =
											editorInstance.recordings.segments[
												segment.recordingSegment ?? 0
											].display.duration;

										const availableTimelineDuration =
											editorInstance.recordingDuration -
											segments().reduce(
												(acc, segment, segmentI) =>
													segmentI === i()
														? acc
														: acc +
															(segment.end - segment.start) / segment.timescale,
												0,
											);

										const nextSegment = segments()[i() + 1];
										const nextSegmentIsSameClip =
											nextSegment?.recordingSegment !== undefined
												? nextSegment.recordingSegment ===
													segment.recordingSegment
												: false;

										// Check if next segment is chronologically after current (not reordered)
										const nextSegmentIsChronological =
											nextSegmentIsSameClip && nextSegment.start >= segment.end;

										// Check if other clips from same recording exist (prevents extending beyond split boundaries)
										const hasOtherClipsFromSameRecording = segments().some(
											(seg, idx) =>
												idx !== i() &&
												seg.recordingSegment === segment.recordingSegment,
										);

										function update(event: MouseEvent) {
											const delta =
												(event.clientX - downEvent.clientX) *
												secsPerPixel() *
												segment.timescale;

											const newEnd = end + delta;

											// Calculate minimum allowed end position (must be at least 1 second after start)
											const minEnd = segment.start + 1;

											// Calculate maximum allowed end position
											// If other clips exist, prevent extending beyond original end
											const maxEnd = Math.min(
												nextSegmentIsChronological
													? nextSegment.start
													: hasOtherClipsFromSameRecording
														? initialEnd
														: maxSegmentDuration, // Can't overlap next segment only if chronological
												end + availableTimelineDuration * segment.timescale, // Timeline duration constraint
											);

											// Clamp the new end value
											const clampedEnd = Math.max(
												minEnd,
												Math.min(newEnd, maxEnd),
											);

											setProject(
												"timeline",
												"segments",
												i(),
												"end",
												clampedEnd,
											);
										}

										const resumeHistory = projectHistory.pause();
										createRoot((dispose) => {
											onCleanup(() => {
												resumeHistory();
												onHandleReleased();
											});

											createEventListenerMap(window, {
												mousemove: update,
												mouseup: (e) => {
													update(e);
													dispose();
												},
											});
										});
									}}
								/>
							</SegmentRoot>
							<Show
								when={
									endMarker()?.type === "dual" && (endMarker() as any)?.left
								}
							>
								{(() => {
									const timeVal = createMemo(() => {
										const m = endMarker();
										if (m?.type === "dual" && m.left?.type === "time") {
											return m.left.time;
										}
										return 0;
									});

									const currentIdx = i();
									const wouldOverlap = createMemo(() => {
										const segs = segments();
										const currentSeg = segs[currentIdx];
										const fullDuration = segmentRecording().display.duration;
										const targetEnd = Math.min(
											fullDuration,
											currentSeg.end + timeVal(),
										);

										// Check if extending by marker value would overlap with other clips
										return segs.some(
											(seg, idx) =>
												idx !== currentIdx &&
												seg.recordingSegment === currentSeg.recordingSegment &&
												seg.start < targetEnd &&
												seg.end > currentSeg.start,
										);
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
													value={timeVal()}
													class="-right-px absolute rounded-l-full !pr-1.5 rounded-tr-full"
													onClick={() => {
														if (wouldOverlap()) return;
														const currentSeg = segments()[i()];
														const fullDuration =
															segmentRecording().display.duration;
														const newEnd = Math.min(
															fullDuration,
															currentSeg.end + timeVal(),
														);
														setProject(
															"timeline",
															"segments",
															i(),
															"end",
															newEnd,
														);
													}}
												/>
											</div>
										</div>
									);
								})()}
							</Show>
						</>
					);
				}}
			</For>

			{/* Floating dragged clip that follows the cursor */}
			{dragState() &&
				(() => {
					const drag = dragState();
					if (!drag) return null;

					const allSegments = segments();
					if (
						!allSegments ||
						drag.draggedIndex >= allSegments.length ||
						drag.draggedIndex < 0
					) {
						return null;
					}

					const draggedSegment = allSegments[drag.draggedIndex];
					if (!draggedSegment) return null;

					const styleObj = {
						left: `${drag.currentX - drag.offsetX}px`,
						top: `${drag.currentY - drag.offsetY}px`,
						width: `${drag.width}px`,
						height: `${drag.height}px`,
						transform: "rotate(-2deg) scale(1.05)",
						filter: "drop-shadow(0 20px 25px rgba(0, 0, 0, 0.3))",
						transition: "filter 150ms ease-out",
					};

					return (
						<div
							class="fixed z-[100] pointer-events-none cursor-grabbing"
							style={styleObj}
						>
							<div
								class="w-full h-full rounded-lg border-2 border-blue-400 bg-gradient-to-r from-[#2675DB] via-[#4FA0FF] to-[#2675DB] shadow-[inset_0_5px_10px_5px_rgba(255,255,255,0.2)]"
								style={{ opacity: 0.98 }}
							>
								<div class="flex absolute inset-0 flex-col gap-1 justify-center items-center text-xs whitespace-nowrap text-gray-12">
									<span class="text-white/70">
										{hasMultipleRecordingSegments()
											? `Clip ${draggedSegment.recordingSegment ?? 0}`
											: "Clip"}
									</span>
									<div class="flex gap-1 items-center text-md dark:text-gray-12 text-gray-1">
										<IconLucideClock class="size-3.5" />{" "}
										{formatTime(draggedSegment.end - draggedSegment.start) ||
											"0s"}
									</div>
								</div>
							</div>
						</div>
					);
				})()}
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
			{props.value === 0 ? (
				<IconCapScissors class="size-3.5" />
			) : (
				formatTime(Math.abs(props.value))
			)}
		</button>
	);
}

function useSectionMarker(
	segments: () => TimelineSegment[],
	i: () => number,
	position: "left" | "right",
) {
	const { editorInstance } = useEditorContext();
	return createMemo(() => {
		return getSectionMarker(
			{
				segments: segments(),
				i: i(),
				position,
			},
			editorInstance.recordings.segments,
		);
	});
}
