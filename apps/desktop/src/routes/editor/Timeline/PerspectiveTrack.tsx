import {
	createEventListener,
	createEventListenerMap,
} from "@solid-primitives/event-listener";
import { cx } from "cva";
import {
	batch,
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	For,
	Show,
} from "solid-js";
import { produce } from "solid-js/store";

import { useEditorContext } from "../context";
import {
	useSegmentContext,
	useTimelineContext,
	useTrackContext,
} from "./context";
import { SegmentContent, SegmentHandle, SegmentRoot, TrackRoot } from "./Track";

export type PerspectiveSegmentDragState =
	| { type: "idle" }
	| { type: "movePending" }
	| { type: "moving" };

const PRESET_LABELS: Record<string, string> = {
	slantLeft: "Slant Left",
	slantRight: "Slant Right",
	topDown: "Top Down",
	bottomUp: "Bottom Up",
	isometricLeft: "Iso Left",
	isometricRight: "Iso Right",
	custom: "Custom",
};

const PRESET_ICONS: Record<string, string> = {
	slantLeft: "↗",
	slantRight: "↖",
	topDown: "↓",
	bottomUp: "↑",
	isometricLeft: "◇",
	isometricRight: "◆",
	custom: "✦",
};

export function PerspectiveTrack(props: {
	onDragStateChanged: (v: PerspectiveSegmentDragState) => void;
	handleUpdatePlayhead: (e: MouseEvent) => void;
}) {
	const {
		project,
		setProject,
		projectHistory,
		setEditorState,
		editorState,
		projectActions,
	} = useEditorContext();

	const { duration, secsPerPixel } = useTimelineContext();

	const [hoveringSegment, setHoveringSegment] = createSignal(false);
	const [hoveredTime, setHoveredTime] = createSignal<number>();
	const [maxAvailableDuration, setMaxAvailableDuration] =
		createSignal<number>(3);

	createEffect(() => {
		const segments = project.timeline?.perspectiveSegments;
		if (!segments || segments.length === 0) {
			setHoveringSegment(false);
		}
	});

	return (
		<TrackRoot
			onMouseEnter={() =>
				setEditorState("timeline", "hoveredTrack", "perspective")
			}
			onMouseMove={(e) => {
				if (hoveringSegment()) {
					setHoveredTime(undefined);
					return;
				}

				const bounds = e.target.getBoundingClientRect()!;

				let time =
					(e.clientX - bounds.left) * secsPerPixel() +
					editorState.timeline.transform.position;

				const segments = project.timeline?.perspectiveSegments || [];
				const nextSegmentIndex = segments.findIndex((s) => time < s.start);

				let maxDuration = 3;

				if (nextSegmentIndex !== -1) {
					const nextSegment = segments[nextSegmentIndex];
					const prevSegmentIndex = nextSegmentIndex - 1;

					if (prevSegmentIndex >= 0) {
						const prevSegment = segments[prevSegmentIndex];
						const gapStart = prevSegment.end;
						const gapEnd = nextSegment.start;
						const availableSpace = gapEnd - gapStart;

						if (availableSpace < 0.5) {
							setHoveredTime(undefined);
							return;
						}

						if (time < gapStart) {
							time = gapStart;
						}

						maxDuration = Math.min(3, gapEnd - time);
					} else {
						maxDuration = Math.min(3, nextSegment.start - time);
					}

					if (nextSegment.start - time < 0.5) {
						setHoveredTime(undefined);
						return;
					}
				} else if (segments.length > 0) {
					const lastSegment = segments[segments.length - 1];
					if (time < lastSegment.end) {
						time = lastSegment.end;
					}
					maxDuration = Math.min(3, duration() - time);
				} else {
					maxDuration = Math.min(3, duration() - time);
				}

				if (maxDuration < 0.5) {
					setHoveredTime(undefined);
					return;
				}

				setMaxAvailableDuration(maxDuration);
				setHoveredTime(Math.min(time, duration() - maxDuration));
			}}
			onMouseLeave={() => {
				setHoveredTime();
				setMaxAvailableDuration(3);
				setEditorState("timeline", "hoveredTrack", null);
			}}
			onMouseDown={(e) => {
				createRoot((dispose) => {
					createEventListener(e.currentTarget, "mouseup", (e) => {
						dispose();

						const time = hoveredTime();
						const maxDuration = maxAvailableDuration();
						if (time === undefined) return;

						e.stopPropagation();
						batch(() => {
							setProject("timeline", "perspectiveSegments", (v) => v ?? []);
							setProject(
								"timeline",
								"perspectiveSegments",
								produce((perspectiveSegments) => {
									perspectiveSegments ??= [];

									let index = perspectiveSegments.length;

									for (let i = perspectiveSegments.length - 1; i >= 0; i--) {
										if (perspectiveSegments[i].start > time) {
											index = i;
											break;
										}
									}

									perspectiveSegments.splice(index, 0, {
										start: time,
										end: time + maxDuration,
										preset: "slantLeft",
										animation: "zoomIn",
										rotationX: 15,
										rotationY: -35,
										rotationZ: 0,
										fov: 80,
										zoom: 1.0,
										cameraDistance: 40,
									});
								}),
							);
						});
					});
				});
			}}
		>
			<For
				each={project.timeline?.perspectiveSegments}
				fallback={
					<div class="text-center text-sm text-[--text-tertiary] flex flex-col justify-center items-center inset-0 w-full bg-gray-3/20 dark:bg-gray-3/10 hover:bg-gray-3/30 dark:hover:bg-gray-3/20 transition-colors rounded-xl pointer-events-none">
						<div>Click to add 3D view</div>
						<div class="text-[10px] text-[--text-tertiary]/40 mt-0.5">
							(Perspective transforms for screen recordings)
						</div>
					</div>
				}
			>
				{(segment, i) => {
					const { setTrackState } = useTrackContext();

					const perspectiveSegments = () =>
						project.timeline?.perspectiveSegments ?? [];

					function createMouseDownDrag<T>(
						setup: () => T,
						_update: (e: MouseEvent, v: T, initialMouseX: number) => void,
					) {
						return (downEvent: MouseEvent) => {
							if (editorState.timeline.interactMode !== "seek") return;

							downEvent.stopPropagation();

							const initial = setup();

							let moved = false;
							let initialMouseX: null | number = null;

							setTrackState("draggingSegment", true);

							const resumeHistory = projectHistory.pause();

							props.onDragStateChanged({ type: "movePending" });

							function finish(e: MouseEvent) {
								resumeHistory();

								const currentIndex = i();
								const selection = editorState.timeline.selection;
								const isMac =
									navigator.platform.toUpperCase().indexOf("MAC") >= 0;
								const isMultiSelect = isMac ? e.metaKey : e.ctrlKey;
								const isRangeSelect = e.shiftKey;

								if (!moved) {
									e.stopPropagation();

									if (
										isRangeSelect &&
										selection &&
										selection.type === "perspective"
									) {
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
											type: "perspective" as const,
											indices: rangeIndices,
										});
									} else if (
										isMultiSelect &&
										selection &&
										selection.type === "perspective"
									) {
										const existingIndices = selection.indices;

										if (existingIndices.includes(currentIndex)) {
											const newIndices = existingIndices.filter(
												(idx) => idx !== currentIndex,
											);
											if (newIndices.length > 0) {
												setEditorState("timeline", "selection", {
													type: "perspective" as const,
													indices: newIndices,
												});
											} else {
												setEditorState("timeline", "selection", null);
											}
										} else {
											setEditorState("timeline", "selection", {
												type: "perspective" as const,
												indices: [...existingIndices, currentIndex],
											});
										}
									} else {
										setEditorState("timeline", "selection", {
											type: "perspective" as const,
											indices: [currentIndex],
										});
									}

									props.handleUpdatePlayhead(e);
								} else {
									setEditorState("timeline", "selection", {
										type: "perspective" as const,
										indices: [currentIndex],
									});
								}
								props.onDragStateChanged({ type: "idle" });
								setTrackState("draggingSegment", false);
							}

							function update(event: MouseEvent) {
								if (Math.abs(event.clientX - downEvent.clientX) > 2) {
									if (!moved) {
										moved = true;
										initialMouseX = event.clientX;
										props.onDragStateChanged({
											type: "moving",
										});
									}
								}

								if (initialMouseX === null) return;

								_update(event, initial, initialMouseX);
							}

							createRoot((dispose) => {
								createEventListenerMap(window, {
									mousemove: (e) => {
										update(e);
									},
									mouseup: (e) => {
										update(e);
										finish(e);
										dispose();
									},
								});
							});
						};
					}

					const isSelected = createMemo(() => {
						const selection = editorState.timeline.selection;
						if (!selection || selection.type !== "perspective") return false;

						const segmentIndex =
							project.timeline?.perspectiveSegments?.findIndex(
								(s) => s.start === segment.start && s.end === segment.end,
							);

						if (segmentIndex === undefined || segmentIndex === -1) return false;

						return selection.indices.includes(segmentIndex);
					});

					return (
						<SegmentRoot
							class={cx(
								"border transition-colors duration-200 hover:border-gray-12 group",
								"bg-gradient-to-r from-[#0EA5E9] via-[#38BDF8] to-[#0EA5E9] shadow-[inset_0_8px_12px_3px_rgba(255,255,255,0.2)]",
								isSelected() ? "border-gray-12" : "border-transparent",
							)}
							innerClass="ring-blue-5"
							segment={segment}
							onMouseEnter={() => {
								setHoveringSegment(true);
							}}
							onMouseLeave={() => {
								setHoveringSegment(false);
							}}
							onMouseDown={(e) => {
								e.stopPropagation();

								if (editorState.timeline.interactMode === "split") {
									const rect = e.currentTarget.getBoundingClientRect();
									const fraction = (e.clientX - rect.left) / rect.width;

									const splitTime = fraction * (segment.end - segment.start);

									projectActions.splitPerspectiveSegment(i(), splitTime);
								}
							}}
						>
							<SegmentHandle
								position="start"
								onMouseDown={createMouseDownDrag(
									() => {
										const start = segment.start;

										let minValue = 0;

										const maxValue = segment.end - 1;

										for (
											let idx = perspectiveSegments().length - 1;
											idx >= 0;
											idx--
										) {
											const seg = perspectiveSegments()[idx]!;
											if (seg.end <= start) {
												minValue = seg.end;
												break;
											}
										}

										return { start, minValue, maxValue };
									},
									(e, value, initialMouseX) => {
										const newStart =
											value.start +
											(e.clientX - initialMouseX) * secsPerPixel();

										setProject(
											"timeline",
											"perspectiveSegments",
											i(),
											"start",
											Math.min(
												value.maxValue,
												Math.max(value.minValue, newStart),
											),
										);

										setProject(
											"timeline",
											"perspectiveSegments",
											produce((s) => {
												if (s) {
													s.sort((a, b) => a.start - b.start);
												}
											}),
										);
									},
								)}
							/>
							<SegmentContent
								class="flex justify-center items-center cursor-grab"
								onMouseDown={createMouseDownDrag(
									() => {
										const original = { ...segment };

										const prevSegment = perspectiveSegments()[i() - 1];
										const nextSegment = perspectiveSegments()[i() + 1];

										const minStart = prevSegment?.end ?? 0;
										const maxEnd = nextSegment?.start ?? duration();

										return {
											original,
											minStart,
											maxEnd,
										};
									},
									(e, value, initialMouseX) => {
										const rawDelta =
											(e.clientX - initialMouseX) * secsPerPixel();

										const newStart = value.original.start + rawDelta;
										const newEnd = value.original.end + rawDelta;

										let delta = rawDelta;

										if (newStart < value.minStart)
											delta = value.minStart - value.original.start;
										else if (newEnd > value.maxEnd)
											delta = value.maxEnd - value.original.end;

										setProject("timeline", "perspectiveSegments", i(), {
											start: value.original.start + delta,
											end: value.original.end + delta,
										});
									},
								)}
							>
								{(() => {
									const ctx = useSegmentContext();

									return (
										<Show when={ctx.width() > 60}>
											<div class="flex flex-col gap-1 justify-center items-center text-xs whitespace-nowrap text-gray-1 dark:text-gray-12 animate-in fade-in">
												<span class="opacity-70">3D View</span>
												<div class="flex gap-1 items-center text-md">
													<span class="text-sm">
														{PRESET_ICONS[segment.preset ?? "slantLeft"]}
													</span>
													{ctx.width() > 100 && (
														<span class="text-xs">
															{PRESET_LABELS[segment.preset ?? "slantLeft"]}
														</span>
													)}
												</div>
											</div>
										</Show>
									);
								})()}
							</SegmentContent>
							<SegmentHandle
								position="end"
								onMouseDown={createMouseDownDrag(
									() => {
										const end = segment.end;

										const minValue = segment.start + 1;

										let maxValue = duration();

										for (
											let idx = 0;
											idx < perspectiveSegments().length;
											idx++
										) {
											const seg = perspectiveSegments()[idx]!;
											if (seg.start > end) {
												maxValue = seg.start;
												break;
											}
										}

										return { end, minValue, maxValue };
									},
									(e, value, initialMouseX) => {
										const newEnd =
											value.end + (e.clientX - initialMouseX) * secsPerPixel();

										setProject(
											"timeline",
											"perspectiveSegments",
											i(),
											"end",
											Math.min(
												value.maxValue,
												Math.max(value.minValue, newEnd),
											),
										);

										setProject(
											"timeline",
											"perspectiveSegments",
											produce((s) => {
												if (s) {
													s.sort((a, b) => a.start - b.start);
												}
											}),
										);
									},
								)}
							/>
						</SegmentRoot>
					);
				}}
			</For>
			<Show
				when={!useTrackContext().trackState.draggingSegment && hoveredTime()}
			>
				{(time) => (
					<SegmentRoot
						class="pointer-events-none"
						innerClass="ring-blue-300"
						segment={{
							start: time(),
							end: time() + maxAvailableDuration(),
						}}
					>
						<SegmentContent class="bg-gradient-to-r hover:border duration-200 hover:border-gray-500 from-[#0EA5E9] via-[#38BDF8] to-[#0EA5E9] transition-colors group shadow-[inset_0_8px_12px_3px_rgba(255,255,255,0.2)]">
							<p class="w-full text-center text-gray-1 dark:text-gray-12 text-md text-primary">
								+
							</p>
						</SegmentContent>
					</SegmentRoot>
				)}
			</Show>
		</TrackRoot>
	);
}
