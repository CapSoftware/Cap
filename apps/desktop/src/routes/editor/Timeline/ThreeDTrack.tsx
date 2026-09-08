import { createEventListenerMap } from "@solid-primitives/event-listener";
import { cx } from "cva";
import { Array, Option } from "effect";
import {
	batch,
	createMemo,
	createRoot,
	createSignal,
	Index,
	Show,
} from "solid-js";
import { produce } from "solid-js/store";
import { useEditorContext } from "../context";
import {
	CAMERA3D_SCENES,
	defaultCamera3DSegment,
	fitCamera3DMotionToSegment,
	hasCamera3DMotion,
} from "../three-d";
import { useTimelineContext, useTrackContext } from "./context";
import {
	SegmentContent,
	SegmentHandle,
	SegmentLabel,
	SegmentRoot,
	TrackRoot,
	useSegmentTranslateX,
	useSegmentVisibleBox,
	useSegmentWidth,
	useSetPreviewTime,
} from "./Track";

export type ThreeDSegmentDragState =
	| { type: "idle" }
	| { type: "movePending" }
	| { type: "moving" };

const MIN_THREE_D_SEGMENT_PIXEL_WIDTH = 40;
const MIN_NEW_SEGMENT_PIXEL_WIDTH = 80;
const MIN_NEW_SEGMENT_SECS_WIDTH = 1;

/** What the setup flow opens on: the full showcase sequence. */
const CAMERA3D_SETUP_SEED = { sceneId: "showcase", shots: 3 };

/**
 * One shot of the scene the setup flow is offering, drawn where it would land.
 * Non-interactive: the whole placeholder area belongs to the open flow.
 */
function Camera3DSetupGhost(props: {
	segment: { start: number; end: number };
	label: string;
}) {
	const translateX = useSegmentTranslateX(() => props.segment);
	const width = useSegmentWidth(() => props.segment);

	return (
		<div
			class="flex absolute inset-y-0 justify-center items-center rounded-xl border border-dashed pointer-events-none"
			style={{
				transform: `translateX(${translateX()}px)`,
				width: `${width()}px`,
				"border-color": "color-mix(in srgb, var(--track-3d) 70%, transparent)",
				background: "color-mix(in srgb, var(--track-3d) 14%, transparent)",
			}}
		>
			<span class="px-2 text-xs truncate text-gray-12">{props.label}</span>
		</div>
	);
}

