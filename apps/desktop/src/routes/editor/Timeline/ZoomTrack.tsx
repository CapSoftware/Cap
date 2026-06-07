import { Button } from "@cap/ui-solid";
import { createEventListenerMap } from "@solid-primitives/event-listener";
import { Menu } from "@tauri-apps/api/menu";
import { cx } from "cva";
import { Array, Option } from "effect";
import {
	batch,
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	Index,
	Match,
	Show,
	Switch,
	For,
} from "solid-js";
import { produce } from "solid-js/store";
import { commands } from "~/utils/tauri";
import { useEditorContext } from "../context";
import {
	useSegmentContext,
	useTimelineContext,
	useTrackContext,
} from "./context";
import {
	SegmentContent,
	SegmentHandle,
	SegmentRoot,
	TrackRoot,
	useSetPreviewTime,
} from "./Track";

export type ZoomSegmentDragState =
	| { type: "idle" }
	| { type: "movePending" }
	| { type: "moving" };

const MIN_ZOOM_SEGMENT_PIXEL_WIDTH = 40;
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
		meta,
	} = useEditorContext();

	const { duration, secsPerPixel } = useTimelineContext();
	const setPreviewTime = useSetPreviewTime();

	const [creatingSegmentViaDrag, setCreatingSegmentViaDrag] =
		createSignal(false);
	const [isGeneratingAutoZoom, setIsGeneratingAutoZoom] = createSignal(false);
	const [isHoveringGenerateZoomButton, setIsHoveringGenerateZoomButton] =
		createSignal(false);
	const [
		sessionDismissedGenerateZoomPrompt,
		setSessionDismissedGenerateZoomPrompt,
	] = createSignal(false);

	const hasZoomSegments = () =>
		(project.timeline?.zoomSegments?.length ?? 0) > 0;
	const selectedZoomIndices = createMemo(() => {
		const selection = editorState.timeline.selection;
		if (!selection || selection.type !== "zoom") return null;
		return new Set(selection.indices);
	});

	const hasRecordedCursorData = () => meta().hasRecordedCursorData;

	createEffect(() => {
		if (hasZoomSegments() || sessionDismissedGenerateZoomPrompt()) {
			setIsHoveringGenerateZoomButton(false);
		}
	});

	const handleGenerateZoomSegments = async () => {
		setIsGeneratingAutoZoom(true);
		try {
			const zoomSegments = await commands.generateZoomSegmentsFromClicks();
			setProject("timeline", "zoomSegments", zoomSegments);
		} catch (error) {
			console.error("Failed to generate zoom segments:", error);
		} finally {
			setIsGeneratingAutoZoom(false);
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
										mode: "auto",
									});

									createdSegmentIndex = index;
								}),
							);
							setEditorState("timeline", "selection", {
								type: "zoom",
								indices: [createdSegmentIndex],
							});
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
				when={hasZoomSegments()}
				fallback={
					<div class="relative z-1 isolate text-center text-sm text-(--text-tertiary) flex flex-col gap-2 justify-center items-center inset-0 w-full bg-gray-3/20 dark:bg-gray-3/10 hover:bg-gray-3/30 dark:hover:bg-gray-3/20 transition-colors rounded-xl pointer-events-auto px-2 py-1">
						<Show
							when={
								hasRecordedCursorData() && !sessionDismissedGenerateZoomPrompt()
							}
						>
							<div
								class="relative z-10 flex items-center gap-1"
								onMouseEnter={() => setIsHoveringGenerateZoomButton(true)}
								onMouseLeave={() => setIsHoveringGenerateZoomButton(false)}
								onMouseDown={(e) => e.stopPropagation()}
							>
								<Button
									variant="gray"
									size="md"
									class="shadow-md border-gray-7 dark:border-gray-8 font-medium"
									disabled={isGeneratingAutoZoom()}
									onClick={() => {
										void handleGenerateZoomSegments();
									}}
								>
									{isGeneratingAutoZoom()
										? "Generating..."
										: "Click to generate zoom segments"}
								</Button>
								<button
									type="button"
									class="flex shrink-0 justify-center items-center rounded-full outline-hidden text-gray-11 hover:text-gray-12 hover:bg-gray-5 focus-visible:ring-2 focus-visible:ring-gray-8 size-8 transition-colors"
									disabled={isGeneratingAutoZoom()}
									aria-label="Dismiss for this session"
									onClick={() => setSessionDismissedGenerateZoomPrompt(true)}
								>
									<IconLucideX class="size-4" />
								</button>
							</div>
						</Show>
					</div>
				}
			>
				<Index each={project.timeline?.zoomSegments}>
					{(segment, i) => {
						const { setTrackState } = useTrackContext();

						const zoomPercentage = () => {
							const amount = segment().amount;
							return `${amount.toFixed(1)}x`;
						};

						const zoomSegments = () => project.timeline?.zoomSegments ?? [];

						// Double-clicking a handle expands the segment as far as it can go
						// in that direction (up to the neighbouring segment / timeline edge).
						const fillStart = () => {
							const segs = zoomSegments();
							let minValue = 0;
							for (let j = segs.length - 1; j >= 0; j--) {
								const s = segs[j];
								if (s && s.end <= segment().start) {
									minValue = s.end;
									break;
								}
							}
							batch(() => {
								setProject("timeline", "zoomSegments", i, "start", minValue);
								setProject(
									"timeline",
									"zoomSegments",
									produce((s) => {
										s.sort((a, b) => a.start - b.start);
									}),
								);
							});
							setPreviewTime(minValue);
						};

						const fillEnd = () => {
							const segs = zoomSegments();
							let maxValue = totalDuration();
							for (let j = 0; j < segs.length; j++) {
								const s = segs[j];
								if (s && s.start > segment().end) {
									maxValue = s.start;
									break;
								}
							}
							batch(() => {
								setProject("timeline", "zoomSegments", i, "end", maxValue);
								setProject(
									"timeline",
									"zoomSegments",
									produce((s) => {
										s.sort((a, b) => a.start - b.start);
									}),
								);
							});
							setPreviewTime(maxValue);
						};

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
							const indices = selectedZoomIndices();
							if (!indices) return false;
							return indices.has(i);
						});

						return (
							<SegmentRoot
								overflowVisible={true}
								class={cx(
									"border duration-200 hover:border-gray-12 transition-colors group",
									"bg-linear-to-r from-[#292929] via-[#434343] to-[#292929] shadow-[inset_0_8px_12px_3px_rgba(255,255,255,0.2)]",
									isSelected() ? "border-gray-12" : "border-transparent",
								)}
								innerClass="ring-red-5"
								segment={segment()}
								onMouseDown={(e) => {
									e.stopPropagation();

									if (editorState.timeline.interactMode === "split") {
										const rect = e.currentTarget.getBoundingClientRect();
										const fraction = (e.clientX - rect.left) / rect.width;

										const splitTime =
											fraction * (segment().end - segment().start);

										projectActions.splitZoomSegment(i, splitTime);
									}
								}}
							>
								<SegmentHandle
									position="start"
									onDblClick={(e) => {
										e.stopPropagation();
										fillStart();
									}}
									onMouseDown={createMouseDownDrag(
										() => {
											const start = segment().start;
											const minDuration = Math.max(
												1,
												secsPerPixel() * MIN_ZOOM_SEGMENT_PIXEL_WIDTH,
											);

											let minValue = 0;

											const maxValue = segment().end - minDuration;

											for (let i = zoomSegments().length - 1; i >= 0; i--) {
												const segment = zoomSegments()[i];
												if (!segment) continue;
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
											const nextStart = Math.min(
												value.maxValue,
												Math.max(value.minValue, newStart),
											);

											setProject(
												"timeline",
												"zoomSegments",
												i,
												"start",
												nextStart,
											);

											setProject(
												"timeline",
												"zoomSegments",
												produce((s) => {
													s.sort((a, b) => a.start - b.start);
												}),
											);
											setPreviewTime(nextStart);
										},
									)}
								/>
								<SegmentContent
									class="flex justify-center items-center cursor-grab"
									onMouseDown={createMouseDownDrag(
										() => {
											const original = { ...segment() };

											const prevSegment = zoomSegments()[i - 1];
											const nextSegment = zoomSegments()[i + 1];

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

											setProject("timeline", "zoomSegments", i, {
												start: value.original.start + delta,
												end: value.original.end + delta,
											});
										},
									)}
								>
									{(() => {
										const ctx = useSegmentContext();
										const isInstant = () => segment().instantAnimation;

										const prev = () => zoomSegments()[i - 1];
										const next = () => zoomSegments()[i + 1];

										const isContiguousWithPrev = () => prev() && prev().end === segment().start;
										const isContiguousWithNext = () => next() && next().start === segment().end;

										const prevAmt = () => isContiguousWithPrev() ? prev().amount : 1.0;
										const currAmt = () => segment().amount;
										const nextAmt = () => isContiguousWithNext() ? next().amount : 1.0;

										// Map amount to Y coordinate asymptotically (1.0 -> 90, 2.0 -> 40, 4.5 -> 12)
										const getY = (amt: number) => Math.max(5, 90 - 100 * (1 - 1 / Math.max(1, amt)));

										const startY = () => getY(prevAmt());
										const currY = () => getY(currAmt());
										const endY = () => getY(nextAmt());

										const W = () => Math.max(1, ctx.width());
										const rampUpPct = () => (Math.min(40, W() / 2) / W()) * 100;
										const rampDownPct = () => (40 / W()) * 100;

										const d = () => {
											if (isInstant()) {
												return `M 0 ${startY()} L 0 ${currY()} L 100 ${currY()} ${
													!isContiguousWithNext() ? `L 100 ${endY()} L ${100 + rampDownPct()} ${endY()}` : ""
												}`;
											}
											return `M 0 ${startY()} C ${rampUpPct() / 2} ${startY()}, ${rampUpPct() / 2} ${currY()}, ${rampUpPct()} ${currY()} L 100 ${currY()} ${
												!isContiguousWithNext() ? `C ${100 + rampDownPct() / 2} ${currY()}, ${100 + rampDownPct() / 2} ${endY()}, ${100 + rampDownPct()} ${endY()}` : ""
											}`;
										};

										return (
												<Switch>
												<Match when={ctx.width() < 40}>
													<div class="flex justify-center items-center">
														<IconLucideSearch class="size-3.5 text-gray-1 dark:text-gray-12" />
													</div>
												</Match>
												<Match when={ctx.width() < 100}>
													<div class="flex gap-1 items-center text-xs whitespace-nowrap text-gray-1 dark:text-gray-12">
														<IconLucideSearch class="size-3" />
														<span>{zoomPercentage()}</span>
													</div>
												</Match>
												<Match when={true}>
													<div class="flex flex-col gap-1 justify-center items-center text-xs whitespace-nowrap text-gray-1 dark:text-gray-12 animate-in fade-in">
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
									onDblClick={(e) => {
										e.stopPropagation();
										fillEnd();
									}}
									onMouseDown={createMouseDownDrag(
										() => {
											const end = segment().end;
											const minDuration = Math.max(
												1,
												secsPerPixel() * MIN_ZOOM_SEGMENT_PIXEL_WIDTH,
											);

											const minValue = segment().start + minDuration;

											let maxValue = duration();

											for (let i = 0; i < zoomSegments().length; i++) {
												const segment = zoomSegments()[i];
												if (!segment) continue;
												if (segment.start > end) {
													maxValue = segment.start;
													break;
												}
											}

											return { end, minValue, maxValue };
										},
										(e, value, initialMouseX) => {
											const newEnd =
												value.end +
												(e.clientX - initialMouseX) * secsPerPixel();
											const nextEnd = Math.min(
												value.maxValue,
												Math.max(value.minValue, newEnd),
											);

											setProject("timeline", "zoomSegments", i, "end", nextEnd);

											setProject(
												"timeline",
												"zoomSegments",
												produce((s) => {
													s.sort((a, b) => a.start - b.start);
												}),
											);
											setPreviewTime(nextEnd);
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
					!isHoveringGenerateZoomButton() &&
					!useTrackContext().trackState.draggingSegment &&
					newSegmentDetails()
				}
			>
				{(details) => (
					<SegmentRoot
						class="pointer-events-none z-0"
						innerClass="ring-red-300"
						segment={details()}
					>
						<SegmentContent class="bg-linear-to-r hover:border duration-200 hover:border-gray-500 from-[#292929] via-[#434343] to-[#292929] transition-colors group shadow-[inset_0_8px_12px_3px_rgba(255,255,255,0.2)]">
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

export function ZoomCurveTrack() {
	const { project, editorState } = useEditorContext();
	const { secsPerPixel } = useTimelineContext();

	const zoomSegments = () => project.timeline?.zoomSegments ?? [];

	return (
		<TrackRoot>
			<div class="absolute inset-x-0 top-[5%] border-t border-gray-500/30 border-dashed" />
			<div class="absolute inset-x-0 top-[90%] border-t border-gray-500/30 border-dashed" />

			<div class="relative w-full h-full pointer-events-none">
				<For each={zoomSegments()}>
					{(segment, i) => {
						const base = () => editorState.timeline.transform.position;
						const translateX = () => (segment.start - base()) / secsPerPixel();
						const width = () => (segment.end - segment.start) / secsPerPixel();

						return (
							<div
								class="absolute top-0 bottom-0 overflow-visible"
								style={{
									transform: `translateX(${translateX()}px)`,
									width: `${width()}px`,
								}}
							>
								{(() => {
									const isInstant = () => segment.instantAnimation;

									const prev = () => zoomSegments()[i() - 1];
									const next = () => zoomSegments()[i() + 1];

									const isContiguousWithPrev = () => prev() && prev().end === segment.start;
									const isContiguousWithNext = () => next() && next().start === segment.end;

									const prevAmt = () => isContiguousWithPrev() ? prev().amount : 1.0;
									const currAmt = () => segment.amount;
									const nextAmt = () => isContiguousWithNext() ? next().amount : 1.0;

									// Map amount to Y coordinate linearly (1.0 -> 90, 4.5 -> 5)
									const getY = (amt: number) => {
										// Allow p to be negative so zoom-out (< 1.0) goes below the baseline
										const p = Math.min(1, (amt - 1) / 3.5);
										return 90 - 85 * p;
									};

									const startY = () => getY(prevAmt());
									const currY = () => getY(currAmt());
									const endY = () => getY(nextAmt());

									const W = () => Math.max(1, width());
									// The video rendering engine uses exactly 1.0 second for the zoom transition
									const rampDurationSecs = 1.0;
									const rampPixels = () => rampDurationSecs / secsPerPixel();
									
									const toPct = (px: number) => (px / W()) * 100;
									const rampUpPct = () => isInstant() ? 0 : toPct(Math.min(rampPixels(), W() / 2));
									const rampDownPct = () => isInstant() ? 0 : toPct(rampPixels());

									const dGray = () => {
										let parts = [];

										// 1. Gap before
										if (i() === 0) {
											parts.push(`M -100000 ${getY(1.0)} L 0 ${getY(1.0)}`);
										} else {
											const prevSeg = prev();
											const prevEndOffset = (prevSeg.end - segment.start) / secsPerPixel();
											const prevRampDownW = prevSeg.instantAnimation ? 0 : rampPixels();
											const gapStartX = isContiguousWithPrev() ? 0 : prevEndOffset + prevRampDownW;
											if (gapStartX < 0) {
												parts.push(`M ${toPct(gapStartX)} ${getY(1.0)} L 0 ${getY(1.0)}`);
											}
										}

										// 2. Flat top
										parts.push(`M ${rampUpPct()} ${currY()} L 100 ${currY()}`);

										// 3. Gap after (if last)
										if (i() === zoomSegments().length - 1) {
											const afterXPct = 100 + (!isContiguousWithNext() ? rampDownPct() : 0);
											parts.push(`M ${afterXPct} ${getY(1.0)} L 100000 ${getY(1.0)}`);
										}

										return parts.join(" ");
									};

									const dColored = () => {
										let parts = [];

										// 1. Ramp Up
										if (isInstant()) {
											parts.push(`M 0 ${startY()} L 0 ${currY()}`);
										} else {
											parts.push(`M 0 ${startY()} C ${rampUpPct() / 2} ${startY()}, ${rampUpPct() / 2} ${currY()}, ${rampUpPct()} ${currY()}`);
										}

										// 2. Ramp Down
										if (!isContiguousWithNext()) {
											if (isInstant()) {
												parts.push(`M 100 ${currY()} L 100 ${endY()}`);
											} else {
												parts.push(`M 100 ${currY()} C ${100 + rampDownPct() / 2} ${currY()}, ${100 + rampDownPct() / 2} ${endY()}, ${100 + rampDownPct()} ${endY()}`);
											}
										}

										return parts.join(" ");
									};

									return (
										<svg
											class="absolute inset-0 w-full h-full pointer-events-none overflow-visible z-0"
											viewBox="0 0 100 100"
											preserveAspectRatio="none"
										>
											<path
												d={dGray()}
												class="stroke-gray-400/30 dark:stroke-gray-500/30"
												stroke-width="3"
												fill="none"
												vector-effect="non-scaling-stroke"
											/>
											<path
												d={dColored()}
												class="stroke-blue-300 dark:stroke-blue-300"
												stroke-width="3"
												fill="none"
												vector-effect="non-scaling-stroke"
											/>
										</svg>
									);
								})()}
							</div>
						);
					}}
				</For>
			</div>
		</TrackRoot>
	);
}

