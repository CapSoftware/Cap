import {
	createEventListener,
	createEventListenerMap,
} from "@solid-primitives/event-listener";
import { Menu } from "@tauri-apps/api/menu";
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
import IconLucideMonitor from "~icons/lucide/monitor";
import IconLucideVideo from "~icons/lucide/video";
import IconLucideEyeOff from "~icons/lucide/eye-off";

export type LayoutSegmentDragState =
	| { type: "idle" }
	| { type: "movePending" }
	| { type: "moving" };

export function LayoutTrack(props: {
	onDragStateChanged: (v: LayoutSegmentDragState) => void;
	handleUpdatePlayhead: (e: MouseEvent) => void;
}) {
	const { project, setProject, projectHistory, setEditorState, editorState } =
		useEditorContext();

	const { duration, secsPerPixel } = useTimelineContext();

	const [hoveringSegment, setHoveringSegment] = createSignal(false);
	const [hoveredTime, setHoveredTime] = createSignal<number>();

	// When we delete a segment that's being hovered, the onMouseLeave never fires
	// because the element gets removed from the DOM. This leaves hoveringSegment stuck
	// as true, which blocks the onMouseMove from setting hoveredTime, preventing
	// users from creating new segments. This effect ensures we reset the hover state
	// when all segments are deleted.
	createEffect(() => {
		const segments = project.timeline?.layoutSegments;
		if (!segments || segments.length === 0) {
			setHoveringSegment(false);
		}
	});

	const getLayoutIcon = (mode: string) => {
		switch (mode) {
			case "cameraOnly":
				return <IconLucideVideo class="size-3.5" />;
			case "hideCamera":
				return <IconLucideEyeOff class="size-3.5" />;
			default:
				return <IconLucideMonitor class="size-3.5" />;
		}
	};

	const getLayoutLabel = (mode: string) => {
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
			onMouseMove={(e) => {
				if (hoveringSegment()) {
					setHoveredTime(undefined);
					return;
				}

				const bounds = e.target.getBoundingClientRect()!;

				let time =
					(e.clientX - bounds.left) * secsPerPixel() +
					editorState.timeline.transform.position;

				const nextSegmentIndex = project.timeline?.layoutSegments?.findIndex(
					(s) => time < s.start,
				);

				if (nextSegmentIndex !== undefined) {
					const prevSegmentIndex = nextSegmentIndex - 1;

					if (prevSegmentIndex === undefined) return;

					const nextSegment =
						project.timeline?.layoutSegments?.[nextSegmentIndex];

					if (prevSegmentIndex !== undefined && nextSegment) {
						const prevSegment =
							project.timeline?.layoutSegments?.[prevSegmentIndex];

						if (prevSegment) {
							const availableTime = nextSegment?.start - prevSegment?.end;

							if (availableTime < 1) return;
						}
					}

					if (nextSegment && nextSegment.start - time < 1) {
						time = nextSegment.start - 1;
					}
				}

				setHoveredTime(Math.min(time, duration() - 1));
			}}
			onMouseLeave={() => setHoveredTime()}
			onMouseDown={(e) => {
				createRoot((dispose) => {
					createEventListener(e.currentTarget, "mouseup", (e) => {
						dispose();

						const time = hoveredTime();
						if (time === undefined) return;

						e.stopPropagation();
						batch(() => {
							setProject("timeline", "layoutSegments", (v) => v ?? []);
							setProject(
								"timeline",
								"layoutSegments",
								produce((layoutSegments) => {
									layoutSegments ??= [];

									let index = layoutSegments.length;

									for (let i = layoutSegments.length - 1; i >= 0; i--) {
										if (layoutSegments[i].start > time) {
											index = i;
											break;
										}
									}

									layoutSegments.splice(index, 0, {
										start: time,
										end: time + 3,
										mode: "default",
									});
								}),
							);
						});
					});
				});
			}}
		>
			<For
				each={project.timeline?.layoutSegments}
				fallback={
					<div class="text-center text-sm text-[--text-tertiary] flex flex-col justify-center items-center inset-0 w-full bg-gray-3/20 dark:bg-gray-3/10 hover:opacity-50 transition-opacity rounded-xl pointer-events-none">
						Click to add layout segment
					</div>
				}
			>
				{(segment, i) => {
					const { setTrackState } = useTrackContext();

					const layoutSegments = () => project.timeline!.layoutSegments!;

					function createMouseDownDrag<T>(
						setup: () => T,
						_update: (e: MouseEvent, v: T, initialMouseX: number) => void,
					) {
						return (downEvent: MouseEvent) => {
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
										type: "layout",
										index: i(),
									});
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
						if (!selection || selection.type !== "layout") return false;

						const segmentIndex = project.timeline?.layoutSegments?.findIndex(
							(s) => s.start === segment.start && s.end === segment.end,
						);

						return segmentIndex === selection.index;
					});

					const segmentColor = () => {
						switch (segment.mode) {
							case "cameraOnly":
								return "from-[#3B82F6] via-[#60A5FA] to-[#3B82F6]";
							case "hideCamera":
								return "from-[#EF4444] via-[#F87171] to-[#EF4444]";
							default:
								return "from-[#10B981] via-[#34D399] to-[#10B981]";
						}
					};

					return (
						<SegmentRoot
							class={cx(
								"border duration-200 hover:border-gray-12 transition-colors group",
								`bg-gradient-to-r ${segmentColor()} shadow-[inset_0_8px_12px_3px_rgba(255,255,255,0.2)]`,
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
						>
							<SegmentHandle
								position="start"
								onMouseDown={createMouseDownDrag(
									() => {
										const start = segment.start;

										let minValue = 0;

										const maxValue = segment.end - 1;

										for (let i = layoutSegments().length - 1; i >= 0; i--) {
											const segment = layoutSegments()[i]!;
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
											"layoutSegments",
											i(),
											"start",
											Math.min(
												value.maxValue,
												Math.max(value.minValue, newStart),
											),
										);

										setProject(
											"timeline",
											"layoutSegments",
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
										const original = { ...segment };

										const prevSegment = layoutSegments()[i() - 1];
										const nextSegment = layoutSegments()[i() + 1];

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

										setProject("timeline", "layoutSegments", i(), {
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
												<span class="opacity-70">Layout</span>
												<div class="flex gap-1 items-center text-md">
													{getLayoutIcon(segment.mode)}
													{ctx.width() > 120 && (
														<span class="text-xs">
															{getLayoutLabel(segment.mode)}
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

										for (let i = 0; i < layoutSegments().length; i++) {
											const segment = layoutSegments()[i]!;
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
											"layoutSegments",
											i(),
											"end",
											Math.min(
												value.maxValue,
												Math.max(value.minValue, newEnd),
											),
										);

										setProject(
											"timeline",
											"layoutSegments",
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
							end: time() + 3,
						}}
					>
						<SegmentContent class="bg-gradient-to-r hover:border duration-200 hover:border-gray-500 from-[#10B981] via-[#34D399] to-[#10B981] transition-colors group shadow-[inset_0_8px_12px_3px_rgba(255,255,255,0.2)]">
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