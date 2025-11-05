import {
	createEventListener,
	createEventListenerMap,
} from "@solid-primitives/event-listener";
import { cx } from "cva";
import {
	type ComponentProps,
	createEffect,
	createMemo,
	createRoot,
	createSignal,
	For,
	Match,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { produce } from "solid-js/store";

import type { TimelineSegment } from "~/utils/tauri";
import { useEditorContext } from "../context";
import { useSegmentContext, useTimelineContext } from "./context";
import { getSectionMarker } from "./sectionMarker";
import {
	SegmentContent,
	SegmentHandle,
	SegmentRoot,
	TrackRoot,
	useSegmentTranslateX,
	useSegmentWidth,
} from "./Track";

function formatTime(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = Math.floor(totalSeconds % 60);

	if (hours > 0) {
		return `${hours}h ${minutes}m ${seconds}s`;
	} else if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	} else {
		return `${seconds}s`;
	}
}

function WaveformCanvas(props: {
	systemWaveform?: number[];
	micWaveform?: number[];
	segment: { start: number; end: number };
	secsPerPixel: number;
}) {
	const { project } = useEditorContext();

	let canvas: HTMLCanvasElement | undefined;
	const { width } = useSegmentContext();
	const { secsPerPixel } = useTimelineContext();

	const render = (
		ctx: CanvasRenderingContext2D,
		h: number,
		waveform: number[],
		color: string,
		gain = 0,
	) => {
		const maxAmplitude = h;

		// yellow please
		ctx.fillStyle = color;
		ctx.beginPath();

		const step = 0.05 / secsPerPixel();

		ctx.moveTo(0, h);

		const norm = (w: number) => {
			const ww = Number.isFinite(w) ? w : -60;
			return 1.0 - Math.max(ww + gain, -60) / -60;
		};

		for (
			let segmentTime = props.segment.start;
			segmentTime <= props.segment.end + 0.1;
			segmentTime += 0.1
		) {
			const index = Math.floor(segmentTime * 10);
			const xTime = index / 10;

			const currentDb =
				typeof waveform[index] === "number" ? waveform[index] : -60;
			const amplitude = norm(currentDb) * maxAmplitude;

			const x = (xTime - props.segment.start) / secsPerPixel();
			const y = h - amplitude;

			const prevX = (xTime - 0.1 - props.segment.start) / secsPerPixel();
			const prevDb =
				typeof waveform[index - 1] === "number" ? waveform[index - 1] : -60;
			const prevAmplitude = norm(prevDb) * maxAmplitude;
			const prevY = h - prevAmplitude;

			const cpX1 = prevX + step / 2;
			const cpX2 = x - step / 2;

			ctx.bezierCurveTo(cpX1, prevY, cpX2, y, x, y);
		}

		ctx.lineTo(
			(props.segment.end + 0.3 - props.segment.start) / secsPerPixel(),
			h,
		);

		ctx.closePath();
		ctx.fill();
	};

	function renderWaveforms() {
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const w = width();
		if (w <= 0) return;

		const h = canvas.height;
		canvas.width = w;
		ctx.clearRect(0, 0, w, h);

		if (props.micWaveform)
			render(
				ctx,
				h,
				props.micWaveform,
				"rgba(255,255,255,0.4)",
				project.audio.micVolumeDb,
			);

		if (props.systemWaveform)
			render(
				ctx,
				h,
				props.systemWaveform,
				"rgba(255,150,0,0.5)",
				project.audio.systemVolumeDb,
			);
	}

	createEffect(() => {
		renderWaveforms();
	});

	return (
		<canvas
			ref={(el) => {
				canvas = el;
				renderWaveforms();
			}}
			class="absolute inset-0 w-full h-full pointer-events-none"
			height={52}
		/>
	);
}

