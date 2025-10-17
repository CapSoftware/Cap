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

export type SceneSegmentDragState =
	| { type: "idle" }
	| { type: "movePending" }
	| { type: "moving" };

export function SceneTrack(props: {
	onDragStateChanged: (v: SceneSegmentDragState) => void;
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

	// When we delete a segment that's being hovered, the onMouseLeave never fires
	// because the element gets removed from the DOM. This leaves hoveringSegment stuck
	// as true, which blocks the onMouseMove from setting hoveredTime, preventing
	// users from creating new segments. This effect ensures we reset the hover state
	// when all segments are deleted.
	createEffect(() => {
		const segments = project.timeline?.sceneSegments;
		if (!segments || segments.length === 0) {
			setHoveringSegment(false);
		}
	});

	const getSceneIcon = (mode: string | undefined) => {
		switch (mode) {
			case "cameraOnly":
				return <IconLucideVideo class="size-3.5" />;
			case "hideCamera":
				return <IconLucideEyeOff class="size-3.5" />;
			default:
				return <IconLucideMonitor class="size-3.5" />;
		}
	};

	const getSceneLabel = (mode: string | undefined) => {
		switch (mode) {
			case "cameraOnly":
				return "Camera Only";
			case "hideCamera":
				return "Hide Camera";
			default:
				return "Default";
		}
	};

	return (
		<TrackRoot
			onMouseEnter={() => setEditorState("timeline", "hoveredTrack", "scene")}
			onMouseMove={(e) => {
				if (hoveringSegment()) {
					setHoveredTime(undefined);
					return;
				}

				const bounds = e.target.getBoundingClientRect()!;

				let time =
					(e.clientX - bounds.left) * secsPerPixel() +
					editorState.timeline.transform.position;

				const segments = project.timeline?.sceneSegments || [];
				const nextSegmentIndex = segments.findIndex((s) => time < s.start);

				let maxDuration = 3; // Default duration

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
						// No previous segment, only next segment
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
							setProject("timeline", "sceneSegments", (v) => v ?? []);
							setProject(
								"timeline",
								"sceneSegments",
								produce((sceneSegments) => {
									sceneSegments ??= [];

									let index = sceneSegments.length;

									for (let i = sceneSegments.length - 1; i >= 0; i--) {
										if (sceneSegments[i].start > time) {
											index = i;
											break;
										}
									}

									sceneSegments.splice(index, 0, {
										start: time,
										end: time + maxDuration,
										mode: "cameraOnly",
									});
								}),
							);
						});
					});
				});
			}}
		>
			<For
				each={project.timeline?.sceneSegments}
				fallback={
					<div class="text-center text-sm text-[--text-tertiary] flex flex-col justify-center items-center inset-0 w-full bg-gray-3/20 dark:bg-gray-3/10 hover:bg-gray-3/30 dark:hover:bg-gray-3/20 transition-colors rounded-xl pointer-events-none">
						<div>Click to add scene segment</div>
						<div class="text-[10px] text-[--text-tertiary]/40 mt-0.5">
							(Make the camera full screen, or hide it)
						</div>
					</div>
				}
			>
				{(segment, i) => {
					const { setTrackState } = useTrackContext();

					const sceneSegments = () => project.timeline?.sceneSegments ?? [];

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
								if (!moved) {
									e.stopPropagation();
									setEditorState("timeline", "selection", {
										type: "scene",
										index: i(),
									});
									props.handleUpdatePlayhead(e);
								} else {
									setEditorState("timeline", "selection", {
										type: "scene",
										index: i(),
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
						if (!selection || selection.type !== "scene") return false;

						const segmentIndex = project.timeline?.sceneSegments?.findIndex(
							(s) => s.start === segment.start && s.end === segment.end,
						);

						return segmentIndex === selection.index;
					});

					return (
						<SegmentRoot
							class={cx(
								"border transition-colors duration-200 hover:border-gray-12 group",
								`bg-gradient-to-r from-[#5C1BC4] via-[#975CFA] to-[#5C1BC4] shadow-[inset_0_8px_12px_3px_rgba(255,255,255,0.2)]`,
								isSelected()
									? "wobble-wrapper border-gray-12"
									: "border-transparent",
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

									projectActions.splitSceneSegment(i(), splitTime);
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

										for (let i = sceneSegments().length - 1; i >= 0; i--) {
											const segment = sceneSegments()[i]!;
											if (segment.end <= start) {
												minValue = segment.end;
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
											"sceneSegments",
											i(),
											"start",
											Math.min(
												value.maxValue,
												Math.max(value.minValue, newStart),
											),
										);

										setProject(
											"timeline",
											"sceneSegments",
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

										const prevSegment = sceneSegments()[i() - 1];
										const nextSegment = sceneSegments()[i() + 1];

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

										setProject("timeline", "sceneSegments", i(), {
											start: value.original.start + delta,
											end: value.original.end + delta,
										});
									},
								)}
							>
								{(() => {
									const ctx = useSegmentContext();

									return (
										<Show when={ctx.width() > 80}>
											<div class="flex flex-col gap-1 justify-center items-center text-xs whitespace-nowrap text-gray-1 dark:text-gray-12 animate-in fade-in">
												<span class="opacity-70">Scene</span>
												<div class="flex gap-1 items-center text-md">
													{getSceneIcon(segment.mode)}
													{ctx.width() > 120 && (
														<span class="text-xs">
															{getSceneLabel(segment.mode)}
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

										for (let i = 0; i < sceneSegments().length; i++) {
											const segment = sceneSegments()[i]!;
											if (segment.start > end) {
												maxValue = segment.start;
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
											"sceneSegments",
											i(),
											"end",
											Math.min(
												value.maxValue,
												Math.max(value.minValue, newEnd),
											),
										);

										setProject(
											"timeline",
											"sceneSegments",
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
						<SegmentContent class="bg-gradient-to-r hover:border duration-200 hover:border-gray-500 from-[#5C1BC4] via-[#975CFA] to-[#5C1BC4] transition-colors group shadow-[inset_0_8px_12px_3px_rgba(255,255,255,0.2)]">
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
