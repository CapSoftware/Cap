import { createEventListenerMap } from "@solid-primitives/event-listener";
import { cx } from "cva";
import { Array, Option } from "effect";
import {
	batch,
	createMemo,
	createRoot,
	createSignal,
	Index,
	Match,
	Show,
	Switch,
} from "solid-js";
import { produce } from "solid-js/store";
import { useEditorContext } from "../context";
import { defaultLayout3DSegment, LAYOUT_3D_PRESETS } from "../layout3d";
import {
	useSegmentContext,
	useTimelineContext,
	useTrackContext,
} from "./context";
import { SegmentContent, SegmentHandle, SegmentRoot, TrackRoot } from "./Track";

export type Layout3DSegmentDragState =
	| { type: "idle" }
	| { type: "movePending" }
	| { type: "moving" };

const MIN_NEW_SEGMENT_PIXEL_WIDTH = 80;
const MIN_NEW_SEGMENT_SECS_WIDTH = 1;

export function Layout3DTrack(props: {
	onDragStateChanged: (v: Layout3DSegmentDragState) => void;
	handleUpdatePlayhead: (e: MouseEvent) => void;
}) {
	const {
		project,
		setProject,
		projectHistory,
		setEditorState,
		editorState,
		totalDuration,
		projectActions,
	} = useEditorContext();

	const { duration, secsPerPixel } = useTimelineContext();

	const [creatingSegmentViaDrag, setCreatingSegmentViaDrag] =
		createSignal(false);

	const newSegmentMinDuration = () =>
		Math.max(
			MIN_NEW_SEGMENT_PIXEL_WIDTH * secsPerPixel(),
			MIN_NEW_SEGMENT_SECS_WIDTH,
		);

	const newSegmentDetails = () => {
		if (
			creatingSegmentViaDrag() ||
			editorState.timeline.hoveredTrack !== "layout3d" ||
			editorState.previewTime === null
		)
			return;

		const { previewTime } = editorState;

		const nextSegment = Array.findFirstWithIndex(
			project.timeline?.layout3DSegments ?? [],
			(s) => previewTime <= s.start,
		);

		const prevSegment = Array.findLastIndex(
			project.timeline?.layout3DSegments ?? [],
			(s) => previewTime >= s.start,
		).pipe(
			Option.flatMap((index) =>
				Option.fromNullable(project.timeline?.layout3DSegments?.[index]).pipe(
					Option.map((segment) => [segment, index] as const),
				),
			),
		);

		if (
			Option.isSome(prevSegment) &&
			previewTime > prevSegment.value[0].start &&
			previewTime < prevSegment.value[0].end
		)
			return;

		const minDuration = newSegmentMinDuration();

		if (Option.isSome(nextSegment)) {
			if (Option.isSome(prevSegment)) {
				const availableTime =
					nextSegment.value[0].start - prevSegment.value[0].end;

				if (availableTime < minDuration) return;
			}

			if (nextSegment.value[0].start - previewTime < 1)
				return {
					index: nextSegment.value[1],
					start: nextSegment.value[0].start - minDuration,
					end: nextSegment.value[0].start,
					max: nextSegment.value[0].start,
				};
		}

		return {
			index: nextSegment.pipe(Option.map(([_, i]) => i)),
			start: previewTime,
			end: previewTime + minDuration,
			max: nextSegment.pipe(
				Option.map(([s]) => s.start),
				Option.getOrElse(() => totalDuration()),
			),
		};
	};

	return (
		<TrackRoot
			onMouseEnter={() =>
				setEditorState("timeline", "hoveredTrack", "layout3d")
			}
			onMouseLeave={() => setEditorState("timeline", "hoveredTrack", null)}
			onMouseDown={(e) => {
				if (e.button !== 0) return;

				const baseSegment = newSegmentDetails();
				if (!baseSegment) return;

				createRoot((dispose) => {
					let segmentCreated = false;
					let createdSegmentIndex = -1;
					const initialMouseX = e.clientX;
					const initialEndTime = baseSegment.end;

					const minDuration = newSegmentMinDuration;

					const createSegment = (endTime: number) => {
						if (segmentCreated) return;

						batch(() => {
							setProject("timeline", "layout3DSegments", (v) => v ?? []);
							setProject(
								"timeline",
								"layout3DSegments",
								produce((segments) => {
									segments ??= [];

									let index = 0;

									for (let i = 0; i < segments.length; i++) {
										if (segments[i].start < baseSegment.start) {
											index = i + 1;
										}
									}

									const minEndTime = baseSegment.start + minDuration();
									const newSegment = defaultLayout3DSegment(
										baseSegment.start,
										Math.max(minEndTime, endTime),
									);

									const defaultPreset = LAYOUT_3D_PRESETS.subtle;
									newSegment.rotationX = defaultPreset.rotationX;
									newSegment.rotationY = defaultPreset.rotationY;
									newSegment.depthZoom = defaultPreset.depthZoom;

									segments.splice(index, 0, newSegment);

									createdSegmentIndex = index;
								}),
							);
						});
						segmentCreated = true;
					};

					const updateSegment = (endTime: number) => {
						if (!segmentCreated || createdSegmentIndex === -1) return;

						const minEndTime = baseSegment.start + minDuration();

						setProject(
							"timeline",
							"layout3DSegments",
							createdSegmentIndex,
							"end",
							Math.max(minEndTime, endTime),
						);
					};

					const handleMouseMove = (moveEvent: MouseEvent) => {
						const deltaX = moveEvent.clientX - initialMouseX;
						const deltaTime =
							deltaX * secsPerPixel() - (baseSegment.end - baseSegment.start);
						const newEndTime = initialEndTime + deltaTime;

						const minEndTime = baseSegment.start + minDuration();
						const maxEndTime = baseSegment.max;

						const clampedEndTime = Math.min(
							Math.max(minEndTime, newEndTime),
							maxEndTime,
						);

						if (!segmentCreated) {
							setCreatingSegmentViaDrag(true);
							createSegment(clampedEndTime);
						} else {
							if (deltaTime < 0) return;
							updateSegment(clampedEndTime);
						}
					};

					const handleMouseUp = () => {
						setCreatingSegmentViaDrag(false);
						dispose();

						if (!segmentCreated) {
							createSegment(initialEndTime);
						}
					};

					createEventListenerMap(window, {
						mousemove: handleMouseMove,
						mouseup: handleMouseUp,
					});
				});
			}}
		>
			<Show
				when={project.timeline?.layout3DSegments}
				fallback={
					<div class="text-center text-sm text-[--text-tertiary] flex flex-col justify-center items-center inset-0 w-full bg-gray-3/20 dark:bg-gray-3/10 hover:bg-gray-3/30 dark:hover:bg-gray-3/20 transition-colors rounded-xl pointer-events-none">
						<div>Click to add 3D layout segment</div>
						<div class="text-[10px] text-[--text-tertiary]/40 mt-0.5">
							(Cinematic perspective effects)
						</div>
					</div>
				}
			>
				<Index each={project.timeline?.layout3DSegments}>
					{(segment, i) => {
						const { setTrackState } = useTrackContext();

						const presetLabel = () => {
							const s = segment();
							for (const [key, preset] of Object.entries(LAYOUT_3D_PRESETS)) {
								if (
									Math.abs(s.rotationX - preset.rotationX) < 0.1 &&
									Math.abs(s.rotationY - preset.rotationY) < 0.1 &&
									Math.abs(s.depthZoom - preset.depthZoom) < 0.01
								) {
									return preset.label;
								}
							}
							return `${s.rotationX.toFixed(0)}° / ${s.rotationY.toFixed(0)}°`;
						};

						const layout3DSegments = () =>
							project.timeline?.layout3DSegments ?? [];

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

										const currentSelection = editorState.timeline.selection;
										const segmentIndex = i;
										const isMultiSelect = e.ctrlKey || e.metaKey;
										const isRangeSelect = e.shiftKey;

										if (
											isRangeSelect &&
											currentSelection?.type === "layout3d"
										) {
											const existingIndices = currentSelection.indices;
											const lastIndex =
												existingIndices[existingIndices.length - 1];
											const start = Math.min(lastIndex, segmentIndex);
											const end = Math.max(lastIndex, segmentIndex);
											const rangeIndices: number[] = [];
											for (let idx = start; idx <= end; idx++) {
												rangeIndices.push(idx);
											}

											setEditorState("timeline", "selection", {
												type: "layout3d",
												indices: rangeIndices,
											});
										} else if (isMultiSelect) {
											if (currentSelection?.type === "layout3d") {
												const baseIndices = currentSelection.indices;
												const exists = baseIndices.includes(segmentIndex);
												const newIndices = exists
													? baseIndices.filter((idx) => idx !== segmentIndex)
													: [...baseIndices, segmentIndex];

												if (newIndices.length > 0) {
													setEditorState("timeline", "selection", {
														type: "layout3d",
														indices: newIndices,
													});
												} else {
													setEditorState("timeline", "selection", null);
												}
											} else {
												setEditorState("timeline", "selection", {
													type: "layout3d",
													indices: [segmentIndex],
												});
											}
										} else {
											setEditorState("timeline", "selection", {
												type: "layout3d",
												indices: [segmentIndex],
											});
										}
										props.handleUpdatePlayhead(e);
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
							if (!selection || selection.type !== "layout3d") return false;

							const segmentIndex =
								project.timeline?.layout3DSegments?.findIndex(
									(s) => s.start === segment().start && s.end === segment().end,
								);

							if (segmentIndex === undefined || segmentIndex === -1)
								return false;

							return selection.indices.includes(segmentIndex);
						});

						return (
							<SegmentRoot
								class={cx(
									"border duration-200 hover:border-blue-400 transition-colors group",
									"bg-gradient-to-r from-[#1a2a4a] via-[#2a3a5a] to-[#1a2a4a] shadow-[inset_0_8px_12px_3px_rgba(100,149,237,0.15)]",
									isSelected() ? "border-blue-400" : "border-transparent",
								)}
								innerClass="ring-blue-5"
								segment={segment()}
								onMouseDown={(e) => {
									e.stopPropagation();

									if (editorState.timeline.interactMode === "split") {
										const rect = e.currentTarget.getBoundingClientRect();
										const fraction = (e.clientX - rect.left) / rect.width;

										const splitTime =
											fraction * (segment().end - segment().start);

										projectActions.splitLayout3DSegment(i, splitTime);
									}
								}}
							>
								<SegmentHandle
									position="start"
									onMouseDown={createMouseDownDrag(
										() => {
											const start = segment().start;

											let minValue = 0;

											const maxValue = segment().end - 1;

											for (let j = layout3DSegments().length - 1; j >= 0; j--) {
												const seg = layout3DSegments()[j]!;
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
												"layout3DSegments",
												i,
												"start",
												Math.min(
													value.maxValue,
													Math.max(value.minValue, newStart),
												),
											);

											setProject(
												"timeline",
												"layout3DSegments",
												produce((s) => {
													s.sort((a, b) => a.start - b.start);
												}),
											);
										},
									)}
								/>
								<SegmentContent
									class="flex justify-center items-center cursor-grab"
									onMouseDown={createMouseDownDrag(
										() => {
											const original = { ...segment() };

											const prevSegment = layout3DSegments()[i - 1];
											const nextSegment = layout3DSegments()[i + 1];

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

											setProject("timeline", "layout3DSegments", i, {
												start: value.original.start + delta,
												end: value.original.end + delta,
											});
										},
									)}
								>
									{(() => {
										const ctx = useSegmentContext();

										return (
											<Switch>
												<Match when={ctx.width() < 40}>
													<div class="flex justify-center items-center">
														<IconLucideLayout class="size-3.5 text-blue-200" />
													</div>
												</Match>
												<Match when={ctx.width() < 100}>
													<div class="flex gap-1 items-center text-xs whitespace-nowrap text-blue-200">
														<IconLucideLayout class="size-3" />
														<span>{presetLabel()}</span>
													</div>
												</Match>
												<Match when={true}>
													<div class="flex flex-col gap-1 justify-center items-center text-xs whitespace-nowrap text-blue-200 animate-in fade-in">
														<span class="opacity-70">3D Layout</span>
														<div class="flex gap-1 items-center text-md">
															<IconLucideLayout class="size-3.5" />
															{presetLabel()}
														</div>
													</div>
												</Match>
											</Switch>
										);
									})()}
								</SegmentContent>
								<SegmentHandle
									position="end"
									onMouseDown={createMouseDownDrag(
										() => {
											const end = segment().end;

											const minValue = segment().start + 1;

											let maxValue = duration();

											for (let j = 0; j < layout3DSegments().length; j++) {
												const seg = layout3DSegments()[j]!;
												if (seg.start > end) {
													maxValue = seg.start;
													break;
												}
											}

											return { end, minValue, maxValue };
										},
										(e, value, initialMouseX) => {
											const newEnd =
												value.end +
												(e.clientX - initialMouseX) * secsPerPixel();

											setProject(
												"timeline",
												"layout3DSegments",
												i,
												"end",
												Math.min(
													value.maxValue,
													Math.max(value.minValue, newEnd),
												),
											);

											setProject(
												"timeline",
												"layout3DSegments",
												produce((s) => {
													s.sort((a, b) => a.start - b.start);
												}),
											);
										},
									)}
								/>
							</SegmentRoot>
						);
					}}
				</Index>
			</Show>
			<Show
				when={
					!useTrackContext().trackState.draggingSegment && newSegmentDetails()
				}
			>
				{(details) => (
					<SegmentRoot
						class="pointer-events-none"
						innerClass="ring-blue-300"
						segment={details()}
					>
						<SegmentContent class="bg-gradient-to-r hover:border duration-200 hover:border-blue-400 from-[#1a2a4a] via-[#2a3a5a] to-[#1a2a4a] transition-colors group shadow-[inset_0_8px_12px_3px_rgba(100,149,237,0.15)]">
							<p class="w-full text-center text-blue-200 text-md text-primary">
								+
							</p>
						</SegmentContent>
					</SegmentRoot>
				)}
			</Show>
		</TrackRoot>
	);
}