export function ClipTrack(
	props: Pick<ComponentProps<"div">, "ref"> & {
		handleUpdatePlayhead: (e: MouseEvent) => void;
	},
) {
	const {
		project,
		setProject,
		projectActions,
		editorInstance,
		projectHistory,
		editorState,
		setEditorState,
		totalDuration,
		micWaveforms,
		systemAudioWaveforms,
	} = useEditorContext();

	const { secsPerPixel, duration } = useTimelineContext();

	const segments = (): Array<TimelineSegment> =>
		project.timeline?.segments ?? [{ start: 0, end: duration(), timescale: 1 }];

	function onHandleReleased() {
		const { transform } = editorState.timeline;

		if (transform.position + transform.zoom > totalDuration() + 4) {
			transform.updateZoom(totalDuration(), editorState.previewTime!);
		}
	}

	const hasMultipleRecordingSegments = () =>
		editorInstance.recordings.segments.length > 1;

	const split = () => editorState.timeline.interactMode === "split";

	return (
		<TrackRoot
			ref={props.ref}
			onMouseEnter={() => setEditorState("timeline", "hoveredTrack", "clip")}
			onMouseLeave={() => setEditorState("timeline", "hoveredTrack", null)}
		>
			<For each={segments()}>
				{(segment, i) => {
					const [startHandleDrag, setStartHandleDrag] = createSignal<null | {
						offset: number;
						initialStart: number;
					}>(null);

					const prefixOffsets = createMemo(() => {
						const segs = segments();
						const out: number[] = new Array(segs.length);
						let sum = 0;
						for (let k = 0; k < segs.length; k++) {
							out[k] = sum;
							sum += (segs[k].end - segs[k].start) / segs[k].timescale;
						}
						return out;
					});
					const prevDuration = createMemo(() => prefixOffsets()[i()] ?? 0);

					const relativeSegment = createMemo(() => {
						const ds = startHandleDrag();
						const offset = ds?.offset ?? 0;

						return {
							start: Math.max(prevDuration() + offset, 0),
							end:
								prevDuration() +
								(offset + (segment.end - segment.start)) / segment.timescale,
							timescale: segment.timescale,
							recordingSegment: segment.recordingSegment,
						};
					});

					const segmentX = useSegmentTranslateX(relativeSegment);
					const segmentWidth = useSegmentWidth(relativeSegment);

					const segmentRecording = (s = i()) =>
						editorInstance.recordings.segments[
							segments()[s].recordingSegment ?? 0
						];

					const marker = useSectionMarker(() => ({
						segments: segments(),
						i: i(),
						position: "left",
					}));

					const endMarker = useSectionMarker(() => ({
						segments: segments(),
						i: i(),
						position: "right",
					}));

					const isSelected = createMemo(() => {
						const selection = editorState.timeline.selection;
						if (!selection || selection.type !== "clip") return false;

						const segmentIndex = project.timeline?.segments?.findIndex(
							(s) => s.start === segment.start && s.end === segment.end,
						);

						if (segmentIndex === undefined || segmentIndex === -1) return false;

						return selection.indices.includes(segmentIndex);
					});

					const micWaveform = () => {
						if (project.audio.micVolumeDb && project.audio.micVolumeDb < -30)
							return;

						const idx = segment.recordingSegment ?? i();
						return micWaveforms()?.[idx] ?? [];
					};

					const systemAudioWaveform = () => {
						if (
							project.audio.systemVolumeDb &&
							project.audio.systemVolumeDb <= -30
						)
							return;

						const idx = segment.recordingSegment ?? i();
						return systemAudioWaveforms()?.[idx] ?? [];
					};

					return (
						<>
							<Show when={marker()}>
								{(marker) => (
									<div
										class="absolute w-0 z-10 h-full *:absolute"
										style={{
											transform: `translateX(${segmentX()}px)`,
										}}
									>
										<div class="w-[2px] bottom-0 -top-2 rounded-full from-red-300 to-transparent bg-gradient-to-b -translate-x-1/2" />
										<Switch>
											<Match
												when={(() => {
													const m = marker();
													if (m.type === "single") return m.value;
												})()}
											>
												{(markerValue) => {
													const value = createMemo(() => {
														const m = markerValue();
														return m.type === "time" ? m.time : 0;
													});

													return (
														<div class="overflow-hidden -top-8 z-10 h-7 rounded-full -translate-x-1/2">
															<CutOffsetButton
																value={value()}
																onClick={() => {
																	setProject(
																		"timeline",
																		"segments",
																		produce((s) => {
																			if (markerValue().type === "reset") {
																				s[i() - 1].end = s[i()].end;
																				s.splice(i(), 1);
																			} else {
																				s[i() - 1].end = s[i()].start;
																			}
																		}),
																	);
																}}
															/>
														</div>
													);
												}}
											</Match>
											<Match
												when={(() => {
													const m = marker();
													if (
														m.type === "dual" &&
														m.right &&
														m.right.type === "time"
													)
														return m.right;
												})()}
											>
												{(markerValue) => {
													const value = createMemo(() => {
														const m = markerValue();
														return m.type === "time" ? m.time : 0;
													});

													return (
														<div class="flex absolute -top-8 flex-row w-0 h-7 rounded-full">
															<CutOffsetButton
																value={value()}
																class="-left-px absolute rounded-r-full !pl-1.5 rounded-tl-full"
																onClick={() => {
																	setProject(
																		"timeline",
																		"segments",
																		i(),
																		"start",
																		0,
																	);
																}}
															/>
														</div>
													);
												}}
											</Match>
										</Switch>
									</div>
								)}
							</Show>
							<SegmentRoot
								class={cx(
									"border transition-colors duration-200 group hover:border-gray-12",
									"bg-gradient-to-r from-[#2675DB] via-[#4FA0FF] to-[#2675DB] shadow-[inset_0_5px_10px_5px_rgba(255,255,255,0.2)]",
									isSelected()
										? "wobble-wrapper border-gray-12"
										: "border-transparent",
								)}
								innerClass="ring-blue-9"
								segment={relativeSegment()}
								onMouseDown={(e) => {
									e.stopPropagation();

									if (editorState.timeline.interactMode === "split") {
										const rect = e.currentTarget.getBoundingClientRect();
										const fraction = (e.clientX - rect.left) / rect.width;

										const splitTime = fraction * (segment.end - segment.start);

										projectActions.splitClipSegment(prevDuration() + splitTime);
									} else {
										createRoot((dispose) => {
											createEventListener(
												e.currentTarget,
												"mouseup",
												(upEvent) => {
													dispose();

													const currentIndex = i();
													const selection = editorState.timeline.selection;
													const isMac =
														navigator.platform.toUpperCase().indexOf("MAC") >=
														0;
													const isMultiSelect = isMac
														? upEvent.metaKey
														: upEvent.ctrlKey;
													const isRangeSelect = upEvent.shiftKey;

													if (
														isRangeSelect &&
														selection &&
														selection.type === "clip"
													) {
														// Range selection: select from last selected to current
														const existingIndices = selection.indices;
														const lastIndex =
															existingIndices[existingIndices.length - 1];
														const start = Math.min(lastIndex, currentIndex);
														const end = Math.max(lastIndex, currentIndex);
														const rangeIndices = Array.from(
															{ length: end - start + 1 },
															(_, idx) => start + idx,
														);

														setEditorState("timeline", "selection", {
															type: "clip" as const,
															indices: rangeIndices,
														});
													} else if (
														isMultiSelect &&
														selection &&
														selection.type === "clip"
													) {
														// Multi-select: toggle current index
														const existingIndices = selection.indices;

														if (existingIndices.includes(currentIndex)) {
															// Remove from selection
															const newIndices = existingIndices.filter(
																(idx) => idx !== currentIndex,
															);
															if (newIndices.length > 0) {
																setEditorState("timeline", "selection", {
																	type: "clip" as const,
																	indices: newIndices,
																});
															} else {
																setEditorState("timeline", "selection", null);
															}
														} else {
															// Add to selection
															setEditorState("timeline", "selection", {
																type: "clip" as const,
																indices: [...existingIndices, currentIndex],
															});
														}
													} else {
														// Normal single selection
														setEditorState("timeline", "selection", {
															type: "clip" as const,
															indices: [currentIndex],
														});
													}

													props.handleUpdatePlayhead(upEvent);
												},
											);
										});
									}
								}}
							>
								{segment.timescale === 1 && (
									<WaveformCanvas
										micWaveform={micWaveform()}
										systemWaveform={systemAudioWaveform()}
										segment={segment}
										secsPerPixel={secsPerPixel()}
									/>
								)}

								<Markings segment={segment} prevDuration={prevDuration()} />

								<SegmentHandle
									position="start"
									class="opacity-0 group-hover:opacity-100"
									onMouseDown={(downEvent) => {
										if (split()) return;

										const initialStart = segment.start;
										setStartHandleDrag({
											offset: 0,
											initialStart,
										});

										const maxSegmentDuration =
											editorInstance.recordings.segments[
												segment.recordingSegment ?? 0
											].display.duration;

										const availableTimelineDuration =
											editorInstance.recordingDuration -
											segments().reduce(
												(acc, segment, segmentI) =>
													segmentI === i()
														? acc
														: acc +
															(segment.end - segment.start) / segment.timescale,
												0,
											);

										const maxDuration = Math.min(
											maxSegmentDuration,
											availableTimelineDuration,
										);

										const prevSegment = segments()[i() - 1];
										const prevSegmentIsSameClip =
											prevSegment?.recordingSegment !== undefined
												? prevSegment.recordingSegment ===
													segment.recordingSegment
												: false;

										function update(event: MouseEvent) {
											const newStart =
												initialStart +
												(event.clientX - downEvent.clientX) *
													secsPerPixel() *
													segment.timescale;

											const clampedStart = Math.min(
												Math.max(
													newStart,
													prevSegmentIsSameClip ? prevSegment.end : 0,
													segment.end - maxDuration,
												),
												segment.end - 1,
											);

											setStartHandleDrag({
												offset: clampedStart - initialStart,
												initialStart,
											});

											setProject(
												"timeline",
												"segments",
												i(),
												"start",
												clampedStart,
											);
										}

										const resumeHistory = projectHistory.pause();
										createRoot((dispose) => {
											onCleanup(() => {
												resumeHistory();
												console.log("NUL");
												setStartHandleDrag(null);
												onHandleReleased();
											});

											createEventListenerMap(window, {
												mousemove: update,
												mouseup: (e) => {
													update(e);
													dispose();
												},
												blur: () => dispose(),
												mouseleave: () => dispose(),
											});
										});
									}}
								/>
								<SegmentContent class="relative justify-center items-center">
									{(() => {
										const ctx = useSegmentContext();

										return (
											<Show when={ctx.width() > 100}>
												<div class="flex flex-col gap-1 justify-center items-center text-xs whitespace-nowrap text-gray-12">
													<span class="text-white/70">
														{hasMultipleRecordingSegments()
															? `Clip ${segment.recordingSegment}`
															: "Clip"}
													</span>
													<div class="flex gap-1 items-center text-md dark:text-gray-12 text-gray-1">
														<IconLucideClock class="size-3.5" />{" "}
														{formatTime(segment.end - segment.start)}
														<Show when={segment.timescale !== 1}>
															<div class="w-0.5" />
															<IconLucideFastForward class="size-3" />
															{segment.timescale}x
														</Show>
													</div>
												</div>
											</Show>
										);
									})()}
								</SegmentContent>
								<SegmentHandle
									position="end"
									class="opacity-0 group-hover:opacity-100"
									onMouseDown={(downEvent) => {
										const end = segment.end;

										if (split()) return;
										const maxSegmentDuration =
											editorInstance.recordings.segments[
												segment.recordingSegment ?? 0
											].display.duration;

										const availableTimelineDuration =
											editorInstance.recordingDuration -
											segments().reduce(
												(acc, segment, segmentI) =>
													segmentI === i()
														? acc
														: acc +
															(segment.end - segment.start) / segment.timescale,
												0,
											);

										const nextSegment = segments()[i() + 1];
										const nextSegmentIsSameClip =
											nextSegment?.recordingSegment !== undefined
												? nextSegment.recordingSegment ===
													segment.recordingSegment
												: false;

										function update(event: MouseEvent) {
											const deltaRecorded =
												(event.clientX - downEvent.clientX) *
												secsPerPixel() *
												segment.timescale;
											const newEnd = end + deltaRecorded;

											setProject(
												"timeline",
												"segments",
												i(),
												"end",
												Math.max(
													Math.min(
														newEnd,
														// availableTimelineDuration is in timeline seconds; convert to recorded seconds
														end + availableTimelineDuration * segment.timescale,
														nextSegmentIsSameClip
															? nextSegment.start
															: maxSegmentDuration,
													),
													segment.start + 1,
												),
											);
										}

										const resumeHistory = projectHistory.pause();
										createRoot((dispose) => {
											createEventListenerMap(window, {
												mousemove: update,
												mouseup: (e) => {
													dispose();
													resumeHistory();
													update(e);
													onHandleReleased();
												},
												blur: () => {
													dispose();
													resumeHistory();
													onHandleReleased();
												},
												mouseleave: () => {
													dispose();
													resumeHistory();
													onHandleReleased();
												},
											});
										});
									}}
								/>
							</SegmentRoot>
							<Show
								when={(() => {
									const m = endMarker();
									if (m?.type === "dual" && m.left && m.left.type === "time")
										return m.left;
								})()}
							>
								{(markerValue) => {
									const value = createMemo(() => {
										const m = markerValue();
										return m.type === "time" ? m.time : 0;
									});

									return (
										<div
											class="absolute w-0 z-10 h-full *:absolute"
											style={{
												transform: `translateX(${segmentX() + segmentWidth()}px)`,
											}}
										>
											<div class="w-[2px] bottom-0 -top-2 rounded-full from-red-300 to-transparent bg-gradient-to-b -translate-x-1/2" />
											<div class="flex absolute -top-8 flex-row w-0 h-7 rounded-full">
												<CutOffsetButton
													value={value()}
													class="-right-px absolute rounded-l-full !pr-1.5 rounded-tr-full"
													onClick={() => {
														setProject(
															"timeline",
															"segments",
															i(),
															"end",
															segmentRecording().display.duration,
														);
													}}
												/>
											</div>
										</div>
									);
								}}
							</Show>
						</>
					);
				}}
			</For>
		</TrackRoot>
	);
}

