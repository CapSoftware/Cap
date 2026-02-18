import { createEventListenerMap } from "@solid-primitives/event-listener";
import { cx } from "cva";
import { createMemo, createRoot, For } from "solid-js";
import { produce } from "solid-js/store";

import { useEditorContext } from "../context";
import { useTimelineContext } from "./context";
import { SegmentContent, SegmentHandle, SegmentRoot, TrackRoot } from "./Track";

export type CaptionSegmentDragState =
	| { type: "idle" }
	| { type: "movePending" }
	| { type: "moving" };

const MIN_SEGMENT_SECS = 0.5;
const MIN_SEGMENT_PIXELS = 40;

export function CaptionsTrack(props: {
	onDragStateChanged: (v: CaptionSegmentDragState) => void;
	handleUpdatePlayhead: (e: MouseEvent) => void;
}) {
	const {
		project,
		setProject,
		editorState,
		setEditorState,
		totalDuration,
		projectHistory,
		projectActions,
	} = useEditorContext();
	const { secsPerPixel, timelineBounds } = useTimelineContext();

	const minDuration = () =>
		Math.max(MIN_SEGMENT_SECS, secsPerPixel() * MIN_SEGMENT_PIXELS);

	const captionSegments = () => project.timeline?.captionSegments ?? [];

	const neighborBounds = (index: number) => {
		const segments = captionSegments();
		return {
			prevEnd: segments[index - 1]?.end ?? 0,
			nextStart: segments[index + 1]?.start ?? totalDuration(),
		};
	};

	function createMouseDownDrag<T>(
		segmentIndex: () => number,
		setup: () => T,
		update: (e: MouseEvent, value: T, initialMouseX: number) => void,
	) {
		return (downEvent: MouseEvent) => {
			if (editorState.timeline.interactMode !== "seek") return;
			downEvent.stopPropagation();
			const initial = setup();
			let moved = false;
			let initialMouseX: number | null = null;

			const resumeHistory = projectHistory.pause();
			props.onDragStateChanged({ type: "movePending" });

			function finish(e: MouseEvent) {
				resumeHistory();
				if (!moved) {
					e.stopPropagation();
					const index = segmentIndex();
					const isMultiSelect = e.ctrlKey || e.metaKey;

					if (isMultiSelect) {
						const currentSelection = editorState.timeline.selection;
						if (currentSelection?.type === "caption") {
							const base = currentSelection.indices;
							const exists = base.includes(index);
							const next = exists
								? base.filter((i) => i !== index)
								: [...base, index];
							setEditorState(
								"timeline",
								"selection",
								next.length > 0
									? { type: "caption", indices: next }
									: null,
							);
						} else {
							setEditorState("timeline", "selection", {
								type: "caption",
								indices: [index],
							});
						}
					} else {
						setEditorState("timeline", "selection", {
							type: "caption",
							indices: [index],
						});
					}
					props.handleUpdatePlayhead(e);
				}
				props.onDragStateChanged({ type: "idle" });
			}

			function handleUpdate(event: MouseEvent) {
				if (Math.abs(event.clientX - downEvent.clientX) > 2) {
					if (!moved) {
						moved = true;
						initialMouseX = event.clientX;
						props.onDragStateChanged({ type: "moving" });
					}
				}
				if (initialMouseX === null) return;
				update(event, initial, initialMouseX);
			}

			createRoot((dispose) => {
				createEventListenerMap(window, {
					mousemove: (e) => handleUpdate(e),
					mouseup: (e) => {
						handleUpdate(e);
						finish(e);
						dispose();
					},
				});
			});
		};
	}

	return (
		<TrackRoot
			onMouseEnter={() =>
				setEditorState("timeline", "hoveredTrack", "caption")
			}
			onMouseLeave={() => setEditorState("timeline", "hoveredTrack", null)}
		>
			<For
				each={captionSegments()}
				fallback={
					<div class="text-center text-sm text-[--text-tertiary] flex flex-col justify-center items-center inset-0 w-full bg-gray-3/20 dark:bg-gray-3/10 rounded-xl pointer-events-none">
						<div>No captions</div>
						<div class="text-[10px] text-[--text-tertiary]/40 mt-0.5">
							Generate captions in the sidebar
						</div>
					</div>
				}
			>
				{(segment, i) => {
					const isSelected = createMemo(() => {
						const selection = editorState.timeline.selection;
						if (!selection || selection.type !== "caption") return false;
						return selection.indices.includes(i());
					});

					const segmentWidth = () => segment.end - segment.start;

					return (
						<SegmentRoot
							data-caption-segment
							data-index={i()}
							class={cx(
								"border duration-200 hover:border-green-6 transition-colors group",
								"bg-gradient-to-r from-[#0d1f12] via-[#162618] to-[#0d1f12]",
								isSelected() ? "border-green-7" : "border-transparent",
							)}
							innerClass="ring-green-6"
							segment={segment}
							onMouseDown={(e) => {
								e.stopPropagation();
								if (editorState.timeline.interactMode === "split") {
									const rect = e.currentTarget.getBoundingClientRect();
									const fraction = (e.clientX - rect.left) / rect.width;
									const splitTime = fraction * segmentWidth();
									projectActions.splitCaptionSegment(i(), splitTime);
								}
							}}
						>
							<SegmentHandle
								position="start"
								onMouseDown={createMouseDownDrag(
									i,
									() => {
										const bounds = neighborBounds(i());
										const start = segment.start;
										const minValue = bounds.prevEnd;
										const maxValue = Math.max(
											minValue,
											Math.min(
												segment.end - minDuration(),
												bounds.nextStart - minDuration(),
											),
										);
										return { start, minValue, maxValue };
									},
									(e, value, initialMouseX) => {
										const delta = (e.clientX - initialMouseX) * secsPerPixel();
										const next = Math.max(
											value.minValue,
											Math.min(value.maxValue, value.start + delta),
										);
										setProject(
											"timeline",
											"captionSegments",
											i(),
											"start",
											next,
										);
									},
								)}
							/>
							<SegmentContent
								class="flex justify-center items-center cursor-grab px-2 overflow-hidden"
								onMouseDown={createMouseDownDrag(
									i,
									() => {
										const original = { ...segment };
										const bounds = neighborBounds(i());
										const minDelta = bounds.prevEnd - original.start;
										const maxDelta = bounds.nextStart - original.end;
										return { original, minDelta, maxDelta };
									},
									(e, value, initialMouseX) => {
										const delta = (e.clientX - initialMouseX) * secsPerPixel();
										const lowerBound = Math.min(
											value.minDelta,
											value.maxDelta,
										);
										const upperBound = Math.max(
											value.minDelta,
											value.maxDelta,
										);
										const clampedDelta = Math.min(
											upperBound,
											Math.max(lowerBound, delta),
										);
										setProject("timeline", "captionSegments", i(), {
											...value.original,
											start: value.original.start + clampedDelta,
											end: value.original.end + clampedDelta,
										});
									},
								)}
							>
								<div class="flex flex-col gap-0.5 justify-center items-center text-xs text-gray-1 dark:text-gray-12 w-full min-w-0 overflow-hidden">
									<div class="flex gap-1 items-center text-[10px] w-full min-w-0 justify-center">
										<span class="truncate max-w-full opacity-80">
											{segment.text || "Caption"}
										</span>
									</div>
								</div>
							</SegmentContent>
							<SegmentHandle
								position="end"
								onMouseDown={createMouseDownDrag(
									i,
									() => {
										const bounds = neighborBounds(i());
										const end = segment.end;
										const minValue = segment.start + minDuration();
										const maxValue = Math.max(minValue, bounds.nextStart);
										return { end, minValue, maxValue };
									},
									(e, value, initialMouseX) => {
										const delta = (e.clientX - initialMouseX) * secsPerPixel();
										const next = Math.max(
											value.minValue,
											Math.min(value.maxValue, value.end + delta),
										);
										setProject(
											"timeline",
											"captionSegments",
											i(),
											"end",
											next,
										);
									},
								)}
							/>
						</SegmentRoot>
					);
				}}
			</For>
		</TrackRoot>
	);
}
