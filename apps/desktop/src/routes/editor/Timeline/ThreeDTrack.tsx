import {
	createEventListener,
	createEventListenerMap,
} from "@solid-primitives/event-listener";
import {
	createMemo,
	createRoot,
	createSignal,
	For,
	Index,
	onCleanup,
	Show,
} from "solid-js";
import { produce } from "solid-js/store";
import { useEditorContext } from "../context";
import {
	camera3DShotLabel,
	DEFAULT_CAMERA3D_SHOT_DURATION,
	fitCamera3DMotionToSegment,
	MAX_AUTO_CAMERA3D_SHOTS,
	maxAutoCamera3DShots,
	placeCamera3DShot,
} from "../three-d";
import { ShotCountPills } from "../three-d-panel";
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
const MIN_NEW_SHOT_SECS = 1;
/** Below this the ghost has no room for words and shows a bare "+". */
const GHOST_LABEL_PX = 96;
const GHOST_FULL_LABEL_PX = 200;

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
		camera3DAutoScenePreview,
	} = useEditorContext();

	const { duration, secsPerPixel } = useTimelineContext();
	const setPreviewTime = useSetPreviewTime();

	// The range being drawn by a drag on empty lane space. While it is set the
	// ghost shows the drawn range instead of the one under the cursor.
	const [dragRange, setDragRange] = createSignal<{
		start: number;
		end: number;
	} | null>(null);

	const camera3dSegments = () => project.timeline?.camera3dSegments ?? [];
	const hasCamera3DSegments = () => camera3dSegments().length > 0;

	// The empty lane's "Auto scene" chip opens in place rather than in a dialog,
	// so the counts sit right above the track they are about to fill.
	const [pickerOpen, setPickerOpen] = createSignal(false);
	const maxShots = () => maxAutoCamera3DShots(totalDuration());

	const previewShotCount = (count: number | null) =>
		setEditorState("timeline", "camera3dAutoPreview", count);

	const closePicker = () => {
		setPickerOpen(false);
		previewShotCount(null);
	};

	const pickShotCount = (count: number) => {
		closePicker();
		projectActions.applyCamera3DAutoScene(count);
	};

	onCleanup(() => previewShotCount(null));

	createEventListener(window, "keydown", (e) => {
		// The picker only exists on an empty lane: a shot landing there while it
		// is open takes the shortcuts with it.
		if (!pickerOpen() || hasCamera3DSegments()) return;
		if (
			document.activeElement instanceof HTMLInputElement ||
			document.activeElement instanceof HTMLTextAreaElement
		)
			return;
		if (e.key === "Escape") {
			closePicker();
			return;
		}
		if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
		const count = Number.parseInt(e.key, 10);
		if (
			!Number.isInteger(count) ||
			count < 1 ||
			count > MAX_AUTO_CAMERA3D_SHOTS
		)
			return;
		if (count > maxShots()) return;
		e.preventDefault();
		pickShotCount(count);
	});

	const selectedCamera3DIndices = createMemo(() => {
		const selection = editorState.timeline.selection;
		if (!selection || selection.type !== "3d") return null;
		return new Set(selection.indices);
	});

	// The range a shot dropped at the cursor would take. Also drives the drag,
	// so what the ghost promises is exactly what a drag starts from. Over an
	// existing shot there is nothing to offer: that click selects instead, and
	// a ghost hovering somewhere else on the lane would only mislead.
	const newShotDetails = () => {
		const time = editorState.previewTime;
		if (editorState.timeline.hoveredTrack !== "3d" || time === null)
			return null;
		if (
			camera3dSegments().some(
				(segment) => time >= segment.start && time < segment.end,
			)
		)
			return null;
		return placeCamera3DShot(
			camera3dSegments(),
			time,
			DEFAULT_CAMERA3D_SHOT_DURATION,
			totalDuration(),
		);
	};

	// How far right a drag from `start` may run before it hits the next shot.
	const gapEndAfter = (start: number) => {
		let end = totalDuration();
		for (const segment of camera3dSegments())
			if (segment.start >= start) end = Math.min(end, segment.start);
		return end;
	};

	return (
		<TrackRoot
			onMouseEnter={() => setEditorState("timeline", "hoveredTrack", "3d")}
			onMouseLeave={() => setEditorState("timeline", "hoveredTrack", null)}
			onMouseDown={(e) => {
				if (e.button !== 0 || editorState.timeline.interactMode !== "seek")
					return;
				e.stopPropagation();

				const base = newShotDetails();
				if (!base) {
					// The lane is full at the cursor, but the click still deserves an
					// answer: place it wherever there is room, or say there is none.
					projectActions.addCamera3DShot(
						editorState.previewTime ?? editorState.playbackTime,
					);
					return;
				}

				createRoot((dispose) => {
					const initialMouseX = e.clientX;
					// A drag can run to the next shot even though the click-sized
					// ghost stops at the default duration.
					const maxEnd = Math.max(
						gapEndAfter(base.start),
						base.start + MIN_NEW_SHOT_SECS,
					);
					let dragging = false;

					const rangeFor = (clientX: number) => {
						const dragged =
							base.end + (clientX - initialMouseX) * secsPerPixel();
						return {
							start: base.start,
							end: Math.min(
								Math.max(dragged, base.start + MIN_NEW_SHOT_SECS),
								maxEnd,
							),
						};
					};

					createEventListenerMap(window, {
						mousemove: (moveEvent: MouseEvent) => {
							if (!dragging && Math.abs(moveEvent.clientX - initialMouseX) <= 2)
								return;
							dragging = true;
							setDragRange(rangeFor(moveEvent.clientX));
						},
						mouseup: (upEvent: MouseEvent) => {
							const range = dragging ? rangeFor(upEvent.clientX) : base;
							setDragRange(null);
							dispose();
							projectActions.addCamera3DShotRange(range.start, range.end);
						},
						blur: () => {
							setDragRange(null);
							dispose();
						},
					});
				});
			}}
		>
			<Show when={!hasCamera3DSegments()}>
				<div class="cap-empty-lane relative z-1 isolate pointer-events-auto">
					<Show
						when={pickerOpen()}
						fallback={
							<>
								<span>Add cinematic 3D shots to your recording</span>
								<div
									class="flex relative z-10 gap-2 items-center"
									onMouseDown={(e) => e.stopPropagation()}
								>
									<button
										type="button"
										class="cap-lane-chip outline-hidden"
										onClick={() => setPickerOpen(true)}
									>
										Auto scene
									</button>
									<button
										type="button"
										class="cap-lane-chip cap-lane-chip-ghost outline-hidden"
										onClick={() => projectActions.addCamera3DShot()}
									>
										+ Add shot
									</button>
								</div>
							</>
						}
					>
						<span>How many shots?</span>
						<div
							class="flex relative z-10 gap-1 items-center"
							onMouseDown={(e) => e.stopPropagation()}
						>
							<ShotCountPills
								max={maxShots()}
								onHover={previewShotCount}
								onPick={pickShotCount}
							/>
							<button
								type="button"
								aria-label="Close the shot picker"
								class="flex justify-center items-center ml-1 rounded-md transition-colors outline-hidden text-ed-text-3 hover:text-ed-text-1 hover:bg-ed-ctl-hover size-5"
								onClick={() => closePicker()}
							>
								<IconLucideX class="size-3" />
							</button>
							<button
								type="button"
								class="ml-1 cap-lane-chip cap-lane-chip-ghost outline-hidden"
								onClick={() => projectActions.addCamera3DShot()}
							>
								+ Add shot
							</button>
						</div>
					</Show>
				</div>
			</Show>
			<Index each={project.timeline?.camera3dSegments}>
				{(segment, i) => {
					const { setTrackState } = useTrackContext();

					const shotLabel = () => camera3DShotLabel(segment());
					const shotDuration = () =>
						`${(segment().end - segment().start).toFixed(1)}s`;

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
							title={`3D shot · ${shotLabel()} · ${shotDuration()}`}
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
													<span class="cap-seg-label truncate">
														{visibleBox().width >= 140
															? shotLabel()
															: shotLabel().split(" ")[0]}
													</span>
													<span class="cap-seg-sublabel">{shotDuration()}</span>
												</div>
											)}
											compact={() => (
												<div class="cap-seg-labels">
													<span class="cap-seg-label">
														{shotLabel().split(" ")[0]}
													</span>
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
							{/* The two poses of the selected shot, on the shot itself:
							    the same control as the panel's pose cards. They sit
							    inside the resize handles, which keep the edge. */}
							<Show
								when={isSelected() && selectedCamera3DIndices()?.size === 1}
							>
								<For each={[false, true]}>
									{(end) => (
										<button
											type="button"
											aria-label={
												end ? "Edit the end pose" : "Edit the start pose"
											}
											title={end ? "End pose" : "Start pose"}
											class="cap-pose-dot"
											data-active={
												(editorState.timeline.camera3dPose === "end") === end
											}
											style={end ? { right: "5px" } : { left: "5px" }}
											onMouseDown={(e) => e.stopPropagation()}
											onClick={(e) => {
												e.stopPropagation();
												projectActions.selectCamera3DPose(i, end);
											}}
										/>
									)}
								</For>
							</Show>
						</SegmentRoot>
					);
				}}
			</Index>
			<Show
				when={editorState.timeline.camera3dAutoPreview}
				fallback={
					<Show
						when={
							!useTrackContext().trackState.draggingSegment &&
							(dragRange() ?? (hasCamera3DSegments() ? newShotDetails() : null))
						}
					>
						{(range) => <AddShotGhost labelled range={range()} />}
					</Show>
				}
			>
				{(count) => (
					<For each={camera3DAutoScenePreview(count())}>
						{(range) => <AddShotGhost range={range} />}
					</For>
				)}
			</Show>
		</TrackRoot>
	);
}

/**
 * The dashed preview of the shot a click would create, with its left edge on
 * the cursor. It is not interactive itself: the lane underneath owns the click
 * and the drag, so the ghost can never swallow either.
 */
function AddShotGhost(props: {
	range: { start: number; end: number };
	labelled?: boolean;
}) {
	const translateX = useSegmentTranslateX(() => props.range);
	const width = useSegmentWidth(() => props.range);
	const seconds = () => props.range.end - props.range.start;

	return (
		<div
			class="cap-add-shot-ghost"
			style={{
				transform: `translateX(${translateX()}px)`,
				width: `${width()}px`,
			}}
		>
			<Show when={props.labelled}>
				<span class="truncate">
					{width() >= GHOST_FULL_LABEL_PX
						? `+ Add shot · Glide across · ${seconds().toFixed(1)}s`
						: width() >= GHOST_LABEL_PX
							? "+ Add shot"
							: "+"}
				</span>
			</Show>
		</div>
	);
}