export function ThreeDTrack(props: {
	onDragStateChanged: (v: ThreeDSegmentDragState) => void;
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
		camera3DScenePreview,
	} = useEditorContext();

	const { duration, secsPerPixel } = useTimelineContext();
	const setPreviewTime = useSetPreviewTime();

	const [creatingSegmentViaDrag, setCreatingSegmentViaDrag] =
		createSignal(false);

	const hasCamera3DSegments = () =>
		(project.timeline?.camera3dSegments?.length ?? 0) > 0;

	const setup = () => editorState.timeline.camera3dSetup;

	const setupSegments = createMemo(() => {
		const current = setup();
		if (!current) return [];
		return camera3DScenePreview(current.sceneId, current.shots);
	});

	const setupShotLabel = (index: number) => {
		const current = setup();
		const scene = current
			? CAMERA3D_SCENES.find((s) => s.id === current.sceneId)
			: undefined;
		return scene?.shots[index]?.name ?? `Shot ${index + 1}`;
	};

	const startSetup = () =>
		batch(() => {
			setEditorState("timeline", "selection", null);
			setEditorState("timeline", "audioPicker", null);
			setEditorState("timeline", "audioReplace", null);
			setEditorState("timeline", "camera3dSetup", { ...CAMERA3D_SETUP_SEED });
		});
	const selectedCamera3DIndices = createMemo(() => {
		const selection = editorState.timeline.selection;
		if (!selection || selection.type !== "3d") return null;
		return new Set(selection.indices);
	});

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
			editorState.timeline.hoveredTrack !== "3d" ||
			editorState.previewTime === null
		)
			return;

		// An empty track belongs to the setup flow, whether it is open or still
		// only offering itself, so nothing is drag-created over it.
		if (!hasCamera3DSegments() || setup()) return;

		const { previewTime } = editorState;

		const nextSegment = Array.findFirstWithIndex(
			project.timeline?.camera3dSegments ?? [],
			(s) => previewTime <= s.start,
		);

		const prevSegment = Array.findLastIndex(
			project.timeline?.camera3dSegments ?? [],
			(s) => previewTime >= s.start,
		).pipe(
			Option.flatMap((index) =>
				Option.fromNullable(project.timeline?.camera3dSegments?.[index]).pipe(
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
			onMouseEnter={() => setEditorState("timeline", "hoveredTrack", "3d")}
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
							setProject("timeline", "camera3dSegments", (v) => v ?? []);
							setProject(
								"timeline",
								"camera3dSegments",
								produce((camera3dSegments) => {
									camera3dSegments ??= [];

									let index = 0;

									for (let i = 0; i < camera3dSegments.length; i++) {
										if (camera3dSegments[i].start < baseSegment.start) {
											index = i + 1;
										}
									}

									const minEndTime = baseSegment.start + minDuration();

									camera3dSegments.splice(
										index,
										0,
										defaultCamera3DSegment(
											baseSegment.start,
											Math.max(minEndTime, endTime),
										),
									);

									createdSegmentIndex = index;
								}),
							);
							setEditorState("timeline", "selection", {
								type: "3d",
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
							"camera3dSegments",
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
				when={hasCamera3DSegments()}
				fallback={
					<Show
						when={setup()}
						fallback={
							// An empty 3D track is the one place a whole scene can land
							// without overwriting anything, so it is offered here.
							<button
								type="button"
								style={{
									"--accent": "var(--track-3d)",
									"--accent-soft":
										"color-mix(in srgb, var(--track-3d) 12%, transparent)",
								}}
								class="group/empty flex gap-2 justify-center items-center w-full text-sm rounded-xl border transition-all duration-200 pointer-events-auto border-dashed border-gray-4/60 bg-gray-3/15 text-(--text-tertiary) hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-gray-12"
								onMouseDown={(e) => e.stopPropagation()}
								onClick={(e) => {
									e.stopPropagation();
									startSetup();
								}}
							>
								<span class="flex justify-center items-center rounded-full transition-colors size-6 bg-gray-4/40 text-gray-11 group-hover/empty:bg-[var(--accent)] group-hover/empty:text-white">
									<IconLucidePlus class="size-3.5" />
								</span>
								<span class="font-medium">Add 3D scene</span>
							</button>
						}
					>
						{/* The open flow owns the whole track: the shots it would lay
						    down are drawn where they will land, and a click anywhere
						    over them leaves the flow alone rather than closing it. */}
						<div
							class="absolute inset-0 pointer-events-auto"
							onMouseDown={(e) => e.stopPropagation()}
						>
							<Index each={setupSegments()}>
								{(ghost, index) => (
									<Camera3DSetupGhost
										segment={ghost()}
										label={setupShotLabel(index)}
									/>
								)}
							</Index>
						</div>
					</Show>
				}
			>
				<Index each={project.timeline?.camera3dSegments}>
					{(segment, i) => {
						const { setTrackState } = useTrackContext();

						const camera3dSegments = () =>
							project.timeline?.camera3dSegments ?? [];

						const motionLabel = () =>
							hasCamera3DMotion(segment()) ? "Motion" : "Still";

						// Double-clicking a handle expands the segment as far as it can go
						// in that direction (up to the neighbouring segment / timeline edge).
						const fillStart = () => {
							const segs = camera3dSegments();
							let minValue = 0;
							for (let j = segs.length - 1; j >= 0; j--) {
								const s = segs[j];
								if (s && s.end <= segment().start) {
									minValue = s.end;
									break;
								}
							}
							setProject(
								"timeline",
								"camera3dSegments",
								produce((s) => {
									const target = s[i];
									if (!target) return;
									target.start = minValue;
									fitCamera3DMotionToSegment(target);
									s.sort((a, b) => a.start - b.start);
								}),
							);
							setPreviewTime(minValue);
						};

						const fillEnd = () => {
							const segs = camera3dSegments();
							let maxValue = totalDuration();
							for (let j = 0; j < segs.length; j++) {
								const s = segs[j];
								if (s && s.start > segment().end) {
									maxValue = s.start;
									break;
								}
							}
							setProject(
								"timeline",
								"camera3dSegments",
								produce((s) => {
									const target = s[i];
									if (!target) return;
									target.end = maxValue;
									fitCamera3DMotionToSegment(target);
									s.sort((a, b) => a.start - b.start);
								}),
							);
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

										if (isRangeSelect && currentSelection?.type === "3d") {
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
												type: "3d",
												indices: rangeIndices,
											});
										} else if (isMultiSelect) {
											if (currentSelection?.type === "3d") {
												const baseIndices = currentSelection.indices;
												const exists = baseIndices.includes(segmentIndex);
												const newIndices = exists
													? baseIndices.filter((idx) => idx !== segmentIndex)
													: [...baseIndices, segmentIndex];

												if (newIndices.length > 0) {
													setEditorState("timeline", "selection", {
														type: "3d",
														indices: newIndices,
													});
												} else {
													setEditorState("timeline", "selection", null);
												}
											} else {
												setEditorState("timeline", "selection", {
													type: "3d",
													indices: [segmentIndex],
												});
											}
										} else {
											setEditorState("timeline", "selection", {
												type: "3d",
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
							const indices = selectedCamera3DIndices();
							if (!indices) return false;
							return indices.has(i);
						});

						return (
							<SegmentRoot
								segColor="var(--track-3d)"
								class={cx(
									"border duration-200 transition-colors group",
									isSelected() ? "border-gray-12" : "border-transparent",
								)}
								innerClass="ring-red-5"
								title={`3D Perspective · ${motionLabel()}`}
								segment={segment()}
								onMouseDown={(e) => {
									e.stopPropagation();

									if (editorState.timeline.interactMode === "split") {
										const rect = e.currentTarget.getBoundingClientRect();
										const fraction = (e.clientX - rect.left) / rect.width;

										const splitTime =
											fraction * (segment().end - segment().start);

										projectActions.splitCamera3DSegment(i, splitTime);
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
												secsPerPixel() * MIN_THREE_D_SEGMENT_PIXEL_WIDTH,
											);

											let minValue = 0;

											const maxValue = segment().end - minDuration;

											for (let j = camera3dSegments().length - 1; j >= 0; j--) {
												const other = camera3dSegments()[j];
												if (!other) continue;
												if (other.end <= start) {
													minValue = other.end;
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
												"camera3dSegments",
												produce((s) => {
													const target = s[i];
													if (!target) return;
													target.start = nextStart;
													fitCamera3DMotionToSegment(target);
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

											const prevSegment = camera3dSegments()[i - 1];
											const nextSegment = camera3dSegments()[i + 1];

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

											setProject("timeline", "camera3dSegments", i, {
												start: value.original.start + delta,
												end: value.original.end + delta,
											});
										},
									)}
								>
									{(() => {
										const visibleBox = useSegmentVisibleBox();

										return (
											<SegmentLabel
												full={() => (
													<div class="flex flex-col gap-1 justify-center items-center text-xs whitespace-nowrap text-gray-1 dark:text-gray-12 animate-in fade-in">
														<span class="opacity-70">
															{visibleBox().width >= 140
																? "3D Perspective"
																: "3D"}
														</span>
														<div class="flex gap-1 items-center text-md">
															<IconLucideRotate3d class="size-3.5" />
															<span>{motionLabel()}</span>
															{/* Presentation only: the arrow says the shot
															    moves from its start pose to its end pose. */}
															<Show when={hasCamera3DMotion(segment())}>
																<IconLucideChevronRight class="size-3 opacity-70" />
															</Show>
														</div>
													</div>
												)}
												compact={() => (
													<div class="flex gap-1 items-center text-xs whitespace-nowrap text-gray-1 dark:text-gray-12">
														<IconLucideRotate3d class="size-3" />
														<span>3D</span>
													</div>
												)}
												glyph={() => (
													<div class="flex justify-center items-center">
														<IconLucideRotate3d class="size-3.5 text-gray-1 dark:text-gray-12" />
													</div>
												)}
											/>
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
												secsPerPixel() * MIN_THREE_D_SEGMENT_PIXEL_WIDTH,
											);

											const minValue = segment().start + minDuration;

											let maxValue = duration();

											for (let j = 0; j < camera3dSegments().length; j++) {
												const other = camera3dSegments()[j];
												if (!other) continue;
												if (other.start > end) {
													maxValue = other.start;
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

											setProject(
												"timeline",
												"camera3dSegments",
												produce((s) => {
													const target = s[i];
													if (!target) return;
													target.end = nextEnd;
													fitCamera3DMotionToSegment(target);
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
					!useTrackContext().trackState.draggingSegment && newSegmentDetails()
				}
			>
				{(details) => (
					<SegmentRoot
						class="pointer-events-none z-0"
						innerClass="ring-red-300"
						segColor="var(--track-3d)"
						segment={details()}
					>
						<SegmentContent class="group">
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
