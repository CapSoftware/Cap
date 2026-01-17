import { createEventListenerMap } from "@solid-primitives/event-listener";
import { Menu } from "@tauri-apps/api/menu";
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
import { commands } from "~/utils/tauri";
import { useEditorContext } from "../context";
import {
	useSegmentContext,
	useTimelineContext,
	useTrackContext,
} from "./context";
import { SegmentContent, SegmentHandle, SegmentRoot, TrackRoot } from "./Track";

export type ZoomSegmentDragState =
	| { type: "idle" }
	| { type: "movePending" }
	| { type: "moving" };

const MIN_NEW_SEGMENT_PIXEL_WIDTH = 80;
const MIN_NEW_SEGMENT_SECS_WIDTH = 1;

export function ZoomTrack(props: {
	onDragStateChanged: (v: ZoomSegmentDragState) => void;
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

	const { duration, secsPerPixel, isSegmentVisible } = useTimelineContext();

	const visibleZoomIndices = createMemo(() => {
		const zoomSegments = project.timeline?.zoomSegments ?? [];
		const visible: number[] = [];
		for (let i = 0; i < zoomSegments.length; i++) {
			const seg = zoomSegments[i];
			if (isSegmentVisible(seg.start, seg.end)) {
				visible.push(i);
			}
		}
		return visible;
	});

	const [creatingSegmentViaDrag, setCreatingSegmentViaDrag] =
		createSignal(false);

	const handleGenerateZoomSegments = async () => {
		try {
			const zoomSegments = await commands.generateZoomSegmentsFromClicks();
			setProject("timeline", "zoomSegments", zoomSegments);
			if (zoomSegments.length > 0) {
				const currentSize = project.cursor?.size ?? 0;
				if (currentSize < 200) {
					setProject("cursor", "size", 200);
				}
			}
		} catch (error) {
			console.error("Failed to generate zoom segments:", error);
		}
	};

	const newSegmentMinDuration = () =>
		Math.max(
			MIN_NEW_SEGMENT_PIXEL_WIDTH * secsPerPixel(),
			MIN_NEW_SEGMENT_SECS_WIDTH,
		);

	// Returns a start and end time for a new segment that can be inserted at the
	// current previewTime, if conditions permit
	const newSegmentDetails = () => {
		if (
			creatingSegmentViaDrag() ||
			editorState.timeline.hoveredTrack !== "zoom" ||
			editorState.previewTime === null
		)
			return;

		const { previewTime } = editorState;

		const nextSegment = Array.findFirstWithIndex(
			project.timeline?.zoomSegments ?? [],
			(s) => previewTime <= s.start,
		);

		const prevSegment = Array.findLastIndex(
			project.timeline?.zoomSegments ?? [],
			(s) => previewTime >= s.start,
		).pipe(
			Option.flatMap((index) =>
				Option.fromNullable(project.timeline?.zoomSegments?.[index]).pipe(
					Option.map((segment) => [segment, index] as const),
				),
			),
		);

		// Is mouse hovering over a zoom segment
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
			onMouseEnter={() => setEditorState("timeline", "hoveredTrack", "zoom")}
			onMouseLeave={() => setEditorState("timeline", "hoveredTrack", null)}
			onContextMenu={async (e) => {
				if (!import.meta.env.DEV) return;

				e.preventDefault();
				const menu = await Menu.new({
					id: "zoom-track-options",
					items: [
						{
							id: "generateZoomSegments",
							text: "Generate zoom segments from clicks",
							action: handleGenerateZoomSegments,
						},
					],
				});
				menu.popup();
			}}
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
							setProject("timeline", "zoomSegments", (v) => v ?? []);
							setProject(
								"timeline",
								"zoomSegments",
								produce((zoomSegments) => {
									zoomSegments ??= [];

									let index = 0;

									for (let i = 0; i < zoomSegments.length; i++) {
										if (zoomSegments[i].start < baseSegment.start) {
											index = i + 1;
										}
									}

									const minEndTime = baseSegment.start + minDuration();

									zoomSegments.splice(index, 0, {
										start: baseSegment.start,
										end: Math.max(minEndTime, endTime),
										amount: 1.5,
										mode: {
											manual: {
												x: 0.5,
												y: 0.5,
											},
										},
									});

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
							"zoomSegments",
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

						// Check boundaries
						const minEndTime = baseSegment.start + minDuration();
						const maxEndTime = baseSegment.max;

						const clampedEndTime = Math.min(
							Math.max(minEndTime, newEndTime),
							maxEndTime,
						);

						if (!segmentCreated) {
							setCreatingSegmentViaDrag(true);
							// Create the segment on first movement
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
							// If no movement, create a default 1-second segment
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
				when={(project.timeline?.zoomSegments ?? []).length > 0}
				fallback={
					<div class="text-center text-sm text-[--text-tertiary] flex flex-col justify-center items-center inset-0 w-full bg-gray-3/20 dark:bg-gray-3/10 hover:bg-gray-3/30 dark:hover:bg-gray-3/20 transition-colors rounded-xl pointer-events-none">
						<div>Click to add zoom segment</div>
						<div class="text-[10px] text-[--text-tertiary]/40 mt-0.5">
							(Smoothly zoom in on important areas)
						</div>
					</div>
				}
			>
				<Index each={visibleZoomIndices()}>
					{(segmentIndex) => {
						const i = segmentIndex;
						const segment = () => (project.timeline?.zoomSegments ?? [])[i()];
						const { setTrackState } = useTrackContext();

						const zoomPercentage = () => {
							const seg = segment();
							if (!seg) return "1.0x";
							const amount = seg.amount;
							return `${amount.toFixed(1)}x`;
						};

						const zoomSegments = () => project.timeline?.zoomSegments ?? [];

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
										const segmentIndex = i();
										const isMultiSelect = e.ctrlKey || e.metaKey;
										const isRangeSelect = e.shiftKey;

										if (isRangeSelect && currentSelection?.type === "zoom") {
											// Range selection: select from last selected to current
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
												type: "zoom",
												indices: rangeIndices,
											});
										} else if (isMultiSelect) {
											// Handle multi-selection with Ctrl/Cmd+click
											if (currentSelection?.type === "zoom") {
												const baseIndices = currentSelection.indices;
												const exists = baseIndices.includes(segmentIndex);
												const newIndices = exists
													? baseIndices.filter((idx) => idx !== segmentIndex)
													: [...baseIndices, segmentIndex];

												if (newIndices.length > 0) {
													setEditorState("timeline", "selection", {
														type: "zoom",
														indices: newIndices,
													});
												} else {
													setEditorState("timeline", "selection", null);
												}
											} else {
												// Start new multi-selection
												setEditorState("timeline", "selection", {
													type: "zoom",
													indices: [segmentIndex],
												});
											}
										} else {
											// Normal single selection
											setEditorState("timeline", "selection", {
												type: "zoom",
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
							if (!selection || selection.type !== "zoom") return false;
							const seg = segment();
							if (!seg) return false;

							const segmentIndex = project.timeline?.zoomSegments?.findIndex(
								(s) => s.start === seg.start && s.end === seg.end,
							);

							if (segmentIndex === undefined || segmentIndex === -1)
								return false;

							return selection.indices.includes(segmentIndex);
						});

						return (
							<Show when={segment()}>
								{(seg) => (
									<SegmentRoot
										class={cx(
											"border duration-200 hover:border-gray-12 transition-colors group",
											"bg-gradient-to-r from-[#292929] via-[#434343] to-[#292929] shadow-[inset_0_8px_12px_3px_rgba(255,255,255,0.2)]",
											isSelected()
												? "wobble-wrapper border-gray-12"
												: "border-transparent",
										)}
										innerClass="ring-red-5"
										segment={seg()}
										onMouseDown={(e) => {
											e.stopPropagation();

											if (editorState.timeline.interactMode === "split") {
												const rect = e.currentTarget.getBoundingClientRect();
												const fraction = (e.clientX - rect.left) / rect.width;

												const splitTime = fraction * (seg().end - seg().start);

												projectActions.splitZoomSegment(i(), splitTime);
											}
										}}
									>
										<SegmentHandle
											position="start"
											onMouseDown={createMouseDownDrag(
												() => {
													const start = seg().start;

													let minValue = 0;

													const maxValue = seg().end - 1;

													for (
														let idx = zoomSegments().length - 1;
														idx >= 0;
														idx--
													) {
														const zs = zoomSegments()[idx]!;
														if (zs.end <= start) {
															minValue = zs.end;
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
														"zoomSegments",
														i(),
														"start",
														Math.min(
															value.maxValue,
															Math.max(value.minValue, newStart),
														),
													);

													setProject(
														"timeline",
														"zoomSegments",
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
													const original = { ...seg() };

													const prevSegment = zoomSegments()[i() - 1];
													const nextSegment = zoomSegments()[i() + 1];

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

													setProject("timeline", "zoomSegments", i(), {
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
																<IconLucideSearch class="size-3.5 text-white" />
															</div>
														</Match>
														<Match when={ctx.width() < 100}>
															<div class="flex gap-1 items-center text-xs whitespace-nowrap text-white">
																<IconLucideSearch class="size-3" />
																<span>{zoomPercentage()}</span>
															</div>
														</Match>
														<Match when={true}>
															<div class="flex flex-col gap-1 justify-center items-center text-xs whitespace-nowrap text-white animate-in fade-in">
																<span class="opacity-70">Zoom</span>
																<div class="flex gap-1 items-center text-md">
																	<IconLucideSearch class="size-3.5" />
																	{zoomPercentage()}
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
													const end = seg().end;

													const minValue = seg().start + 1;

													let maxValue = duration();

													for (
														let idx = 0;
														idx < zoomSegments().length;
														idx++
													) {
														const zs = zoomSegments()[idx]!;
														if (zs.start > end) {
															maxValue = zs.start;
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
														"zoomSegments",
														i(),
														"end",
														Math.min(
															value.maxValue,
															Math.max(value.minValue, newEnd),
														),
													);

													setProject(
														"timeline",
														"zoomSegments",
														produce((s) => {
															s.sort((a, b) => a.start - b.start);
														}),
													);
												},
											)}
										/>
									</SegmentRoot>
								)}
							</Show>
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
						innerClass="ring-red-300"
						segment={details()}
					>
						<SegmentContent class="bg-gradient-to-r hover:border duration-200 hover:border-gray-500 from-[#292929] via-[#434343] to-[#292929] transition-colors group shadow-[inset_0_8px_12px_3px_rgba(255,255,255,0.2)]">
							<p class="w-full text-center text-white text-md text-primary">
								+
							</p>
						</SegmentContent>
					</SegmentRoot>
				)}
			</Show>
		</TrackRoot>
	);
}