function Markings(props: { segment: TimelineSegment; prevDuration: number }) {
	const { editorState } = useEditorContext();
	const { secsPerPixel, markingResolution } = useTimelineContext();

	const markings = () => {
		const resolution = markingResolution();

		const { transform } = editorState.timeline;
		const visibleMin =
			transform.position - props.prevDuration + props.segment.start;
		const visibleMax = visibleMin + transform.zoom;

		const start = Math.floor(visibleMin / resolution);

		return Array.from(
			{ length: Math.ceil(visibleMax / resolution) - start },
			(_, i) => (start + i) * resolution,
		);
	};

	return (
		<For each={markings()}>
			{(marking) => (
				<div
					style={{
						transform: `translateX(${
							(marking - props.segment.start) / secsPerPixel()
						}px)`,
					}}
					class="absolute z-10 w-px h-12 bg-gradient-to-b from-transparent to-transparent via-white-transparent-40 dark:via-black-transparent-60"
				/>
			)}
		</For>
	);
}

function CutOffsetButton(props: {
	value: number;
	class?: string;
	onClick?(): void;
}) {
	return (
		<button
			class={cx(
				"h-7 bg-red-300 text-nowrap hover:bg-red-400 text-xs tabular-nums text-white p-2 flex flex-row items-center transition-colors",
				props.class,
			)}
			onClick={() => props.onClick?.()}
		>
			<Show
				when={props.value !== 0}
				fallback={<IconCapScissors class="size-3.5" />}
			>
				{formatTime(props.value)}
			</Show>
		</button>
	);
}

function useSectionMarker(
	props: () => {
		segments: TimelineSegment[];
		i: number;
		position: "left" | "right";
	},
) {
	const { editorInstance } = useEditorContext();

	return () => getSectionMarker(props(), editorInstance.recordings.segments);
}
