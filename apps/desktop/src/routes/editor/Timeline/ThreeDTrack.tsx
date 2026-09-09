import { createEventListenerMap } from "@solid-primitives/event-listener";
import { createMemo, createRoot, Index, Show } from "solid-js";
import { produce } from "solid-js/store";
import { useEditorContext } from "../context";
import {
	camera3DSceneRange,
	findCamera3DScene,
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
function Camera3DSetupGhost(props: {
	segment: { start: number; end: number };
	label: string;
}) {
	const translateX = useSegmentTranslateX(() => props.segment);
	const width = useSegmentWidth(() => props.segment);

	return (
		<div
			class="flex absolute inset-y-0 justify-center items-center rounded-lg border border-dashed pointer-events-none"
			style={{
				transform: `translateX(${translateX()}px)`,
				width: `${width()}px`,
				"border-color": "color-mix(in srgb, var(--track-3d) 70%, transparent)",
				background: "color-mix(in srgb, var(--track-3d) 14%, transparent)",
			}}
		>
			<span
				class="px-2 truncate cap-seg-label"
				style={{ "--seg-color": "var(--track-3d)" }}
			>
				{props.label}
			</span>
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

	const hasCamera3DSegments = () =>
		(project.timeline?.camera3dSegments?.length ?? 0) > 0;
	const setup = () => editorState.timeline.camera3dSetup;
	const setupRange = createMemo(() => {
		const current = setup();
		if (!current) return null;
		const segments = camera3DScenePreview(current);
		if (!segments.length) return null;
		return { start: segments[0].start, end: segments[segments.length - 1].end };
	});
	const startSetup = (time = editorState.playbackTime) =>
		projectActions.startCamera3DSetup(time);
	const selectedCamera3DIndices = createMemo(() => {
		const selection = editorState.timeline.selection;
		if (!selection || selection.type !== "3d") return null;
		return new Set(selection.indices);
	});

	const newSegmentDetails = () => {
		if (
			setup() ||
			!hasCamera3DSegments() ||
			editorState.timeline.hoveredTrack !== "3d" ||
			editorState.previewTime === null
		)
			return null;
		return camera3DSceneRange(
			project.timeline?.camera3dSegments ?? [],
			editorState.previewTime,
			6,
			totalDuration(),
		);
	};

	return (
		<TrackRoot
			onMouseEnter={() => setEditorState("timeline", "hoveredTrack", "3d")}
			onMouseLeave={() => setEditorState("timeline", "hoveredTrack", null)}
			onMouseDown={(e) => {
				if (e.button !== 0 || editorState.timeline.interactMode !== "seek")
					return;
				e.stopPropagation();
				const time = editorState.previewTime ?? editorState.playbackTime;
				if (setup()) {
					setEditorState("timeline", "camera3dSetup", "start", time);
				} else startSetup(time);
			}}
		>
			<Show when={!hasCamera3DSegments() && !setup()}>
				<button
					type="button"
					class="cap-empty-lane pointer-events-auto outline-hidden"
					onMouseDown={(e) => e.stopPropagation()}
					onClick={(e) => {
						e.stopPropagation();
						startSetup();
					}}
				>
					<span>Tilt the scene in 3D perspective</span>
					<span class="cap-empty-lane-action">· Add 3D scene</span>
				</button>
			</Show>
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
							class="group"
							selected={isSelected()}
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
								class="flex items-center cursor-grab"
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
												<div class="cap-seg-labels animate-in fade-in">
													<span class="cap-seg-label">
														{visibleBox().width >= 140
															? "3D Perspective"
															: "3D"}
													</span>
													<span class="cap-seg-sublabel flex gap-1 items-center">
														{motionLabel()}
														{/* Presentation only: the arrow says the shot
															moves from its start pose to its end pose. */}
														<Show when={hasCamera3DMotion(segment())}>
															<IconLucideChevronRight class="size-3" />
														</Show>
													</span>
												</div>
											)}
											compact={() => (
												<div class="cap-seg-labels">
													<span class="cap-seg-label">3D</span>
												</div>
											)}
											glyph={() => (
												<div class="cap-seg-label flex justify-center items-center">
													<IconLucideRotate3d class="size-3.5" />
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
											value.end + (e.clientX - initialMouseX) * secsPerPixel();
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
			<Show when={setupRange()}>
				{(range) => (
					<Camera3DSetupGhost
						segment={range()}
						label={`${findCamera3DScene(setup()?.sceneId ?? "")?.name ?? "3D scene"} · ${(range().end - range().start).toFixed(1)}s`}
					/>
				)}
			</Show>
			<Show
				when={
					!useTrackContext().trackState.draggingSegment && newSegmentDetails()
				}
			>
				{(details) => (
					<SegmentRoot
						class="pointer-events-none z-0"
						ghost
						segColor="var(--track-3d)"
						segment={details()}
					>
						<SegmentContent class="group justify-center">
							<p class="cap-seg-label">+ Add 3D scene</p>
						</SegmentContent>
					</SegmentRoot>
				)}
			</Show>
		</TrackRoot>
	);
}
