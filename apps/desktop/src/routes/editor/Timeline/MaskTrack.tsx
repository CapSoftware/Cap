import { createEventListenerMap } from "@solid-primitives/event-listener";
import { cx } from "cva";
import { createMemo, createRoot, For } from "solid-js";
import { produce } from "solid-js/store";

import { useEditorContext } from "../context";
import { defaultMaskSegment } from "../masks";
import { useTimelineContext } from "./context";
import { SegmentContent, SegmentHandle, SegmentRoot, TrackRoot } from "./Track";

export type MaskSegmentDragState =
	| { type: "idle" }
	| { type: "movePending" }
	| { type: "moving" };

const MIN_SEGMENT_SECS = 1;
const MIN_SEGMENT_PIXELS = 80;

export function MaskTrack(props: {
	onDragStateChanged: (v: MaskSegmentDragState) => void;
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

	const maskSegments = () => project.timeline?.maskSegments ?? [];

	const neighborBounds = (index: number) => {
		const segments = maskSegments();
		return {
			prevEnd: segments[index - 1]?.end ?? 0,
			nextStart: segments[index + 1]?.start ?? totalDuration(),
		};
	};

	const findPlacement = (time: number, length: number) => {
		const gaps: Array<{ start: number; end: number }> = [];
		const sorted = maskSegments()
			.slice()
			.sort((a, b) => a.start - b.start);

		let cursor = 0;
		for (const segment of sorted) {
			if (segment.start - cursor >= length) {
				gaps.push({ start: cursor, end: segment.start });
			}
			cursor = Math.max(cursor, segment.end);
		}

		if (totalDuration() - cursor >= length) {
			gaps.push({ start: cursor, end: totalDuration() });
		}

		if (gaps.length === 0) return null;

		const maxStart = Math.max(totalDuration() - length, 0);
		const desiredStart = Math.min(Math.max(time - length / 2, 0), maxStart);

		const containingGap =
			gaps.find(
				(gap) => desiredStart >= gap.start && desiredStart + length <= gap.end,
			) ??
			gaps.find((gap) => gap.start >= desiredStart) ??
			gaps[gaps.length - 1];

		const start = Math.min(
			Math.max(desiredStart, containingGap.start),
			containingGap.end - length,
		);

		return { start, end: start + length };
	};

	const addSegmentAt = (time: number) => {
		const length = Math.min(minDuration(), totalDuration());
		if (length <= 0) return;

		const placement = findPlacement(time, length);
		if (!placement) return;

		setProject(
			"timeline",
			"maskSegments",
			produce((segments) => {
				segments ??= [];
				segments.push(defaultMaskSegment(placement.start, placement.end));
				segments.sort((a, b) => a.start - b.start);
			}),
		);
	};

	const handleBackgroundMouseDown = (e: MouseEvent) => {
		if (e.button !== 0) return;
		if ((e.target as HTMLElement).closest("[data-mask-segment]")) return;
		const timelineTime =
			editorState.previewTime ??
			editorState.playbackTime ??
			secsPerPixel() * (e.clientX - (timelineBounds.left ?? 0));
		addSegmentAt(timelineTime);
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
					const currentSelection = editorState.timeline.selection;
					const index = segmentIndex();
					const isMultiSelect = e.ctrlKey || e.metaKey;
					const isRangeSelect = e.shiftKey;

					if (isRangeSelect && currentSelection?.type === "mask") {
						const existingIndices = currentSelection.indices;
						const lastIndex = existingIndices[existingIndices.length - 1];
						const start = Math.min(lastIndex, index);
						const end = Math.max(lastIndex, index);
						const rangeIndices: number[] = [];
						for (let idx = start; idx <= end; idx++) rangeIndices.push(idx);
						setEditorState("timeline", "selection", {
							type: "mask",
							indices: rangeIndices,
						});
					} else if (isMultiSelect) {
						if (currentSelection?.type === "mask") {
							const base = currentSelection.indices;
							const exists = base.includes(index);
							const next = exists
								? base.filter((i) => i !== index)
								: [...base, index];
							setEditorState(
								"timeline",
								"selection",
								next.length > 0
									? {
											type: "mask",
											indices: next,
										}
									: null,
							);
						} else {
							setEditorState("timeline", "selection", {
								type: "mask",
								indices: [index],
							});
						}
					} else {
						setEditorState("timeline", "selection", {
							type: "mask",
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
			onMouseEnter={() => setEditorState("timeline", "hoveredTrack", "mask")}
			onMouseLeave={() => setEditorState("timeline", "hoveredTrack", null)}
			onMouseDown={handleBackgroundMouseDown}
		>
			<For
				each={maskSegments()}
				fallback={
					<div class="text-center text-sm text-[--text-tertiary] flex flex-col justify-center items-center inset-0 w-full bg-gray-3/20 dark:bg-gray-3/10 hover:bg-gray-3/30 dark:hover:bg-gray-3/20 transition-colors rounded-xl pointer-events-none">
						<div>Click to add a mask</div>
						<div class="text-[10px] text-[--text-tertiary]/40 mt-0.5">
							(Combine sensitive blur or highlight masks)
						</div>
					</div>
				}
			>
				{(segment, i) => {
					const isSelected = createMemo(() => {
						const selection = editorState.timeline.selection;
						if (!selection || selection.type !== "mask") return false;
						return selection.indices.includes(i());
					});

					const contentLabel = () =>
						segment.maskType === "sensitive" ? "Sensitive" : "Highlight";

					const segmentWidth = () => segment.end - segment.start;

					return (
						<SegmentRoot
							data-mask-segment
							data-index={i()}
							class={cx(
								"border duration-200 hover:border-gray-12 transition-colors group",
								"bg-gradient-to-r from-[#1f2022] via-[#2c2d30] to-[#1f2022]",
								isSelected() ? "border-gray-12" : "border-transparent",
							)}
							innerClass="ring-red-5"
							segment={segment}
							onMouseDown={(e) => {
								e.stopPropagation();
								if (editorState.timeline.interactMode === "split") {
									const rect = e.currentTarget.getBoundingClientRect();
									const fraction = (e.clientX - rect.left) / rect.width;
									const splitTime = fraction * segmentWidth();
									projectActions.splitMaskSegment(i(), splitTime);
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
										setProject("timeline", "maskSegments", i(), "start", next);
										setProject(
											"timeline",
											"maskSegments",
											produce((items) => {
												items.sort((a, b) => a.start - b.start);
											}),
										);
									},
								)}
							/>
							<SegmentContent
								class="flex justify-center items-center cursor-grab px-3"
								onMouseDown={createMouseDownDrag(
									i,
									() => {
										const original = { ...segment };
										const bounds = neighborBounds(i());
										const minDelta = bounds.prevEnd - original.start;
										const maxDelta = bounds.nextStart - original.end;
										return {
											original,
											minDelta,
											maxDelta,
										};
									},
									(e, value, initialMouseX) => {
										const delta = (e.clientX - initialMouseX) * secsPerPixel();
										const lowerBound = Math.min(value.minDelta, value.maxDelta);
										const upperBound = Math.max(value.minDelta, value.maxDelta);
										const clampedDelta = Math.min(
											upperBound,
											Math.max(lowerBound, delta),
										);
										setProject("timeline", "maskSegments", i(), {
											...value.original,
											start: value.original.start + clampedDelta,
											end: value.original.end + clampedDelta,
										});
										setProject(
											"timeline",
											"maskSegments",
											produce((items) => {
												items.sort((a, b) => a.start - b.start);
											}),
										);
									},
								)}
							>
								{(() => {
									return (
										<div class="flex flex-col gap-0.5 justify-center items-center text-xs whitespace-nowrap text-white">
											<span class="opacity-70">Mask</span>
											<div class="flex gap-1 items-center text-md">
												<span>{contentLabel()}</span>
											</div>
										</div>
									);
								})()}
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
										setProject("timeline", "maskSegments", i(), "end", next);
										setProject(
											"timeline",
											"maskSegments",
											produce((items) => {
												items.sort((a, b) => a.start - b.start);
											}),
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
